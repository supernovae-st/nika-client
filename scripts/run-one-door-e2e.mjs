import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedProcesses } from './one-door/process.mjs';
import { CancellationRendezvous } from './one-door/cancellation.mjs';
import { compareResult, compareSameJobResult, compareControlledCancellation, cancellationFixture, fixtures, identity, settlementFacts, verdict } from './one-door/contract.mjs';

// Public npm mode installs its native payload and resolves the package's bare
// export inside a fresh consumer. Artifact provenance is an OUTER gate, not a
// conclusion obtainable from this runtime parity exercise.
const root = path.resolve(import.meta.dirname, '..');
const reportPath = process.env.NIKA_ONE_DOOR_REPORT;
// Invalidate a prior green before validation or installation can fail.
if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ result: 'incomplete', pid: process.pid })}\n`);
const binary = process.env.NIKA_BIN;
assert(binary && path.isAbsolute(binary), 'NIKA_BIN must be an absolute CLI/resident engine path');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const publicVersion = process.env.NIKA_PUBLIC_SDK_VERSION;
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-one-door-e2e-'));
const project = path.join(scratch, 'project');
const consumer = path.join(scratch, 'consumer');
const absentBinary = path.join(scratch, 'deliberately-absent-nika');
const token = 'one-door-public-contract-test-token-0123456789';
// No inherited provider credentials, proxy configuration, engine config,
// or signing keys. Public npm mode needs no login either.
const env = { ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM']
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
  HOME: path.join(scratch, 'home'), NIKA_KEYCHAIN: 'off' };
const consumerEnv = { ...env };
delete consumerEnv.NIKA_BIN;
const owned = new OwnedProcesses();
const abort = new AbortController();
let cleanupError;
function stopProof(reason) {
  abort.abort(new Error(reason));
  void owned.close().catch((error) => { cleanupError = error; });
}
const signalHandlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => stopProof(`one-door received ${signal}`)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const deadline = setTimeout(() => stopProof('one-door overall deadline exceeded (180s)'), 180_000);
let url;
let server;
let configSequence = 0;
let report;
let cancellationGate;
const rows = [];
const traces = [];

try {
  mkdirSync(project);
  mkdirSync(consumer);
  mkdirSync(env.HOME);
  cancellationGate = await CancellationRendezvous.listen();
  const workflows = { ...fixtures, cancelled: cancellationFixture(cancellationGate.url) };
  writeFileSync(path.join(project, 'nika.yaml'), 'nika: one-door-e2e\n');
  for (const [name, yaml] of Object.entries(workflows)) writeFileSync(path.join(project, `${name}.nika.yaml`), yaml);
  writeFileSync(path.join(scratch, 'token'), `${token}\n`, { mode: 0o600 });
  const engine = await probe(binary, env);
  engine.binary_sha256 = await sha256(binary);
  assert.equal(engine.sdk_identity.engineVersion, version, 'CLI/resident release train');
  if (publicVersion) {
    assert.equal(publicVersion, version, 'public SDK and repository release train');
    assert.match(engine.version, new RegExp(`^nika ${version.replaceAll('.', '\\.')} \\([0-9a-f]+\\)$`));
  }
  let dependency = `@supernovae-st/nika-client@${publicVersion}`;
  if (!publicVersion) {
    await owned.run('npm', ['run', 'build'], { cwd: root, env, timeoutMs: 60_000 });
    const [packed] = JSON.parse(await owned.run('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', scratch,
    ], { cwd: root, env, timeoutMs: 30_000 }));
    dependency = path.join(scratch, packed.filename);
  }
  writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  await owned.run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    ...(publicVersion ? [] : ['--omit=optional', '--offline']), dependency,
  ], { cwd: consumer, env: consumerEnv, timeoutMs: 60_000 });
  for (const file of ['consumer.mjs', 'contract.mjs']) {
    copyFileSync(path.join(root, 'scripts/one-door', file), path.join(consumer, file));
  }
  // This public bin shim resolves the same packaged engine as native Nika().
  // It receives no override in npm mode, and cannot fall back to the repo binary.
  const nativeEngine = publicVersion
    ? await probe(path.join(consumer, 'node_modules/.bin/nika'), consumerEnv)
    : engine;
  const nativePackage = `@supernovae-st/nika-${process.platform}-${process.arch}`;
  const nativeBinary = publicVersion ? path.join(consumer, 'node_modules', nativePackage, 'bin/nika') : binary;
  if (publicVersion) {
    nativeEngine.native_package = nativePackage;
    nativeEngine.binary_path = nativeBinary;
    nativeEngine.binary_sha256 = await sha256(nativeBinary);
  }
  assert.equal(nativeEngine.sdk_identity.engineVersion, version, 'native payload release train');
  assert.deepEqual(nativeEngine.sdk_identity, engine.sdk_identity, 'native payload and CLI/resident identity vector');
  if (publicVersion) {
    assert.equal(nativeEngine.binary_sha256, engine.binary_sha256,
      'public npm native payload must be the exact same-platform released CLI binary');
  }
  const installedLock = JSON.parse(readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
  const installedPackages = Object.entries(installedLock.packages)
    .filter(([key]) => key.startsWith('node_modules/@supernovae-st/nika-') && existsSync(path.join(consumer, key)))
    .map(([key, value]) => ({ path: key, version: value.version, resolved: value.resolved,
      integrity: value.integrity ?? null }));

  server = owned.start(binary, ['serve', '--bind', '127.0.0.1:0', '--workflows', project,
    '--token-file', path.join(scratch, 'token'), '--state-root', path.join(scratch, 'state'), '--plain'],
  { cwd: project, env, timeoutMs: 180_000 });
  let healthy = false;
  const listenerDeadline = performance.now() + 10_000;
  while (performance.now() < listenerDeadline) {
    abort.signal.throwIfAborted();
    assert.equal(server.child.exitCode, null, `resident exited: ${server.stdout}\n${server.stderr}`);
    url = `${server.stdout}\n${server.stderr}`.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) {
      try { healthy = (await request('/health', {}, 1000)).ok; }
      catch (error) { abort.signal.throwIfAborted(); }
      if (healthy) break;
    }
    await delay(25);
  }
  assert(healthy, `resident listener/health unavailable: ${server.stdout}\n${server.stderr}`);
  assert(!existsSync(absentBinary));
  for (const name of Object.keys(workflows)) assert(!existsSync(path.join(consumer, `${name}.nika.yaml`)));
  const catalog = await sdk({ action: 'catalog', names: Object.keys(workflows), door: 'sdk-name' });
  const expectations = {};
  for (const [name, expectedStatus, expectedExit] of [
    ['clean', 'succeeded', 0], ['failed', 'failed', 1], ['recovered', 'succeeded', 0],
    ['paused', 'paused', 4], ['cancelled', 'cancelled', 130],
  ]) {
    process.stderr.write(`one-door scenario: ${name}\n`);
    const file = `${name}.nika.yaml`;
    const ordinary = await cli(['check', file, '--json'], 0);
    assert.equal(ordinary.execution_snapshot, undefined, 'snapshot export must stay opt-in');
    const captured = await cli(['check', file, '--json', '--sdk-snapshot'], 0);
    assert.equal(typeof captured.execution_snapshot, 'string');
    let cancellationSent = false;
    if (name === 'cancelled') cancellationGate.arm('cli');
    const cliRun = await cli(['run', file, '--json', '--max-cost-usd', '0.01'], expectedExit, true,
      name === 'cancelled' ? async (handle) => {
        await cancellationGate.arrived;
        cancellationSent = handle.signal('SIGTERM');
        assert(cancellationSent, 'CLI signal accepted while task held');
        await cancellationGate.release();
      } : undefined);
    const settled = cliRun.find((frame) => frame.kind === 'run_settled');
    const expected = verdict(settled);
    expectations[name] = expected;
    assert.equal(expected.status, expectedStatus);
    if (name === 'failed') assert.equal(expected.error_task, 'a', 'named failed task');
    if (name === 'clean' || name === 'recovered') assert(Object.keys(expected.outputs).length > 0, 'nonempty workflow outputs');
    if (name === 'cancelled') compareControlledCancellation(settled);
    rows.push({ scenario: name, door: 'cli', ...expected, ...identity(settled),
      original_terminal: settled,
      ...(cancellationSent ? { acknowledgement: { signal_sent: true }, cancellation: cancellationGate.finish() } : {}) });
    const trace = await cli(['trace', 'outputs', settled.receipt.trace_path, '--json'], 0);
    compareSameJobResult({ kind: 'execution.settled', status: trace.settlement.status,
      settlement: trace.settlement }, settled, `same-execution trace settlement: ${name}`);
    traces.push({ scenario: name, door: 'cli', settlement: settlementFacts(trace.settlement),
      exact_settlement: trace.settlement, same_job_settlement_compared: true,
      workflow_outputs_compared: false, reason: 'trace outputs exposes per-task data, not workflow outputs' });
    for (const [door, body] of [
      ['http-name', JSON.stringify({ workflow: file })], ['http-snapshot', captured.execution_snapshot],
    ]) {
      if (name === 'cancelled') cancellationGate.arm(door);
      const response = await request('/v1/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${name}-${door}` }, body,
      });
      assert(response.ok, `${door} admission: ${await response.clone().text()}`);
      const job = await response.json();
      const { terminal, acknowledgement } = await httpEvents(job.id, name === 'cancelled', `${door}: ${name}`);
      compareResult(terminal, expected, `${door}: ${name}`);
      const durable = await compareDurable(job.id, terminal, `${door}: ${name}`);
      if (name === 'cancelled') {
        compareControlledCancellation(terminal);
        await compareTrace(name, door, terminal);
      }
      rows.push({ scenario: name, door, ...verdict(terminal), ...identity(terminal), acknowledgement,
        original_terminal: terminal, durable_job: durable, same_job_get_compared: true,
        ...(name === 'cancelled' ? { cancellation: cancellationGate.finish() } : {}) });
    }
    for (const door of ['sdk-native', 'sdk-name', 'sdk-snapshot']) {
      const cancellationControl = name === 'cancelled' ? cancellationGate.arm(door) : undefined;
      const row = await sdk({ action: 'run', name, door, expected, cancellationControl });
      if (door !== 'sdk-native') {
        row.durable_job = await compareDurable(row.original_result.id, row.terminal_event, `${door}: ${name}`);
        row.same_job_get_compared = true;
      }
      if (name === 'cancelled') {
        await compareTrace(name, door, row.original_result);
        row.cancellation = cancellationGate.finish();
      }
      rows.push(row);
    }
  }
  const replay = await sdk({ action: 'replay', door: 'sdk-name', expected: expectations.clean });
  assert.equal(await sha256(binary), engine.binary_sha256, 'CLI/resident artifact changed during proof');
  assert.equal(await sha256(nativeBinary), nativeEngine.binary_sha256, 'native artifact changed during proof');
  abort.signal.throwIfAborted();
  report = { result: 'green', evidence_kind: publicVersion ? 'installed public npm runtime parity' : 'development npm-pack parity',
    provenance: 'not attested by this script; public provenance requires the root outer gate',
    cli_resident_engine: engine, sdk_native_engine: nativeEngine,
    native_resolution: publicVersion ? 'installed public package, no NIKA_BIN override' : 'explicit development binary',
    installed_package: catalog.installed_package, installed_packages: installedPackages, rows, traces, replay,
    cancellation_fixture: { source: workflows.cancelled,
      sha256: createHash('sha256').update(workflows.cancelled).digest('hex'),
      deadline_ms: 10_000, timeout_behavior: 'fail; never release on a timer',
      network: 'owned loopback HTTP only; development npm install uses --offline',
      credentials: 'fresh HOME, NIKA_KEYCHAIN=off, no inherited provider or proxy environment' },
    coverage: { execution_doors: 6, scenarios: 5, terminal_cursor_attach: true,
      cancellation: 'controlled loopback fetch rendezvous on all six doors; cancellation requested while held, then release; exact cancelled/operator tally requires one completed task and one unstarted dependent',
      cancellation_race: 'success racing a request remains valid engine behavior; this controlled fixture must cancel, and mutation tests reject fabricating cancellation or losing an actual settlement',
      same_job: 'full settlements: CLI event/trace on all scenarios; SDK event/result on all scenarios and terminal attach on HTTP; raw GET/event on all HTTP jobs; event/result/trace across all six controlled cancellation executions',
      outputs: 'complete maps; absent optional outputs equal an empty set only for non-success states, with presence recorded',
      paused: 'terminal observation only; resumability is not asserted' } };
} catch (error) {
  if (server) process.stderr.write(`resident diagnostics:\n${server.stdout}\n${server.stderr}\n`);
  throw error;
} finally {
  clearTimeout(deadline);
  try {
    try { await owned.close(); }
    finally { await cancellationGate?.close(); }
    if (cleanupError) throw cleanupError;
    rmSync(scratch, { recursive: true, force: true });
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  } catch (error) {
    process.stderr.write(`cleanup incomplete; retained owned scratch directory ${scratch}\n`);
    throw error;
  }
}
// A green artifact is only emitted AFTER owned processes (including native
// descendants) are gone and their scratch directory has been removed.
abort.signal.throwIfAborted();
if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`one-door green: 5 scenarios, 6 execution doors; ${report.evidence_kind} (${report.cli_resident_engine.version})`);

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function probe(command, childEnv) {
  const options = { cwd: consumer, env: childEnv, timeoutMs: 15_000 };
  return { command, version: (await owned.run(command, ['--version'], options)).trim(),
    sdk_identity: JSON.parse(await owned.run(command, ['--sdk-identity'], options)) };
}

