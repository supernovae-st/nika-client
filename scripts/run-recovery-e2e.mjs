import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'gauntlet', 'recovery-e2e');
const resultsRoot = process.env.NIKA_GAUNTLET_RESULTS_DIR
  ? path.resolve(process.env.NIKA_GAUNTLET_RESULTS_DIR)
  : path.join(root, 'gauntlet', 'results');
const resultPath = path.join(resultsRoot, 'recovery-e2e.json');
const nikaBin = process.env.NIKA_BIN;
assert(nikaBin, 'NIKA_BIN must name the engine binary under test');
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-recovery-e2e-'));
let server;

try {
  mkdirSync(resultsRoot, { recursive: true });
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  const packed = JSON.parse(execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
    { cwd: root, encoding: 'utf8' },
  ));
  const tarball = path.join(scratch, packed[0].filename);
  const project = path.join(scratch, 'project');
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

  const token = 'recovery-e2e-token-0123456789abcdef0123456789';
  const tokenFile = path.join(scratch, 'serve.token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  server = spawn(nikaBin, [
    'serve',
    '--bind', `127.0.0.1:${port}`,
    '--workflows', project,
    '--token-file', tokenFile,
    '--state-root', path.join(scratch, 'state'),
    '--plain',
  ], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { diagnostics += chunk; });
  await waitForHealth(url);

  const env = {
    ...process.env,
    NIKA_BIN: nikaBin,
    NIKA_URL: url,
    NIKA_TOKEN: token,
  };
  const producer = spawnSync(process.execPath, ['client.mjs', 'producer'], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(producer.status, 0, producer.stderr);
  const recoveryState = producer.stdout.trim().split('\n').at(-1);
  assert(recoveryState, 'producer did not persist a recovery state');
  const consumer = spawnSync(process.execPath, ['client.mjs', 'consumer'], {
    cwd: project,
    env: { ...env, NIKA_RECOVERY_STATE: recoveryState },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(consumer.status, 0, consumer.stderr);
  const result = JSON.parse(consumer.stdout.trim().split('\n').at(-1));
  const evidence = {
    schema_version: 1,
    engine: execFileSync(nikaBin, ['--version'], { encoding: 'utf8' }).trim(),
    package: packed[0].filename,
    process_count: 2,
    installed_from_pack: true,
    ...result,
  };
  writeFileSync(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`two-process recovery green · ${resultPath}\n`);

  server.kill('SIGINT');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (server.exitCode && server.exitCode !== 130) {
    throw new Error(`nika serve exited ${server.exitCode}: ${diagnostics.slice(-500)}`);
  }
} finally {
  if (server?.exitCode === null) server.kill('SIGTERM');
  rmSync(scratch, { recursive: true, force: true });
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.listen(0, '127.0.0.1', resolve).once('error', reject);
  });
  const address = probe.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nika serve did not become healthy');
}
