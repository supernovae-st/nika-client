import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedProcesses } from './one-door/process.mjs';
import { stopResident, waitForHealth } from './one-door/resident.mjs';
import {
  ENGINE_CASES, ENV_CANARY, REQUIRED_INPUTS, SDK_CASES, WORKFLOW, WORKFLOW_NAME, parityVerdict,
} from './input-parity/contract.mjs';

// Literal input parity (issue #116): the PACKED SDK drives one real engine as a
// native process and as a `nika serve` resident, from an ESM and from a
// CommonJS consumer, and the two transports must agree on every verdict:
// outputs, refusal codes and `api-caller` provenance. The workflow is pure
// `nika:jq` (no model seat, no network) and every native run carries a $0
// ceiling. This proves runtime parity of the binary it is given; it attests
// nothing about where that binary came from.
//
//   NIKA_BIN                   engine advertising inputsLiteral, serving jobInputs
//   NIKA_OLD_BIN               optional · an engine from before the channel
//   NIKA_INPUT_PARITY_REPORT   optional · where the JSON report is written
//   NIKA_INPUT_PARITY_DROP_FIELDS
//     optional · comma-separated additive fields an engine AHEAD of this SDK's
//     pinned wire puts on the resident's closed projections (the SDK refuses
//     them, rightly, and so cannot observe any HTTP run of that engine). The
//     unadapted refusal is measured and reported first; only then, and only if
//     this is set, does the harness drop exactly these fields from responses.
//     Such a run is a DIAGNOSTIC, never a qualification: its report says
//     `result: "diagnostic"`, every HTTP row is stamped `adapted-harness`, its
//     headline never says green, and it exits 2 so it can satisfy no gate.

