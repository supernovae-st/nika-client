import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedProcesses } from './one-door/process.mjs';
import { stopResident, waitForHealth } from './one-door/resident.mjs';

// Explicit frozen binary only; no Cargo. The SDK is installed from its tarball
// and both public module faces drive both real doors. The deterministic phase
// makes no provider call. The provider phase runs only when
// NIKA_COMPILE_PROVIDER_MODEL names a seat and NIKA_COMPILE_PROVIDER_ENV names
// the one variable holding its key (passed to the engine, never printed): one
// document revision per door per module system, separate generations judged by
// the evidence law alone, never compared byte for byte.
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
// The provider phase's base: comments, Unicode, every envelope section and an
// input the change does not touch (it checks clean on the 0.122 carrier).
const REVISION_BASE = [
  '# Stock watch: keeps a rolling window of the stock pages.',
  '# Libellés en français : « Relevé — semaine » ✓ 🦋',
  'nika: stock-watch',
  'inputs:',
  '  region:',
  '    type: string',
  '    default: eu-west',
  'const:',
  '  window_hours: 48 # hours of history kept',
  '  label: "Relevé — semaine"',
  '  pages_path: ./data/stock.json',
  'permits:',
  '  fs:',
  '    read:',
  '      - ./data/stock.json',
  '  tools:',
  '    - nika:read',
  '    - nika:jq',
  'tasks:',
  '  read_pages:',
  '    invoke:',
  '      tool: nika:read',
  '      args:',
  '        path: ${{ const.pages_path }}',
  '  window:',
  '    after:',
  '      read_pages: success',
  '    with:',
  '      pages: ${{ tasks.read_pages.output }}',
  '    invoke:',
  '      tool: nika:jq',
  '      args:',
  '        input: ${{ with.pages }}',
  '        expression: "[.items[] | select(.age_hours <= ${{ const.window_hours }})] | length"',
  'outputs:',
  '  kept: ${{ tasks.window.output }}',
  '  label: ${{ const.label }}',
  '  region: ${{ inputs.region }}',
  '',
].join('\n');
const REVISION_INTENT = 'Read ./data/stock.json, count the stock pages younger than two days and label the result '
  + '« Relevé — semaine ».';
const REVISION_CHANGE = 'Keep three days of history instead of two.';
/** Lines the change does not touch: an operations revision keeps them byte for byte. */
const REVISION_KEPT = ['# Stock watch: keeps a rolling window of the stock pages.',
  '# Libellés en français : « Relevé — semaine » ✓ 🦋', '  label: "Relevé — semaine"', '    default: eu-west'];
// The CREATE leg's words: a new document from words alone, with a part only an author writes (a
// summary), so the document door is reached; a schedule's bindings stay optional questions. A
// language owner's pinned intent replaces it through NIKA_COMPILE_CREATE_INTENT_FILE.
const CREATE_INTENT = process.env.NIKA_COMPILE_CREATE_INTENT_FILE
  ? readFileSync(process.env.NIKA_COMPILE_CREATE_INTENT_FILE, 'utf8').trim()
  : 'Create a new workflow named weekly-digest. Every Monday, read ./notes/brief.md, write a three-line summary '
    + 'of it in French under the title « Relevé — semaine ✓ », and save it to ./out/digest.md. Keep the number of '
    + 'lines as a constant.';
