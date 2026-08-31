import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsRoot = path.join(root, 'gauntlet', 'projects-depth');
const resultsPath = path.join(projectsRoot, 'results.json');
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-depth-projects-'));
const nikaBin = process.env.NIKA_BIN;
assert(nikaBin, 'NIKA_BIN must name the engine binary under test');

const expected = [
  'deployment-gate',
  'evidence-provenance-pipeline',
  'incident-response-controller',
  'multi-tenant-webhook-router',
  'scheduled-research-monitor',
];

try {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' }));
  const tarball = path.join(scratch, packed[0].filename);
  const names = readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(names, expected);
  const projects = [];

  for (const name of names) {
    const source = path.join(projectsRoot, name);
    const project = path.join(scratch, name);
    cpSync(source, project, { recursive: true });
    const manifestPath = path.join(project, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { '@supernovae-st/nika-client': `file:${tarball}` };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'], { cwd: project, stdio: 'pipe' });
    const run = spawnSync(process.execPath, ['app.mjs'], {
      cwd: project,
      env: { ...process.env, NIKA_BIN: nikaBin },
      encoding: 'utf8',
      timeout: 45_000,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${name} failed (${run.status})\n${run.stdout}\n${run.stderr}`);
    const line = run.stdout.trim().split('\n').at(-1);
    const result = JSON.parse(line);
    assert.equal(result.project, name);
    assert.equal(result.status, 'succeeded');
    projects.push({ ...result, installed_from_pack: true });
    process.stdout.write(`depth ${projects.length}/${expected.length} · ${name} · succeeded\n`);
  }

  const report = {
    schema_version: 1,
    engine: execFileSync(nikaBin, ['--version'], { encoding: 'utf8' }).trim(),
    package: packed[0].filename,
    install_mode: 'npm pack + isolated npm install --omit=optional + explicit NIKA_BIN',
    projects,
    summary: { total: projects.length, succeeded: projects.length, result: 'green' },
  };
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${projects.length}/${expected.length} packed depth projects green · ${resultsPath}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
