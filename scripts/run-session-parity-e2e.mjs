import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
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
const { judgeJourney, journeyDoors, sessionResult } = require('./packed-consumers/session-journey.cjs');
// A requested journey's doors are checked before anything is built or run: an empty or unknown
// selection is refused, never reported as a journey that walked nothing.
let JOURNEY_DOORS;
try {
  const requested = process.env.NIKA_SESSION_JOURNEY_CHOICE || process.env.NIKA_SESSION_JOURNEY_INTELLIGENCE;
  if (process.env.NIKA_SESSION_JOURNEY_CHOICE && process.env.NIKA_SESSION_JOURNEY_INTELLIGENCE) {
    throw new Error('name the intelligence once: NIKA_SESSION_JOURNEY_CHOICE answers the first screen, '
      + 'NIKA_SESSION_JOURNEY_INTELLIGENCE opens each Session with it');
  }
  JOURNEY_DOORS = requested ? journeyDoors(process.env.NIKA_SESSION_JOURNEY_DOORS) : [];
} catch (error) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ result: 'refused', message: error.message }, null, 2) + '\n');
  throw error;
}
/** The project world both doors start from: one source file the requests read. */
const BRIEF = '# Brief\n\nOctobre — « vite » ✓ 🦋\n';
/** The journey's world: tickets at and around both thresholds, so 48 and 72 hours select apart. */
const TICKETS = [{ id: 'fresh', age_hours: 24 }, { id: 'boundary-48', age_hours: 48 }, { id: 'stale-60', age_hours: 60 },
  { id: 'boundary-72', age_hours: 72 }, { id: 'stale-90', age_hours: 90 }];
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
  // The walk (`session-scenario`) and the journey (`session-journey`), each named by the consumer's
  // second argument; the journey reuses the walk's helpers.
  for (const name of ['session-scenario.cjs', 'session-journey.cjs']) {
    copyFileSync(path.join(root, 'scripts/packed-consumers', name), path.join(consumer, name));
  }
  writeFileSync(path.join(consumer, 'consumer.cjs'), [
    "const sdk = require('@supernovae-st/nika');", "const scenario = require(`./${process.argv[3]}.cjs`);",
    "const config = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));",
    'scenario(sdk, config).then((result) => process.stdout.write(JSON.stringify(result)));',
  ].join('\n'));
  writeFileSync(path.join(consumer, 'consumer.mjs'), [
    "import * as sdk from '@supernovae-st/nika';", "import { readFileSync } from 'node:fs';",
    'const { default: scenario } = await import(`./${process.argv[3]}.cjs`);',
    'process.stdout.write(JSON.stringify(await scenario(sdk, JSON.parse(readFileSync(process.argv[2], "utf8")))));',
  ].join('\n'));
  const consume = (moduleSystem, name, config, env) => owned.run(process.execPath,
    [path.join(consumer, `consumer.${moduleSystem === 'esm' ? 'mjs' : 'cjs'}`), config, name],
    { cwd: consumer, env, timeoutMs: 3_600_000, maxBuffer: 16 * 1024 * 1024 });

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
  const journey = await journeyPhase();
  report = {
    result: sessionResult(walks, comparisons, journey),
    scope: 'authoring Session transport parity on the deterministic compiler'
      + (journey.ran ? '; plus a real intelligence journey (capability evidence, never byte parity)' : '; no model claim'),
    engine: { version, binary_sha256: binarySha, identity },
    sdk: { version: packed.version, package_sha256: await sha256(tarball), commit, dirty, scenario_sha256: scenarioSha,
      journey_sha256: await sha256(path.join(root, 'scripts/packed-consumers/session-journey.cjs')) },
    serve_flags: SERVE_SESSIONS,
    attempted: walks.map(({ module_system: moduleSystem, door, exercised: ran, verdict, why }) =>
      ({ module_system: moduleSystem, door, exercised: ran, verdict: verdict ?? null, why: why ?? null })),
    parity,
    walks,
    journey,
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
    const served = door === 'http' ? await serve(base, project, env) : { server: undefined };
    try {
      if (served.why !== undefined) return { ...row, exercised: false, health: served.health ?? null, why: served.why };
      const config = path.join(base, 'config.json');
      writeFileSync(config, JSON.stringify({ door, bin: binary, project, other, url: served.url, token, moduleSystem }));
      const transcript = JSON.parse(await consume(moduleSystem, 'session-scenario', config, env));
      return { ...row, exercised: true, health: served.health ?? null, ...judgeSession(transcript), transcript };
    } finally {
      await release(served.server);
    }
  }

  /**
   * The journey phase, run only when NIKA_SESSION_JOURNEY_CHOICE names the first screen's
   * answer, or NIKA_SESSION_JOURNEY_INTELLIGENCE the conversation's own intelligence each
   * Session opens with (`2 deepseek/<model>`, `1 acp:claude-code/<model>`…, the Session's own
   * words either way). One ESM consumer per door: a generation costs, and module parity is the
   * walks' to prove.
   */
  async function journeyPhase() {
    const choice = process.env.NIKA_SESSION_JOURNEY_CHOICE || null;
    const intelligence = process.env.NIKA_SESSION_JOURNEY_INTELLIGENCE || null;
    if (!choice && !intelligence) {
      return { ran: false, why: 'NIKA_SESSION_JOURNEY_CHOICE and NIKA_SESSION_JOURNEY_INTELLIGENCE unset: '
        + 'deterministic transport parity only' };
    }
    const requested = intelligence ?? choice;
    // The variables the engine processes receive, by name only (keys, and HOME when an app seat
    // must find its sign-in); their values are never printed.
    const keyNames = (process.env.NIKA_SESSION_JOURNEY_ENV ?? '').split(',').filter(Boolean);
    assert(keyNames.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name) && process.env[name]),
      'NIKA_SESSION_JOURNEY_ENV must name set variables, comma-separated');
    // The decision seat and the reasoning effort, read by the engine from its own environment.
    const seats = Object.fromEntries(['NIKA_SESSION_DECISION_MODEL', 'NIKA_AUTHORING_REASONING']
      .filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    const createFile = process.env.NIKA_SESSION_JOURNEY_CREATE_FILE
      ?? path.join(root, 'test/fixtures/compile-evidence/recorded-fcdd44292/intent-stale-filter.txt');
    const create = readFileSync(createFile, 'utf8');
    const edit = process.env.NIKA_SESSION_JOURNEY_EDIT ?? 'Raise the age threshold to 72 hours.';
    const answers = process.env.NIKA_SESSION_JOURNEY_ANSWERS ? JSON.parse(process.env.NIKA_SESSION_JOURNEY_ANSWERS) : {};
    const acceptCost = process.env.NIKA_SESSION_JOURNEY_ACCEPT_COST === '1';
    // The harness's own window for one turn and one Run (the journey's 30 minutes unless set): a
    // bound of its observation, reported as such, never a limit on the Session's work.
    const waitMs = process.env.NIKA_SESSION_JOURNEY_WAIT_MS === undefined ? null
      : Number(process.env.NIKA_SESSION_JOURNEY_WAIT_MS);
    assert(waitMs === null || (Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 0x7fffffff),
      'NIKA_SESSION_JOURNEY_WAIT_MS is a positive number of milliseconds');
    // The tickets the words read, and the report each leg must write: strictly older than 48, then 72 hours.
    const expected = { create: TICKETS.filter((row) => row.age_hours > 48).map((row) => row.id),
      edit: TICKETS.filter((row) => row.age_hours > 72).map((row) => row.id) };
    // A world module (NIKA_SESSION_JOURNEY_WORLD, an absolute path) replaces the built-in tickets
    // world: per door it prepares the project and its services, states the words, the persona's
    // answers and what to capture, then judges each leg and closes. It is named in the report by
    // its file name and sha256 only.
    const worldFile = process.env.NIKA_SESSION_JOURNEY_WORLD;
    let world = null;
    if (worldFile) {
      assert(path.isAbsolute(worldFile), 'NIKA_SESSION_JOURNEY_WORLD names an absolute module path');
      world = await import(pathToFileURL(worldFile).href);
      assert(typeof world.prepare === 'function', 'a journey world exports prepare()');
    }
    const doors = [];
    for (const door of JOURNEY_DOORS) {
      doors.push(await journeyWalk(door));
    }
    return { ran: true, choice, intelligence, key_env: keyNames, seats, accept_cost: acceptCost,
      observation_ms: waitMs ?? 'the journey default (1800000)',
      world: world === null ? 'built-in tickets' : { module: path.basename(worldFile), sha256: await sha256(worldFile) },
      ...(world === null ? {
        answers: Object.keys(answers),
        // Named relative to the repository, or by its file name alone: a report never carries a private path.
        create_source: path.relative(root, createFile).startsWith('..')
          ? `<outside the repository>/${path.basename(createFile)}` : path.relative(root, createFile),
        create_sha256: createHash('sha256').update(create).digest('hex'), edit, expected,
      } : {}),
      law: 'each generation judged by its own evidence and the project world, never byte-compared with another',
      doors };

    async function journeyWalk(door) {
      const base = path.join(scratch, 'journey', door);
      const project = path.join(base, 'project');
      mkdirSync(project, { recursive: true });
      projectFile(project);
      const home = path.join(base, 'home');
      mkdirSync(home, { recursive: true });
      // The world this door walks: a module's (its services already listening), or the tickets.
      let prepared;
      if (world !== null) {
        prepared = await world.prepare({ door, project, scratch: base, binary });
      } else {
        mkdirSync(path.join(project, 'in'), { recursive: true });
        writeFileSync(path.join(project, 'in', 'tickets.json'), `${JSON.stringify(TICKETS, null, 2)}\n`);
        prepared = { label: 'built-in tickets', create, edit, answers, env: {}, capture: ['out'] };
      }
      const env = { ...baseEnv, HOME: home, NIKA_KEYCHAIN: 'off', ...seats,
        ...Object.fromEntries(keyNames.map((name) => [name, process.env[name]])), ...(prepared.env ?? {}) };
      // With the person's own HOME the Session's first screen would keep its answer there
      // (`~/.nika/session-intelligence.json`): the persona then never answers it, and the
      // judge reports a choice kept from elsewhere as such. Opened with the conversation's own
      // intelligence, nothing is kept there, and the journey checks that byte for byte.
      const personHome = keyNames.includes('HOME');
      const homeWords = intelligence ? 'the person\'s own HOME: opened with the conversation\'s own intelligence'
        : 'the person\'s own HOME: no first-screen answer';
      const row = { door, home: personHome ? homeWords : 'isolated',
        world: prepared.label ?? null, expectations: prepared.expectations ?? null };
      let served = { server: undefined };
      let outcome;
      try {
        outcome = await walkDoor();
      } finally {
        await release(served.server);
        // The world's own observations (its services' records), kept beside the door's verdict.
        const observations = typeof prepared.close === 'function' ? await prepared.close() : undefined;
        if (outcome !== undefined && observations !== undefined) outcome.observations = observations;
      }
      return outcome;

      async function walkDoor() {
        if (door === 'native' && !identity.supportedCapabilities.includes('sessionHost')) {
          return { ...row, exercised: false, why: 'the engine identity lists no sessionHost' };
        }
        served = door === 'http' ? await serve(base, project, env) : served;
        if (served.why !== undefined) return { ...row, exercised: false, why: served.why };
        const config = path.join(base, 'config.json');
        writeFileSync(config, JSON.stringify({ door, bin: binary, project, url: served.url, token, moduleSystem: 'esm',
          choice: personHome || intelligence ? null : choice, intelligence, acceptCost, waitMs,
          answers: prepared.answers, create: prepared.create,
          edit: prepared.edit, checkBin: binary, snapshots: path.join(base, 'legs'), capture: prepared.capture }));
        const transcript = JSON.parse(await consume('esm', 'session-journey', config, env));
        // A world judges its own postconditions per leg; the identity checks stay the journey's.
        const worldChecks = typeof prepared.judge === 'function' ? await prepared.judge(transcript) : null;
        return { ...row, exercised: true,
          ...judgeJourney(transcript, expected, requested, worldChecks, seats.NIKA_AUTHORING_REASONING ?? null),
          transcript };
      }
    }
  }

  /** A resident serving `project`, healthy and hosting Sessions, or why not. */
  async function serve(base, project, env) {
    const server = owned.start(binary, ['serve', '--bind', '127.0.0.1:0', '--workflows', project,
      '--token-file', tokenFile, '--state-root', path.join(base, 'state'), '--plain', ...SERVE_SESSIONS],
    { cwd: project, env, timeoutMs: 3_600_000 });
    let url;
    const deadline = Date.now() + 15000;
    while (!url && Date.now() < deadline && server.child.exitCode === null) {
      abort.signal.throwIfAborted();
      url = `${server.stdout}\n${server.stderr}`.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (!url) await delay(25);
    }
    if (!url) {
      // In the resident's own words, wherever it wrote them (a refused flag on stderr, a project
      // it cannot arm on stdout).
      const lines = `${server.stderr}\n${server.stdout}`.split('\n').map((line) => line.trim()).filter(Boolean);
      const said = lines.find((line) => /error/i.test(line)) ?? lines.slice(0, 3).join(' | ');
      return { server, why: `the resident did not serve with ${SERVE_SESSIONS.join(' ')}: ${said}` };
    }
    await waitForHealth(url, server, abort.signal, { timeoutMs: 10000 });
    const health = await (await fetch(`${url}/health`,
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })).json();
    if (!health.supportedCapabilities.includes('sessionHost')) {
      return { server, health, why: 'the resident lists no sessionHost' };
    }
    return { server, url, health };
  }

  /** Stop a resident; one that refused its flags already exited and its words are the `why`. */
  async function release(server) {
    if (server && server.child.exitCode === null && server.child.signalCode === null) await stopResident(server);
    else if (server) await server.done.catch(() => {});
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
  + (entry.exercised ? entry.verdict : `not exercised (${entry.why})`)).join('; ')
  + (report.journey.ran ? `; journey ${report.journey.doors.map((entry) => `${entry.door}: `
    + (entry.exercised ? entry.verdict : `not exercised (${entry.why})`)).join(', ')}` : '');
if (report.result === 'green') {
  console.log(`session parity green after owned cleanup: ${summary}`);
} else {
  console.error(`session parity ${report.result}: ${summary}`);
  process.exitCode = 1;
}

/** A project world: the project file a resident arms by and the one source file, nothing else. */
function world(directory) {
  mkdirSync(path.join(directory, 'notes'), { recursive: true });
  projectFile(directory);
  writeFileSync(path.join(directory, 'notes', 'brief.md'), BRIEF);
  return directory;
}

/**
 * The project file, on both doors alike: a resident arms nothing without one ("nothing armed —
 * this project has no `nika.yaml`") and never listens, so each door walks the same world.
 */
function projectFile(directory) {
  writeFileSync(path.join(directory, 'nika.yaml'), 'nika: session-parity\n');
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
