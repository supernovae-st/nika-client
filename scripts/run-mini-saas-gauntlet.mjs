import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsRoot = path.join(root, 'gauntlet', 'projects');
const resultsPath = path.join(root, 'gauntlet', 'results', 'mini-saas.json');
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-mini-saas-'));
const nikaBin = process.env.NIKA_BIN;

if (!nikaBin) throw new Error('NIKA_BIN must name the engine binary under test');

try {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  const packed = JSON.parse(execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
    { cwd: root, encoding: 'utf8' },
  ));
  const tarball = path.join(scratch, packed[0].filename);
  const rows = [];

  for (const name of readdirSync(projectsRoot).sort()) {
    const source = path.join(projectsRoot, name);
    const project = path.join(scratch, name);
    cpSync(source, project, { recursive: true });
    const manifestPath = path.join(project, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { '@supernovae-st/nika-client': `file:${tarball}` };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'],
      { cwd: project, stdio: 'pipe' },
    );
    const run = spawnSync(process.execPath, ['app.mjs'], {
      cwd: project,
      env: { ...process.env, NIKA_BIN: nikaBin },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (run.status !== 0) {
      throw new Error(`${name} failed (${run.status})\n${run.stdout}\n${run.stderr}`);
    }
    const lines = run.stdout.trim().split('\n');
    const result = JSON.parse(lines.at(-1));
    if (result.project !== name || result.status !== 'succeeded') {
      throw new Error(`${name} returned an invalid settlement: ${lines.at(-1)}`);
    }
    rows.push({ name, ...result, installed_from_pack: true });
    process.stdout.write(`mini-saas ${rows.length}/5 · ${name} · ${result.status}\n`);
  }

  if (rows.length !== 5) throw new Error(`expected 5 mini-SaaS projects, received ${rows.length}`);
  const report = {
    schema_version: 1,
    engine: execFileSync(nikaBin, ['--version'], { encoding: 'utf8' }).trim(),
    package: packed[0].filename,
    install_mode: 'npm pack + npm install --omit=optional + explicit NIKA_BIN',
    projects: rows,
    result: 'green',
  };
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`5/5 packed mini-SaaS projects green · ${resultsPath}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
