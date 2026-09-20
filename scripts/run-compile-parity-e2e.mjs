import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedProcesses } from './one-door/process.mjs';
import { stopResident, waitForHealth } from './one-door/resident.mjs';

// Explicit frozen binary only; no Cargo, providers or paid calls. The SDK is
// installed from its tarball and both public module faces drive both real doors.
const root = path.resolve(import.meta.dirname, '..');
const binary = process.env.NIKA_BIN;
const reportPath = process.env.NIKA_COMPILE_PARITY_REPORT;
if (reportPath) writeFileSync(reportPath, JSON.stringify({ result: 'incomplete' }) + '\n');
assert(binary && path.isAbsolute(binary), 'NIKA_BIN must identify the frozen absolute engine path');
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-compile-parity-'));
const project = path.join(scratch, 'project');
const consumer = path.join(scratch, 'consumer');
const isolatedHome = path.join(scratch, 'home');
const token = 'compile-parity-test-only-token-0123456789';
const env = { ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
HOME: isolatedHome, NIKA_KEYCHAIN: 'off' };
const owned = new OwnedProcesses();
const abort = new AbortController();
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
  abort.abort(new Error(`compile parity interrupted by ${signal}`));
  void owned.close().catch(() => {});
}]));
for (const [signal, handler] of handlers) process.on(signal, handler);
let server;
let report;
try {
  for (const directory of [project, consumer, isolatedHome]) mkdirSync(directory);
  writeFileSync(path.join(project, 'nika.yaml'), 'nika: compile-parity\n');
  writeFileSync(path.join(scratch, 'token'), token + '\n', { mode: 0o600 });
  const run = (command, args, cwd = root) => owned.run(command, args, {
    cwd, env, timeoutMs: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  const binarySha = await sha256(binary);
  const identity = JSON.parse(await run(binary, ['--sdk-identity'], project));
  assert(identity.supportedCapabilities.includes('compile'), 'native must advertise compile');
  const version = (await run(binary, ['--version'], project)).trim();
  await run('npm', ['run', 'build']);
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]));
  const tarball = path.join(scratch, packed.filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--offline', tarball], consumer);
  copyFileSync(path.join(root, 'scripts/packed-consumers/compile-parity.cjs'), path.join(consumer, 'scenario.cjs'));
  writeFileSync(path.join(consumer, 'consumer.cjs'), [
    "const sdk = require('@supernovae-st/nika');", "const scenario = require('./scenario.cjs');",
    "const config = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));",
    'scenario(sdk, config).then((result) => process.stdout.write(JSON.stringify(result)));',
  ].join('\n'));
  writeFileSync(path.join(consumer, 'consumer.mjs'), [
    "import * as sdk from '@supernovae-st/nika';", "import scenario from './scenario.cjs';",
    "import { readFileSync } from 'node:fs';",
    'process.stdout.write(JSON.stringify(await scenario(sdk, JSON.parse(readFileSync(process.argv[2], "utf8")))));',
  ].join('\n'));
  server = owned.start(binary, ['serve', '--bind', '127.0.0.1:0', '--workflows', project,
    '--token-file', path.join(scratch, 'token'), '--state-root', path.join(scratch, 'state'), '--plain'],
  { cwd: project, env, timeoutMs: 300000 });
  let url;
  const deadline = Date.now() + 15000;
  while (!url && Date.now() < deadline) {
    abort.signal.throwIfAborted();
    assert.equal(server.child.exitCode, null, `Serve exited: ${server.stderr}`);
    url = `${server.stdout}\n${server.stderr}`.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) await delay(25);
  }
  assert(url, 'Serve did not announce its listener');
  await waitForHealth(url, server, abort.signal, { timeoutMs: 10000 });
  const request = async (route, authenticated = false) => {
    const response = await fetch(url + route, { headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const health = await request('/health');
  assert(health.supportedCapabilities.includes('compile'), 'Serve must advertise compile');
  const openapi = await request('/v1/openapi.json', true);
  assert(openapi.paths['/v1/compile']?.post, 'the live OpenAPI must own POST /v1/compile');
  assert.deepEqual(openapi, JSON.parse(readFileSync(path.join(root, 'openapi.json'), 'utf8')),
    'the packed contract pin must match this frozen resident');
  const stateRoot = path.join(scratch, 'state');
  const stateBefore = snapshot(stateRoot);
  const results = [];
  for (const moduleSystem of ['cjs', 'esm']) {
    const config = path.join(consumer, 'request.json');
    writeFileSync(config, JSON.stringify({ bin: binary, project, url, token, moduleSystem }));
    results.push(JSON.parse(await run(process.execPath,
      [path.join(consumer, `consumer.${moduleSystem === 'esm' ? 'mjs' : 'cjs'}`), config], consumer)));
  }
  assert.deepEqual(snapshot(stateRoot), stateBefore, 'compile must not create or mutate resident job state');
  assert.equal(await sha256(binary), binarySha, 'frozen binary changed during parity');
  report = { result: 'green', scope: 'compile foundation; no general authoring or execution grant',
    engine: { version, binary_sha256: binarySha, identity, health },
    sdk: { version: packed.version, package_sha256: await sha256(tarball) },
    compile_openapi: openapi.paths['/v1/compile'], resident_state_unchanged: true, results };
} catch (error) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ result: 'failed', message: error.message }, null, 2) + '\n');
  throw error;
} finally {
  try { await stopResident(server); }
  finally { await owned.close(); }
  rmSync(scratch, { recursive: true, force: true });
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
abort.signal.throwIfAborted();
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`compile parity green after owned cleanup: ${report.results[0].rows.length} cases × 2 doors × 2 module systems`);

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function snapshot(directory) {
  if (!existsSync(directory)) return null;
  return readdirSync(directory, { recursive: true, withFileTypes: true }).map((entry) => {
    const filename = path.join(entry.parentPath, entry.name);
    return { path: path.relative(directory, filename), mode: lstatSync(filename).mode,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
      content: entry.isFile() ? createHash('sha256').update(readFileSync(filename)).digest('hex')
        : entry.isSymbolicLink() ? readlinkSync(filename) : null };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
