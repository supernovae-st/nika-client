import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OwnedProcesses, runOwnedProcess } from './one-door/process.mjs';

// Corpus and packed application runners share process ownership and evidence commit
// ordering. Body assertions and graceful resident shutdown must finish first.
export async function supervisedGauntlet({ name, root, env = process.env,
  owned = new OwnedProcesses(), timeoutMs = 300_000, persistReport = true }, exercise) {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
  assert.equal(typeof persistReport, 'boolean');
  const resultsRoot = env.NIKA_GAUNTLET_RESULTS_DIR
    ? path.resolve(env.NIKA_GAUNTLET_RESULTS_DIR) : path.join(root, 'gauntlet', 'results');
  // Static corpus checks have no durable execution ledger. They still share
  // all deadlines, signal handling and close-before-green obligations.
  const resultsPath = persistReport ? path.join(resultsRoot, `${name}.json`) : undefined;
  if (resultsPath) mkdirSync(resultsRoot, { recursive: true });
  const writeReport = (report) => {
    if (resultsPath) writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  };
  writeReport({ schema_version: 1, result: 'incomplete', pid: process.pid });
  const controller = new AbortController();
  const stop = (reason) => {
    controller.abort(new Error(reason));
    void owned.close().catch(() => {});
  };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => stop(`${name} received ${signal}`)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const timer = setTimeout(() => stop(`${name} exceeded ${timeoutMs}ms`), timeoutMs);
  const handles = [];
  const start = (command, args, options) => {
    controller.signal.throwIfAborted();
    const handle = owned.start(command, args, { env, ...options });
    handles.push(handle);
    return handle;
  };
  const run = (command, args, options) => runOwnedProcess(start, command, args, options);
  let scratch;
  let report;
  const errors = [];
  try {
    assert(env.NIKA_BIN && path.isAbsolute(env.NIKA_BIN), 'NIKA_BIN must name an absolute engine binary under test');
    scratch = mkdtempSync(path.join(tmpdir(), `nika-${name}-`));
    report = await exercise({ scratch, nikaBin: env.NIKA_BIN, env, start, run, signal: controller.signal });
  } catch (error) { errors.push(error); }
  finally {
    let reaped = false;
    try { await owned.close(); reaped = true; } catch (error) { errors.push(error); }
    for (const handle of handles) {
      if (handle.child.signalCode !== null) errors.push(new Error(`owned process ${handle.child.pid} required ${handle.child.signalCode}`));
      try {
        const result = await handle.done;
        assert([0, 130].includes(result.code), `owned process ${handle.child.pid} exited ${result.code}`);
      } catch (error) { errors.push(error); }
    }
    if (controller.signal.aborted) errors.push(controller.signal.reason);
    // Keep the deadline/interrupt handler live until cleanup itself has ended.
    clearTimeout(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (scratch && reaped) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    } else if (scratch) process.stderr.write(`${name} cleanup retained scratch: ${scratch}\n`);
  }
  if (errors.length) {
    const failure = new AggregateError(errors, errors.map(String).join('\n'));
    writeReport({ ...report, schema_version: 1, result: 'red', error: String(failure) });
    throw failure;
  }
  const evidence = { ...report, schema_version: 1, result: 'green' };
  writeReport(evidence);
  process.stdout.write(`${name} green after owned cleanup${resultsPath ? ` · ${resultsPath}` : ''}\n`);
  return evidence;
}

export async function packSdk(root, scratch, run) {
  await run('npm', ['run', 'build'], { cwd: root, timeoutMs: 60_000 });
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
    { cwd: root, timeoutMs: 30_000 }));
  assert.equal(packed.length, 1);
  const filename = packed[0].filename;
  assert(typeof filename === 'string' && filename === path.basename(filename), 'npm pack must return one local filename');
  return { filename, tarball: path.join(scratch, filename) };
}

export async function installProject(source, project, tarball, run) {
  cpSync(source, project, { recursive: true });
  const manifestPath = path.join(project, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies = { '@supernovae-st/nika-client': `file:${tarball}` };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'],
    { cwd: project, timeoutMs: 60_000 });
}