async function sdk(config) {
  abort.signal.throwIfAborted();
  const configPath = path.join(consumer, `request-${configSequence++}.json`);
  writeFileSync(configPath, JSON.stringify({ version, publicVersion, url, token, project,
    consumer, binary, absentBinary, ...config }));
  return JSON.parse(await owned.run(process.execPath, [path.join(consumer, 'consumer.mjs'), configPath],
    { cwd: consumer, env: consumerEnv, timeoutMs: 25_000 }));
}

async function cli(args, expectedExit, ndjson = false, onStarted) {
  abort.signal.throwIfAborted();
  const handle = owned.start(binary, [...args, '--plain'], { cwd: project, env, timeoutMs: 20_000 });
  const [result] = await Promise.all([handle.done, onStarted?.(handle)]);
  assert.equal(result.code, expectedExit, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return ndjson ? result.stdout.trim().split('\n').map((line) => JSON.parse(line)) : JSON.parse(result.stdout);
}

function request(route, options = {}, timeout = 15_000) {
  return fetch(`${url}${route}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]) });
}

async function httpEvents(id, cancel, label) {
  const events = await request(`/v1/jobs/${id}/events`);
  assert(events.ok && events.body, 'HTTP event stream');
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let terminal;
  let acknowledgement;
  const cancellation = cancel ? (async () => {
    await cancellationGate.arrived;
    assert(!terminal, 'cancel while the runtime task is held');
    const response = await request(`/v1/jobs/${id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 202, 'controlled fixture must exercise pending HTTP cancellation');
    acknowledgement = { http_status: response.status, body: await response.json() };
    assert.equal(acknowledgement.body.status, 'running', 'pending acknowledgement is not a settlement');
    assert.equal(acknowledgement.body.settlement, undefined, 'pending acknowledgement has no settlement');
    assert(!terminal, 'pending acknowledgement precedes terminal observation');
    await cancellationGate.release();
  })() : undefined;
  cancellation?.catch(() => {});
  let bytes = 0;
  const observed = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert(bytes < 4 * 1024 * 1024, 'bounded HTTP event stream');
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const frame = JSON.parse(line.slice(5));
        observed.push(frame);
        if (frame.kind === 'execution.settled'
          || (cancel && frame.kind === 'execution.cancelled' && frame.settlement)) terminal = frame;
      }
      if (terminal) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  assert(terminal, `${label}: HTTP must emit its own terminal settlement: ${JSON.stringify(observed)}`);
  await cancellation;
  if (cancel) assert(acknowledgement, 'observed HTTP cancellation acknowledgement');
  return { terminal, acknowledgement };
}

