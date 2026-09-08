import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnedProcesses } from './one-door/process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expected = ['deployment-gate', 'evidence-provenance-pipeline', 'incident-response-controller',
  'multi-tenant-webhook-router', 'scheduled-research-monitor'];

export function assertAppIdentity(source, project) {
  const committed = readFileSync(path.join(source, 'app.mjs'));
  const executed = readFileSync(path.join(project, 'app.mjs'));
  assert(committed.equals(executed), 'executed app must be byte-identical to the committed project app');
  return { source_sha256: sha256(committed), executed_sha256: sha256(executed), byte_identical: true };
}

export function stageDepthProject(source, project, tarball) {
  cpSync(source, project, { recursive: true });
  const manifestPath = path.join(project, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = { '@supernovae-st/nika-client': `file:${tarball}` };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return assertAppIdentity(source, project);
}

export async function executeProjectApp(source, project, nikaBin, start) {
  const identity = assertAppIdentity(source, project);
  const app = path.join(project, 'app.mjs');
  const handle = start(process.execPath, [app], {
    cwd: project, env: { ...process.env, NIKA_BIN: nikaBin },
    timeoutMs: 100_000, maxBuffer: 1024 * 1024, graceMs: 12_000, killMs: 3_000,
  });
  const run = await handle.done;
  assert.equal(run.code, 0, `${path.basename(project)} failed (${run.code}, ${run.signal})\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.signal, null);
  assert.deepEqual(assertAppIdentity(source, project), identity, 'the app must not change during execution');
  return { result: JSON.parse(run.stdout.trim().split('\n').at(-1)), identity };
}

export async function runDepthProjects() {
  const projectsRoot = path.join(root, 'gauntlet', 'projects-depth');
  const resultsRoot = process.env.NIKA_GAUNTLET_RESULTS_DIR ? path.resolve(process.env.NIKA_GAUNTLET_RESULTS_DIR) : projectsRoot;
  const resultsPath = path.join(resultsRoot, process.env.NIKA_GAUNTLET_RESULTS_DIR ? 'depth-projects.json' : 'results.json');
  mkdirSync(resultsRoot, { recursive: true });
  // Invalidate a prior green before any probe/build: an interrupted invocation
  // is not evidence that the previous measured result still describes this run.
  writeFileSync(resultsPath, `${JSON.stringify({ schema_version: 1,
    summary: { result: 'incomplete' }, pid: process.pid })}\n`);
  const nikaBin = process.env.NIKA_BIN;
  const scratch = mkdtempSync(path.join(tmpdir(), 'nika-depth-projects-'));
  const owned = new OwnedProcesses();
  const handles = [];
  const start = (...args) => { const handle = owned.start(...args); handles.push(handle); return handle; };
  const run = async (command, args, options) => {
    const result = await start(command, args, { env: process.env, ...options }).done;
    assert.equal(result.code, 0, `${command} failed (${result.code}, ${result.signal})\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    return result.stdout;
  };
  let stopped;
  const stop = (reason) => { stopped ??= new Error(reason); void owned.close().catch(() => {}); };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => stop(`depth runner received ${signal}`)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const timer = setTimeout(() => stop('depth runner exceeded 300s'), 300_000);
  let report;
  let failure;
  try {
    assert(nikaBin && path.isAbsolute(nikaBin), 'NIKA_BIN must name an absolute engine binary under test');
    await run('npm', ['run', 'build'], { cwd: root, timeoutMs: 60_000 });
    const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
      { cwd: root, timeoutMs: 30_000 }));
    const tarball = path.join(scratch, packed[0].filename);
    // Preserve the repository-relative imports in the committed app. Only
    // shared harness helpers are copied; no SDK source or dist is staged.
    mkdirSync(path.join(scratch, 'scripts', 'one-door'), { recursive: true });
    cpSync(path.join(root, 'scripts', 'gauntlet-cancellation.mjs'), path.join(scratch, 'scripts', 'gauntlet-cancellation.mjs'));
    for (const helper of ['cancellation.mjs', 'contract.mjs', 'process.mjs']) {
      cpSync(path.join(root, 'scripts', 'one-door', helper), path.join(scratch, 'scripts', 'one-door', helper));
    }
    const names = readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.deepEqual(names, expected);
    const projects = [];
    for (const name of names) {
      const source = path.join(projectsRoot, name);
      const project = path.join(scratch, 'gauntlet', 'projects-depth', name);
      stageDepthProject(source, project, tarball);
      await run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'],
        { cwd: project, timeoutMs: 60_000 });
      const { result, identity } = await executeProjectApp(source, project, nikaBin, start);
      assert.equal(result.project, name);
      assert.equal(result.status, 'succeeded');
      if (name === 'incident-response-controller') {
        assert.equal(result.executed_app_sha256, identity.executed_sha256, 'the running incident app must attest the same bytes');
        if (process.env.NIKA_GAUNTLET_RESULTS_DIR) {
          const audit = path.join(resultsRoot, 'incident-fixtures');
          mkdirSync(audit, { recursive: true });
          const provenance = [];
          for (const [label, file] of [
            ['committed-app.mjs', path.join(source, 'app.mjs')],
            ['executed-app.mjs', path.join(project, 'app.mjs')],
            ['workflow.nika.yaml', path.join(project, 'workflow.nika.yaml')],
            ['controlled-cancel.nika.yaml', path.join(project, 'controlled-cancel.nika.yaml')],
          ]) {
            const bytes = readFileSync(file);
            writeFileSync(path.join(audit, label), bytes);
            provenance.push({ file: label, sha256: sha256(bytes) });
          }
          writeFileSync(path.join(audit, 'sha256.json'), `${JSON.stringify(provenance, null, 2)}\n`);
        }
      }
      projects.push({ ...result, installed_from_pack: true, app_identity: identity });
      process.stdout.write(`depth ${projects.length}/${expected.length} · ${name} · succeeded\n`);
    }
    report = { schema_version: 1,
      engine: (await run(nikaBin, ['--version'], { timeoutMs: 5_000 })).trim(),
      package: packed[0].filename, package_sha256: sha256(readFileSync(tarball)),
      install_mode: 'npm pack + isolated npm install --omit=optional + explicit NIKA_BIN',
      projects, summary: { total: projects.length, succeeded: projects.length, result: 'green' } };
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    const errors = [];
    try { await owned.close(); } catch (error) { errors.push(error); }
    for (const handle of handles) {
      if (handle.child.signalCode === 'SIGKILL') errors.push(new Error(`owned process ${handle.child.pid} required SIGKILL`));
    }
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (stopped) errors.push(stopped);
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'depth proof or cleanup failed');
    // Do not delete scratch if supervision cannot establish process exit.
    if (!errors.length) rmSync(scratch, { recursive: true, force: true });
  }
  if (failure) {
    writeFileSync(resultsPath, `${JSON.stringify({ ...report, schema_version: 1,
      summary: { ...report?.summary, result: 'red' }, error: String(failure) }, null, 2)}\n`);
    throw failure;
  }
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.projects.length}/${expected.length} packed depth projects green · ${resultsPath}\n`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await runDepthProjects();