// Which provider legs run (`edit`, `create`): both by default, each a separate generation per door.
const PROVIDER_LEGS = (process.env.NIKA_COMPILE_PROVIDER_LEGS ?? 'edit,create').split(',').filter(Boolean);
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
let seated;
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
  // The SDK source the package was built from; untracked files count (a scenario may be one).
  const commit = (await run('git', ['rev-parse', 'HEAD'])).trim();
  const dirty = (await run('git', ['status', '--porcelain'])).trim() !== '';
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
  // The package's pin by default. A candidate engine ahead of that pin is compared with the
  // document NIKA_COMPILE_PARITY_OPENAPI names instead, and the report says which one held.
  const pinPath = path.resolve(process.env.NIKA_COMPILE_PARITY_OPENAPI ?? path.join(root, 'openapi.json'));
  assert.deepEqual(openapi, JSON.parse(readFileSync(pinPath, 'utf8')),
    'the contract pin must match this frozen resident');
  const openapiPin = { path: pinPath, sha256: await sha256(pinPath),
    package_pin: pinPath === path.join(root, 'openapi.json') };
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
  // The deterministic resident's part is done: it never outlives its phase into the provider's.
  await stopResident(server);
  server = undefined;
  const provider = await providerPhase();
  assert.equal(await sha256(binary), binarySha, 'frozen binary changed during parity');
  // A provider phase whose rounds stated no revision, or whose creations settled no record,
  // did not exercise what it targets: the report keeps every row, and the result withholds
  // the qualification.
  // A module system the harness stopped watching, or one never reached after it, exercised less
  // than the phase targets: never green.
  const exercised = !provider.ran || (provider.results.length === 2 && provider.results.every(
    ({ rows, created, harness_bound: bound }) => bound === undefined
      && [...rows, ...created].every((row) => row.exercised)));
  report = { result: exercised ? 'green' : 'not_exercised',
    scope: 'compile foundation; no general authoring or execution grant',
    engine: { version, binary_sha256: binarySha, identity, health },
    sdk: { version: packed.version, package_sha256: await sha256(tarball), commit, dirty },
    openapi_pin: openapiPin, compile_openapi: openapi.paths['/v1/compile'], resident_state_unchanged: true,
    results, provider };

  async function providerPhase() {
    const model = process.env.NIKA_COMPILE_PROVIDER_MODEL;
    if (!model) return { ran: false, why: 'NIKA_COMPILE_PROVIDER_MODEL unset: deterministic phase only' };
    assert(PROVIDER_LEGS.length > 0 && PROVIDER_LEGS.every((leg) => leg === 'edit' || leg === 'create'),
      'NIKA_COMPILE_PROVIDER_LEGS names edit and/or create, comma-separated');
    assert(CREATE_INTENT.length > 0, 'the CREATE leg needs words');
    // The seats each door is given (Serve seats a direct provider only; a native seat may be an
    // ACP harness such as `claude-code/…` or `codex/…`), and the decision seat both doors judge
    // with (a local revision takes `--decision-model` from engine ae6845939 on).
    const seats = {
      native: process.env.NIKA_COMPILE_NATIVE_MODEL ?? model,
      serve: process.env.NIKA_COMPILE_SERVE_MODEL ?? model,
      decision: process.env.NIKA_COMPILE_DECISION_MODEL ?? null,
    };
    // The variables the engine processes receive, by name only (keys, and HOME when a harness
    // must find its own login); their values are never printed.
    const keyNames = (process.env.NIKA_COMPILE_PROVIDER_ENV ?? '').split(',').filter(Boolean);
    assert(keyNames.length > 0 && keyNames.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name) && process.env[name]),
      'NIKA_COMPILE_PROVIDER_ENV must name the set variables the seats need, comma-separated');
    const seatedEnv = { ...env, ...Object.fromEntries(keyNames.map((name) => [name, process.env[name]])) };
    // The operator's grants for the seated resident (its call ceiling per authoring round, repairs,
    // deadlines), in its own flag words; absent, the resident's defaults. Recorded in the report.
    const serveFlags = (process.env.NIKA_COMPILE_SERVE_FLAGS ?? '').split(/\s+/).filter(Boolean);
    // How long the harness watches one module system's rounds (six hours unless set): a bound of
    // its own observation, recorded in the report, never a limit on the authoring itself.
    const providerWaitMs = Number(process.env.NIKA_COMPILE_PROVIDER_WAIT_MS ?? 21_600_000);
    assert(Number.isSafeInteger(providerWaitMs) && providerWaitMs > 0 && providerWaitMs <= 0x7fffffff,
      'NIKA_COMPILE_PROVIDER_WAIT_MS is a positive number of milliseconds');
    assert(serveFlags.every((flag) => /^(--[a-z][a-z0-9-]*|[A-Za-z0-9._/:-]+)$/.test(flag)),
      'NIKA_COMPILE_SERVE_FLAGS holds the resident\'s own flags and values, space-separated');
    // Its own project: a native provider round records its plan under .nika/compile/ there.
    const seatedProject = path.join(scratch, 'seated-project');
    mkdirSync(seatedProject);
    writeFileSync(path.join(seatedProject, 'nika.yaml'), 'nika: compile-evidence\n');
    copyFileSync(path.join(root, 'scripts/packed-consumers/compile-evidence.cjs'), path.join(consumer, 'evidence.cjs'));
    writeFileSync(path.join(consumer, 'evidence-consumer.cjs'), [
      "const sdk = require('@supernovae-st/nika');", "const scenario = require('./evidence.cjs');",
      "const config = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));",
      'scenario(sdk, config).then((result) => process.stdout.write(JSON.stringify(result)));',
    ].join('\n'));
    writeFileSync(path.join(consumer, 'evidence-consumer.mjs'), [
      "import * as sdk from '@supernovae-st/nika';", "import scenario from './evidence.cjs';",
      "import { readFileSync } from 'node:fs';",
      'process.stdout.write(JSON.stringify(await scenario(sdk, JSON.parse(readFileSync(process.argv[2], "utf8")))));',
    ].join('\n'));
    seated = owned.start(binary, ['serve', '--bind', '127.0.0.1:0', '--workflows', seatedProject,
      '--token-file', path.join(scratch, 'token'), '--state-root', path.join(scratch, 'seated-state'), '--plain',
      '--authoring-model', seats.serve, ...(seats.decision ? ['--decision-model', seats.decision] : []), ...serveFlags],
    { cwd: seatedProject, env: seatedEnv, timeoutMs: 3_600_000 });
    let seatedUrl;
    const until = Date.now() + 15000;
    while (!seatedUrl && Date.now() < until) {
      abort.signal.throwIfAborted();
      assert.equal(seated.child.exitCode, null, `seated Serve exited: ${seated.stderr}`);
      seatedUrl = `${seated.stdout}\n${seated.stderr}`.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (!seatedUrl) await delay(25);
    }
    assert(seatedUrl, 'the seated Serve did not announce its listener');
    await waitForHealth(seatedUrl, seated, abort.signal, { timeoutMs: 10000 });
    const seatedHealth = await (await fetch(`${seatedUrl}/health`,
      { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) })).json();
    assert(seatedHealth.supportedCapabilities.includes('compileNativeV2'), 'the seated Serve must speak generation 2');
    const rows = [];
    for (const moduleSystem of ['cjs', 'esm']) {
      const config = path.join(consumer, 'evidence.json');
      const progress = path.join(consumer, `evidence-${moduleSystem}.jsonl`);
      writeFileSync(progress, '');
      writeFileSync(config, JSON.stringify({ bin: binary, project: seatedProject, url: seatedUrl, token, moduleSystem,
        model: seats.native, decisionModel: seats.decision, base: REVISION_BASE, change: REVISION_CHANGE,
        originalIntent: REVISION_INTENT, keptLines: REVISION_KEPT, createIntent: CREATE_INTENT, legs: PROVIDER_LEGS,
        progress }));
      let result;
      try {
        result = JSON.parse(await owned.run(process.execPath,
          [path.join(consumer, `evidence-consumer.${moduleSystem === 'esm' ? 'mjs' : 'cjs'}`), config],
          { cwd: consumer, env: seatedEnv, timeoutMs: providerWaitMs, maxBuffer: 16 * 1024 * 1024 }));
      } catch (error) {
        if (!/timed out after \d+ms$/.test(String(error?.message))) throw error;
        // The harness stopped watching (its window, never a product limit): the legs that landed
        // are kept, the rest is withheld, and no further generation is asked.
        const landed = readFileSync(progress, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        rows.push({ module_system: moduleSystem, rows: landed.filter((entry) => entry.leg === 'edit')
          .map((entry) => entry.row), created: landed.filter((entry) => entry.leg === 'create').map((entry) => entry.row),
        harness_bound: { bound: 'provider_wait', limit_ms: providerWaitMs,
          why: `the harness stopped watching ${moduleSystem} after ${providerWaitMs} ms: an observation bound of this `
            + 'harness, never a product limit' } });
        break;
      }
      for (const row of result.rows) {
        // Operations claim every byte outside their spans: the base's comments and Unicode survive.
        if (row.revision?.mode === 'operations') {
          assert.equal(row.candidate_keeps_comments_and_unicode, true,
            `${moduleSystem} ${row.door}: an operations revision kept the base's untouched lines`);
        }
      }
      rows.push(result);
    }
    await stopResident(seated);
    seated = undefined;
    return { ran: true, model, seats, key_env: keyNames, legs: PROVIDER_LEGS,
      serve_flags: serveFlags.length > 0 ? serveFlags : 'the resident\'s defaults',
      observation_ms: providerWaitMs,
      base_sha256: createHash('sha256').update(REVISION_BASE).digest('hex'),
      change: REVISION_CHANGE, original_intent: REVISION_INTENT,
      create_intent: CREATE_INTENT, create_intent_sha256: createHash('sha256').update(CREATE_INTENT).digest('hex'),
      create_intent_source: process.env.NIKA_COMPILE_CREATE_INTENT_FILE ?? 'scripts/run-compile-parity-e2e.mjs',
      seated_capabilities: seatedHealth.supportedCapabilities, results: rows,
      law: 'separate generations: each door judged by the evidence law, never compared byte for byte' };
  }
} catch (error) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ result: 'failed', message: error.message }, null, 2) + '\n');
  throw error;
} finally {
  try {
    if (seated) await stopResident(seated);
    if (server) await stopResident(server);
  } finally { await owned.close(); }
  rmSync(scratch, { recursive: true, force: true });
  for (const [signal, handler] of handlers) process.off(signal, handler);
}
abort.signal.throwIfAborted();
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
if (report.result !== 'green') {
  const bounded = report.provider?.results?.find((entry) => entry.harness_bound)?.harness_bound;
  console.error(bounded ? `compile parity held back: ${bounded.why} (the legs that landed are in the report)`
    : 'compile parity held back: a provider round stated no revision, or a creation settled no record, so '
    + 'the evidence it targets was not exercised (see the report rows)');
  process.exitCode = 1;
} else {
  console.log(`compile parity green after owned cleanup: ${report.results[0].rows.length} cases × 2 doors × 2 module systems`
    + (report.provider.ran
      ? `; provider evidence (${report.provider.legs.join(', ')}) ${report.provider.results.length} module systems `
        + `× 2 doors on ${report.provider.model}` : ''));
}

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
