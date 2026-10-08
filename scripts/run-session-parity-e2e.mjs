import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedProcesses } from './one-door/process.mjs';
import { stopResident, waitForHealth } from './one-door/resident.mjs';

// Explicit frozen binary only; no Cargo. The SDK is installed from its tarball
// and both public module faces walk the authoring Session through both real
// doors: `nika session --json` in a project, and a served project's
// `/v1/sessions`. Keyless: each walk has its own HOME and environment, no
// provider is seated or reachable, and the engine's deterministic compiler
// answers, so the doors and the module systems must walk the same sequence
// (scripts/packed-consumers/session-scenario.cjs). A door this binary does not
// host is `not_exercised`, never a pass. A real model's Session is a separate
// capability question, not this transport parity.
const root = path.resolve(import.meta.dirname, '..');
const binary = process.env.NIKA_BIN;
const reportPath = process.env.NIKA_SESSION_PARITY_REPORT;
if (reportPath) writeFileSync(reportPath, JSON.stringify({ result: 'incomplete' }) + '\n');
assert(binary && path.isAbsolute(binary), 'NIKA_BIN must identify the frozen absolute engine path');
// The resident hosts Sessions only when its operator says so.
const SERVE_SESSIONS = (process.env.NIKA_SESSION_SERVE_FLAGS ?? '--sessions').split(' ').filter(Boolean);
const require = createRequire(import.meta.url);
const { judgeSession, sessionParity, SHARED_STEPS, MODULE_STEPS } = require('./packed-consumers/session-scenario.cjs');
/** The project world both doors start from: one source file the requests read. */
const BRIEF = '# Brief\n\nOctobre — « vite » ✓ 🦋\n';
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-session-parity-'));
const consumer = path.join(scratch, 'consumer');
const token = 'session-parity-test-only-token-0123456789';
const tokenFile = path.join(scratch, 'token');
const baseEnv = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const owned = new OwnedProcesses();
const abort = new AbortController();
const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => {
  abort.abort(new Error(`session parity interrupted by ${signal}`));
  void owned.close().catch(() => {});
}]));
for (const [signal, handler] of handlers) process.on(signal, handler);
let report;
try {
  const buildHome = path.join(scratch, 'build-home');
  for (const directory of [consumer, buildHome]) mkdirSync(directory);
  writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  const run = (command, args, cwd = root, env = { ...baseEnv, HOME: buildHome, NIKA_KEYCHAIN: 'off' }) =>
    owned.run(command, args, { cwd, env, timeoutMs: 120000, maxBuffer: 16 * 1024 * 1024 });
  const binarySha = await sha256(binary);
  const identity = JSON.parse(await run(binary, ['--sdk-identity'], scratch));
  const version = (await run(binary, ['--version'], scratch)).trim();
  const commit = (await run('git', ['rev-parse', 'HEAD'])).trim();
  // Untracked files count: the scenario that drives the walks may be one of them.
  const dirty = (await run('git', ['status', '--porcelain'])).trim() !== '';
  const scenarioSha = await sha256(path.join(root, 'scripts/packed-consumers/session-scenario.cjs'));
  await run('npm', ['run', 'build']);
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch]));
  const tarball = path.join(scratch, packed.filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--offline', tarball],
    consumer);
  copyFileSync(path.join(root, 'scripts/packed-consumers/session-scenario.cjs'), path.join(consumer, 'scenario.cjs'));
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

  const walks = [];
  for (const moduleSystem of ['cjs', 'esm']) {
    for (const door of ['native', 'http']) walks.push(await walk(moduleSystem, door));
  }
  const exercised = walks.filter((entry) => entry.exercised);
  const find = (moduleSystem, door) => exercised.find((entry) => entry.module_system === moduleSystem
    && entry.door === door);
  const parity = {
    doors: ['cjs', 'esm'].map((moduleSystem) => {
      const [native, http] = [find(moduleSystem, 'native'), find(moduleSystem, 'http')];
      return native && http ? { module_system: moduleSystem, ...sessionParity(native.transcript, http.transcript,
        SHARED_STEPS) } : { module_system: moduleSystem, equal: null, why: 'a door was not exercised' };
    }),
    module_systems: ['native', 'http'].map((door) => {
      const [cjs, esm] = [find('cjs', door), find('esm', door)];
      return cjs && esm ? { door, ...sessionParity(cjs.transcript, esm.transcript, MODULE_STEPS) }
        : { door, equal: null, why: 'a module system was not exercised' };
    }),
  };
  const comparisons = [...parity.doors, ...parity.module_systems];
  const failed = exercised.some((entry) => entry.verdict === 'failed')
    || comparisons.some((entry) => entry.equal === false);
  const gaps = walks.some((entry) => !entry.exercised || entry.verdict === 'not_exercised')
    || comparisons.some((entry) => entry.equal === null);
  report = {
    result: failed ? 'failed' : gaps ? 'not_exercised' : 'green',
    scope: 'authoring Session transport parity on the deterministic compiler; no provider, no model capability claim',
    engine: { version, binary_sha256: binarySha, identity },
    sdk: { version: packed.version, package_sha256: await sha256(tarball), commit, dirty, scenario_sha256: scenarioSha },
    serve_flags: SERVE_SESSIONS,
    attempted: walks.map(({ module_system: moduleSystem, door, exercised: ran, verdict, why }) =>
      ({ module_system: moduleSystem, door, exercised: ran, verdict: verdict ?? null, why: why ?? null })),
    parity,
    walks,
  };

  /** One walk: a fresh project world, HOME and (for HTTP) resident; the packed consumer drives it. */
  async function walk(moduleSystem, door) {
    const base = path.join(scratch, moduleSystem, door);
    const project = world(path.join(base, 'project'));
    const other = world(path.join(base, 'other'));
    const home = path.join(base, 'home');
    mkdirSync(home, { recursive: true });
    const env = { ...baseEnv, HOME: home, NIKA_KEYCHAIN: 'off' };
    const row = { module_system: moduleSystem, door };
    if (door === 'native' && !identity.supportedCapabilities.includes('sessionHost')) {
      return { ...row, exercised: false, why: 'the engine identity lists no sessionHost' };
    }
    let server;
    let url;
    let health = null;
    try {
      if (door === 'http') {
        server = owned.start(binary, ['serve', '--bind', '127.0.0.1:0', '--workflows', project,
          '--token-file', tokenFile, '--state-root', path.join(base, 'state'), '--plain', ...SERVE_SESSIONS],
        { cwd: project, env, timeoutMs: 1_800_000 });
        const deadline = Date.now() + 15000;
        while (!url && Date.now() < deadline && server.child.exitCode === null) {
          abort.signal.throwIfAborted();
          url = `${server.stdout}\n${server.stderr}`.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (!url) await delay(25);
        }
        if (!url) {
          const lines = `${server.stderr}`.trim().split('\n');
          const said = lines.find((line) => /error/i.test(line)) ?? lines.slice(-3).join(' | ');
          return { ...row, exercised: false, why: `the resident did not serve with ${SERVE_SESSIONS.join(' ')}: ${said}` };
        }
        await waitForHealth(url, server, abort.signal, { timeoutMs: 10000 });
        health = await (await fetch(`${url}/health`,
          { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })).json();
        if (!health.supportedCapabilities.includes('sessionHost')) {
          return { ...row, exercised: false, health, why: 'the resident lists no sessionHost' };
        }
      }
      const config = path.join(base, 'config.json');
      writeFileSync(config, JSON.stringify({ door, bin: binary, project, other, url, token, moduleSystem }));
      const transcript = JSON.parse(await owned.run(process.execPath,
        [path.join(consumer, `consumer.${moduleSystem === 'esm' ? 'mjs' : 'cjs'}`), config],
        { cwd: consumer, env, timeoutMs: 1_800_000, maxBuffer: 16 * 1024 * 1024 }));
      return { ...row, exercised: true, health, ...judgeSession(transcript), transcript };
    } finally {
      // A resident that refused its flags already exited: its words are the walk's `why`.
      if (server && server.child.exitCode === null && server.child.signalCode === null) await stopResident(server);
      else if (server) await server.done.catch(() => {});
    }
  }
} catch (error) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ result: 'failed', message: error.message }, null, 2) + '\n');
  throw error;
} finally {
  await owned.close();
  rmSync(scratch, { recursive: true, force: true });
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
abort.signal.throwIfAborted();
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const summary = report.attempted.map((entry) => `${entry.module_system}/${entry.door}: `
  + (entry.exercised ? entry.verdict : `not exercised (${entry.why})`)).join('; ');
if (report.result === 'green') {
  console.log(`session parity green after owned cleanup: ${summary}`);
} else {
  console.error(`session parity ${report.result}: ${summary}`);
  process.exitCode = 1;
}

/** A project world: the one source file, nothing else. */
function world(directory) {
  mkdirSync(path.join(directory, 'notes'), { recursive: true });
  writeFileSync(path.join(directory, 'notes', 'brief.md'), BRIEF);
  return directory;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