async function compareDurable(id, terminal, label) {
  const response = await request(`/v1/jobs/${id}`);
  assert.equal(response.status, 200);
  const durable = await response.json();
  assert.equal(durable.id, id);
  // GET's legacy top-level error is a code/message summary. As with SSE,
  // its full authoritative diagnostic lives inside the settlement object.
  compareSameJobResult({ ...durable, kind: 'execution.settled' }, terminal, `${label} GET/event`);
  assert.deepEqual(durable.outputs, terminal.outputs, `${label} GET output presence and values`);
  assert.deepEqual(durable.receipt, terminal.receipt, `${label} GET receipt`);
  return durable;
}

async function compareTrace(scenario, door, original) {
  const receipt = original.receipt;
  assert(receipt?.execution_id && receipt?.trace_id, 'trace comparison requires the original receipt');
  const directory = path.join(project, '.nika/traces');
  // This is a supervisor read of its own scratch journal, not a remote SDK
  // capability. Bind by full execution identity, never the four-digit name.
  const matches = readdirSync(directory).filter((file) => file.endsWith('.ndjson'))
    .map((file) => path.join(directory, file))
    .filter((file) => readFileSync(file, 'utf8').trim().split('\n')
      .some((line) => JSON.parse(line).execution?.uuid === receipt.execution_id.slice(4)));
  assert.equal(matches.length, 1, `${door}: exactly one journal for the full execution identity`);
  const trace = await cli(['trace', 'outputs', matches[0], '--json'], 0);
  compareSameJobResult({ kind: 'execution.settled', status: trace.settlement?.status,
    settlement: trace.settlement }, original, `${door} same-execution trace settlement`);
  assert.equal(trace.tasks.find((task) => task.id === 'held')?.status, 'ok');
  const dependent = trace.tasks.find((task) => task.id === 'dependent');
  assert.equal(dependent?.status, 'cancelled');
  assert.equal(dependent.verb, null, 'trace has no start verb for the unstarted dependent');
  traces.push({ scenario, door, execution_id: receipt.execution_id, trace_id: receipt.trace_id,
    exact_settlement: trace.settlement, tasks: trace.tasks, same_job_settlement_compared: true,
    workflow_outputs_compared: false, reason: 'trace outputs exposes per-task data, not workflow outputs' });
}