const root = path.resolve(import.meta.dirname, '..');
const { digested } = createRequire(import.meta.url)('./input-parity/consumer-scenario.cjs');
const reportPath = process.env.NIKA_INPUT_PARITY_REPORT;
// Invalidate a prior green before validation or installation can fail.
if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ result: 'incomplete', pid: process.pid })}\n`);
const binary = process.env.NIKA_BIN;
assert(binary && path.isAbsolute(binary), 'NIKA_BIN must be an absolute engine path');
const oldBinary = process.env.NIKA_OLD_BIN;
assert(!oldBinary || path.isAbsolute(oldBinary), 'NIKA_OLD_BIN must be an absolute engine path');
const requestedDropFields = (process.env.NIKA_INPUT_PARITY_DROP_FIELDS ?? '').split(',')
  .map((field) => field.trim()).filter(Boolean);
assert(requestedDropFields.every((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field)),
  'NIKA_INPUT_PARITY_DROP_FIELDS must be comma-separated field names');

const scratch = mkdtempSync(path.join(tmpdir(), 'nika-input-parity-e2e-'));
const project = path.join(scratch, 'project');
const oldProject = path.join(scratch, 'old-project');
const consumer = path.join(scratch, 'consumer');
const traces = path.join(project, '.nika/traces');
const token = 'input-parity-contract-test-token-0123456789';
// No inherited provider credentials, proxy configuration, engine config or
// signing keys. The canary is the one variable a channel could wrongly read.
const env = { ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM']
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
  HOME: path.join(scratch, 'home'), NIKA_KEYCHAIN: 'off', [ENV_CANARY.name]: ENV_CANARY.value };
const owned = new OwnedProcesses();
const abort = new AbortController();
let cleanupError;
function stopProof(reason) {
  abort.abort(new Error(reason));
  void owned.close().catch((error) => { cleanupError = error; });
}
const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP']
  .map((signal) => [signal, () => stopProof(`input-parity received ${signal}`)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const deadline = setTimeout(() => stopProof('input-parity overall deadline exceeded (300s)'), 300_000);
const rows = [];
let configSequence = 0;
let report;
let server;
let oldServer;
let observation;
let verdict;
/** Empty unless the unadapted SDK could not observe this resident AND the operator opted in. */
let dropFields = [];

try {
  for (const directory of [project, oldProject, consumer, env.HOME]) mkdirSync(directory);
  for (const directory of [project, oldProject]) {
    writeFileSync(path.join(directory, 'nika.yaml'), 'nika: input-parity-e2e\n');
    writeFileSync(path.join(directory, WORKFLOW_NAME), WORKFLOW);
  }
  writeFileSync(path.join(scratch, 'token'), `${token}\n`, { mode: 0o600 });

  const engine = await probe(binary);
  assert(engine.sdk_identity.supportedCapabilities.includes('inputsLiteral'),
    `NIKA_BIN must advertise inputsLiteral: ${engine.sdk_identity.supportedCapabilities}`);
  const checked = JSON.parse(await owned.run(binary, ['check', WORKFLOW_NAME, '--json', '--native-strict'],
    { cwd: project, env, timeoutMs: 20_000 }));
  assert.equal(checked.clean, true, 'the parity workflow must check clean before any run');
  assert.deepEqual(checked.findings ?? [], [], 'the parity workflow carries no finding');

  await owned.run('npm', ['run', 'build'], { cwd: root, env, timeoutMs: 120_000 });
  const [packed] = JSON.parse(await owned.run('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', scratch,
  ], { cwd: root, env, timeoutMs: 60_000 }));
  const tarball = path.join(scratch, packed.filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true}\n');
  await owned.run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional',
    '--offline', tarball], { cwd: consumer, env, timeoutMs: 120_000 });
  copyFileSync(path.join(root, 'scripts/input-parity/consumer-scenario.cjs'),
    path.join(consumer, 'consumer-scenario.cjs'));
  writeFileSync(path.join(consumer, 'consumer.cjs'), [
    "const sdk = require('@supernovae-st/nika');",
    "const action = require('./consumer-scenario.cjs');",
    "const config = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));",
    'action(sdk, config).then((row) => process.stdout.write(JSON.stringify(row)));',
    '',
  ].join('\n'));
  writeFileSync(path.join(consumer, 'consumer.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "import * as sdk from '@supernovae-st/nika';",
    "import action from './consumer-scenario.cjs';",
    "const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
    'process.stdout.write(JSON.stringify(await action(sdk, config)));',
    '',
  ].join('\n'));

  server = await resident(binary, project, 'state');
  assert(server.health.supportedCapabilities.includes('jobInputs'),
    `the resident must advertise jobInputs: ${server.health.supportedCapabilities}`);

  // Measure the unmodified SDK against this resident before anything adapts:
  // an engine ahead of the pinned wire is a finding, never a silent workaround.
  observation = await sdk({
    case: 'unadapted-http-observation', door: 'http', moduleSystem: 'esm', url: server.url,
    workflow: WORKFLOW_NAME, options: { inputs: REQUIRED_INPUTS },
    idempotencyKey: 'unadapted-http-observation',
  });
  const observable = observation.outcome === 'settled';
  if (!observable) {
    assert.equal(observation.error, 'NikaProtocolError',
      `unadapted HTTP run failed for another reason: ${JSON.stringify(observation)}`);
    assert.deepEqual(observation.requests.map((request) => `${request.method} ${request.path}`).slice(0, 2),
      ['GET /health', 'POST /v1/jobs'], 'the map was negotiated and admitted before observation failed');
    assert(requestedDropFields.length > 0,
      `this SDK cannot observe this resident (${observation.message}); name the additive fields in `
      + 'NIKA_INPUT_PARITY_DROP_FIELDS to qualify the inputs contract around that drift');
    dropFields = requestedDropFields;
  }

  for (const moduleSystem of ['esm', 'cjs']) {
    for (const scenario of ENGINE_CASES) {
      process.stderr.write(`input-parity ${moduleSystem}: ${scenario.name}\n`);
      const pair = {};
      for (const door of ['native', 'http']) {
        const before = journals();
        const row = await sdk({
          case: scenario.name, door, moduleSystem, url: server.url,
          workflow: WORKFLOW_NAME, options: { inputs: scenario.inputs },
          idempotencyKey: `${moduleSystem}-${scenario.name}`,
        });
        pair[door] = await judged(row, scenario, before);
      }
      // Parity is the claim: the two transports agree, not merely each passes.
      assert.equal(pair.native.outcome, pair.http.outcome, `${scenario.name}: outcome parity`);
      if (scenario.expect.outcome === 'settled') {
        assert.deepEqual(pair.native.outputs, pair.http.outputs, `${scenario.name}: outputs parity`);
        assert.deepEqual(pair.native.origins, pair.http.origins, `${scenario.name}: origin parity`);
      } else {
        assert.equal(pair.native.code, pair.http.code, `${scenario.name}: refusal code parity`);
      }
    }

    for (const scenario of SDK_CASES) {
      process.stderr.write(`input-parity ${moduleSystem}: ${scenario.name}\n`);
      for (const door of ['native', 'http']) {
        const before = journals();
        const row = await sdk({
          case: scenario.name, door, moduleSystem, url: server.url,
          workflow: WORKFLOW_NAME, options: scenario.options,
          idempotencyKey: `${moduleSystem}-${scenario.name}`,
        });
        assert.equal(row.outcome, 'refused', `${scenario.name} ${door}: refused`);
        assert.equal(row.error, scenario.expect.error, `${scenario.name} ${door}: error class`);
        assert.equal(row.typed.configuration, true, `${scenario.name} ${door}: instanceof`);
        assert(row.message.includes(scenario.expect.message), `${scenario.name} ${door}: ${row.message}`);
        assert.deepEqual(row.requests, [], `${scenario.name} ${door}: nothing was requested`);
        assert.deepEqual(journals(), before, `${scenario.name} ${door}: no run exists`);
        rows.push(row);
      }
    }

    // A snapshot froze its inputs: the SDK refuses the overlay, the empty one
    // too, before it captures a snapshot or sends a byte.
    for (const [name, inputs] of [['a-snapshot-takes-no-overlay', REQUIRED_INPUTS],
      ['a-snapshot-takes-no-empty-overlay', {}]]) {
      const before = journals();
      const row = await sdk({
        case: name, door: 'http', moduleSystem, url: server.url,
        workflow: `./${WORKFLOW_NAME}`, options: { inputs },
        idempotencyKey: `${moduleSystem}-${name}`,
      });
      assert.equal(row.error, 'NikaCompatibilityError', `${name}: ${row.message}`);
      assert.equal(row.capability, 'snapshotInputs');
      assert.deepEqual(row.requests, [], `${name}: nothing was requested`);
      assert.deepEqual(journals(), before, `${name}: no run exists`);
      rows.push(row);
    }

    // The deprecated alias is still the operator channel, which is exactly why
    // it is no fallback: the same text resolves the environment there.
    const aliased = await sdk({
      case: 'the-vars-alias-stays-the-operator-channel', door: 'native', moduleSystem,
      workflow: WORKFLOW_NAME, options: { vars: {
        ticket: `@env:${ENV_CANARY.name}`, count: 42, tags: '["é","東京"]', record: '{"name":"🦋"}',
      } },
    });
    assert.equal(aliased.status, 'succeeded', `vars alias: ${JSON.stringify(aliased)}`);
    assert.equal(aliased.outputs.value.ticket, ENV_CANARY.value, 'the operator channel reads @env:');
    assert.equal(aliased.origins.ticket, 'env', 'and says so in its provenance');
    assert.equal(aliased.origins.count, 'cli-operator');
    rows.push(aliased);
  }

  let oldEngine;
  if (oldBinary) {
    oldEngine = await probe(oldBinary);
    assert(!oldEngine.sdk_identity.supportedCapabilities.includes('inputsLiteral'),
      'NIKA_OLD_BIN must be an engine from before the literal channel');
    oldServer = await resident(oldBinary, oldProject, 'old-state');
    assert(!oldServer.health.supportedCapabilities.includes('jobInputs'),
      'NIKA_OLD_BIN must serve a resident from before named inputs');
    const oldTraces = path.join(oldProject, '.nika/traces');
    for (const moduleSystem of ['esm', 'cjs']) {
      const before = journals(oldTraces);
      const native = await sdk({
        case: 'an-engine-without-inputsLiteral', door: 'native', moduleSystem, bin: oldBinary,
        project: oldProject, workflow: WORKFLOW_NAME, options: { inputs: REQUIRED_INPUTS },
      });
      assert.equal(native.error, 'NikaCompatibilityError', JSON.stringify(native));
      assert.equal(native.typed.compatibility, true);
      assert.equal(native.capability, 'inputsLiteral');
      assert(native.message.includes(oldEngine.sdk_identity.engineVersion), native.message);
      const http = await sdk({
        case: 'a-resident-without-jobInputs', door: 'http', moduleSystem, url: oldServer.url,
        project: oldProject, workflow: WORKFLOW_NAME, options: { inputs: REQUIRED_INPUTS },
        idempotencyKey: `${moduleSystem}-old-resident`,
      });
      assert.equal(http.error, 'NikaCompatibilityError', JSON.stringify(http));
      assert.equal(http.typed.compatibility, true);
      assert.equal(http.capability, 'jobInputs');
      assert.deepEqual(http.requests.map((request) => `${request.method} ${request.path}`),
        ['GET /health'], 'an old resident is refused after /health alone: no POST');
      assert.deepEqual(journals(oldTraces), before, 'an old producer admits no run');
      rows.push(native, http);
    }
    // Why the capability is the negotiation: what that resident does with the
    // field when a client sends it anyway. Recorded as measured, never asserted.
    const raw = await fetch(`${oldServer.url}/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Idempotency-Key': 'raw-old-resident-probe' },
      body: JSON.stringify({ workflow: WORKFLOW_NAME, inputs: REQUIRED_INPUTS }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    });
    oldEngine.raw_inputs_post = { status: raw.status, body: await raw.json().catch(() => null) };
    // If it took the job, what did the job do with values it never bound?
    const rawId = oldEngine.raw_inputs_post.body?.id;
    const until = performance.now() + 15_000;
    while (typeof rawId === 'string' && performance.now() < until) {
      const durable = await (await fetch(`${oldServer.url}/v1/jobs/${rawId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
      })).json();
      oldEngine.raw_inputs_job = { status: durable.status, error: durable.error ?? null,
        outputs: durable.outputs ?? null };
      if (!['queued', 'running'].includes(durable.status)) break;
      await delay(100);
    }
  }

  assert.equal(await sha256(binary), engine.binary_sha256, 'engine artifact changed during proof');
  abort.signal.throwIfAborted();
  // One function decides what this run may claim; it also stamps every row.
  verdict = parityVerdict({ dropFields, rows });
  report = {
    result: verdict.result,
    qualifies: verdict.qualifies,
    headline: verdict.headline,
    observed_rows: verdict.rows,
    evidence_kind: 'development npm-pack parity against an explicit engine binary',
    provenance: 'not attested by this script; the engine is whatever NIKA_BIN named',
    engine,
    old_engine: oldEngine ?? null,
    resident_health: server.health,
    old_resident_health: oldServer?.health ?? null,
    packed: { filename: packed.filename, version: packed.version, shasum: packed.shasum,
      integrity: packed.integrity, tarball_sha256: await sha256(tarball) },
    workflow: { name: WORKFLOW_NAME, sha256: createHash('sha256').update(WORKFLOW).digest('hex'),
      effects: 'nika:jq only · no model seat · no network · native ceiling $0' },
    coverage: { module_systems: ['esm', 'cjs'], transports: ['native-process', 'http'],
      engine_cases: ENGINE_CASES.length, sdk_cases: SDK_CASES.length,
      old_producer: Boolean(oldBinary), rows: rows.length },
    // What the UNMODIFIED SDK saw from this resident, before any adapter.
    http_observation_unadapted: observation,
    projection_adapter: dropFields.length === 0
      ? { used: false }
      : { used: true, drop_fields: dropFields,
          scope: 'responses under /v1/jobs/ only; no request is ever touched',
          meaning: 'HTTP rows prove the inputs contract AROUND a wire drift this SDK refuses; '
            + 'they are not unmodified-SDK observation of this engine',
          dropped_total: rows.reduce((total, row) => total + Object.values(
            row.projection_adapter?.dropped ?? {}).reduce((sum, count) => sum + count, 0), 0) },
    rows,
  };
} catch (error) {
  for (const [label, handle] of [['resident', server], ['old resident', oldServer]]) {
    if (handle) process.stderr.write(`${label} diagnostics:\n${handle.process.stdout}\n${handle.process.stderr}\n`);
  }
  throw error;
} finally {
  clearTimeout(deadline);
  try {
    try {
      try { await stopResident(server?.process); }
      finally { await stopResident(oldServer?.process); }
    } finally { await owned.close(); }
    if (cleanupError) throw cleanupError;
    rmSync(scratch, { recursive: true, force: true });
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  } catch (error) {
    process.stderr.write(`cleanup incomplete; retained owned scratch directory ${scratch}\n`);
    throw error;
  }
}
// A green artifact is only emitted AFTER owned processes are gone and their
// scratch directory has been removed.
abort.signal.throwIfAborted();
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
// The headline is the verdict's, never composed here: an adapted run cannot
// print the word a qualifying run prints, and it cannot exit 0.
console.log(verdict.headline);
console.log(`  ${ENGINE_CASES.length} engine cases on 2 transports × 2 module systems · old producer `
  + `${oldBinary ? 'refused' : 'not supplied'} · ${report.engine.version}`);
if (!verdict.qualifies) {
  console.log(`  unmodified SDK against this resident: ${observation.error}: ${observation.message}`);
  console.log(`  adapter removed ${report.projection_adapter.dropped_total} fields from responses; `
    + 'no request was touched');
}
process.exitCode = verdict.exitCode;

/** Judge one row against its case, and bind an HTTP run to its journal for provenance. */
async function judged(row, scenario, before) {
  const label = `${scenario.name} ${row.door} ${row.module_system}`;
  const { expect } = scenario;
  assert.equal(row.outcome, expect.outcome, `${label}: ${JSON.stringify(row).slice(0, 600)}`);
  if (expect.outcome === 'settled') {
    assert.equal(row.status, expect.status, label);
    assert.equal(row.succeeded, true, label);
    assert.deepEqual(row.outputs, digested(expect.outputs), `${label}: outputs are the literal values`);
    if (row.door === 'http') {
      assert.deepEqual(row.requests.map((request) => `${request.method} ${request.path}`).slice(0, 2),
        ['GET /health', 'POST /v1/jobs'], `${label}: negotiated, then admitted`);
      row.origins = await journalOrigins(row.execution_id, label);
    }
    assert.deepEqual(row.origins, expect.origins, `${label}: provenance`);
  } else {
    assert.equal(row.error, expect.error, `${label}: ${row.message}`);
    assert.equal(row.typed.operation, true, `${label}: instanceof NikaOperationError`);
    assert.equal(row.code, expect.code, `${label}: ${row.message}`);
    assert.equal(row.machine_code, expect.code, label);
    assert.equal(row.status, row.door === 'native' ? 3 : 422, `${label}: refusal status`);
    // Refused before admission: neither transport left a run behind.
    assert.deepEqual(journals(), before, `${label}: no run exists`);
  }
  rows.push(row);
  return row;
}

function journals(directory = traces) {
  return existsSync(directory)
    ? readdirSync(directory).filter((file) => file.endsWith('.ndjson')).sort()
    : [];
}

/**
 * A supervisor read of its own scratch journal, not an SDK capability: the
 * resident's public projection carries no provenance, its journal does. Bound
 * by the full execution identity of the receipt.
 */
async function journalOrigins(executionId, label) {
  assert(typeof executionId === 'string' && executionId.length > 4, `${label}: receipt execution_id`);
  const until = performance.now() + 5_000;
  do {
    for (const file of journals()) {
      const lines = readFileSync(path.join(traces, file), 'utf8').trim().split('\n');
      const started = lines.map((line) => JSON.parse(line))
        .find((frame) => frame.kind === 'workflow_started'
          && frame.execution?.uuid === executionId.slice(4));
      const origins = started?.fields?.find((field) => field.key === 'inputs')?.value;
      if (origins) return JSON.parse(origins);
    }
    await delay(50);
  } while (performance.now() < until);
  throw new Error(`${label}: no journal carries execution ${executionId}`);
}

async function resident(command, cwd, state) {
  const handle = owned.start(command, ['serve', '--bind', '127.0.0.1:0', '--workflows', cwd,
    '--token-file', path.join(scratch, 'token'), '--state-root', path.join(scratch, state), '--plain'],
  { cwd, env, timeoutMs: 300_000 });
  let url;
  const until = performance.now() + 15_000;
  while (!url && performance.now() < until) {
    abort.signal.throwIfAborted();
    assert.equal(handle.child.exitCode, null, `resident exited: ${handle.stdout}\n${handle.stderr}`);
    url = `${handle.stdout}\n${handle.stderr}`
      .match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) await delay(25);
  }
  assert(url, `resident never announced its listener: ${handle.stdout}\n${handle.stderr}`);
  await waitForHealth(url, handle, abort.signal, { timeoutMs: 10_000 });
  const health = await (await fetch(`${url}/health`, { signal: abort.signal })).json();
  return { process: handle, url, health };
}

async function sdk(config) {
  abort.signal.throwIfAborted();
  const configPath = path.join(consumer, `request-${configSequence += 1}.json`);
  writeFileSync(configPath, JSON.stringify({ bin: binary, project, token,
    ...(config.door === 'http' && dropFields.length > 0 ? { dropFields } : {}), ...config }));
  const entry = config.moduleSystem === 'cjs' ? 'consumer.cjs' : 'consumer.mjs';
  return JSON.parse(await owned.run(process.execPath, [path.join(consumer, entry), configPath],
    { cwd: consumer, env, timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 }));
}

async function probe(command) {
  const options = { cwd: scratch, env, timeoutMs: 15_000 };
  return {
    version: (await owned.run(command, ['--version'], options)).trim(),
    sdk_identity: JSON.parse(await owned.run(command, ['--sdk-identity'], options)),
    binary_sha256: await sha256(command),
  };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
