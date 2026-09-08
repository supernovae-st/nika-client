import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { OwnedProcesses } from '../scripts/one-door/process.mjs';
import { CancellationRendezvous } from '../scripts/one-door/cancellation.mjs';
import { compareResult, compareSameJobResult, compareControlledCancellation, verdict } from '../scripts/one-door/contract.mjs';

test('cancellation rendezvous holds the task until explicit release and observes dependent effects', async () => {
  const gate = await CancellationRendezvous.listen();
  try {
    const control = gate.arm('test');
    await assert.rejects(gate.release(), /held/);
    let completed = false;
    const task = fetch(`${gate.url}/hold`).then(async (response) => { completed = true; return response.json(); });
    await gate.arrived;
    assert.equal(completed, false);
    assert.equal((await fetch(`${control}/arrived`)).status, 200);
    assert.equal((await fetch(`${control}/release`, { method: 'POST' })).status, 200);
    assert.deepEqual(await task, { held: true });
    assert.deepEqual(gate.finish().requests, { hold: 1, dependent: 0 });
    gate.arm('bad-dependent');
    const second = fetch(`${gate.url}/hold`);
    await gate.arrived;
    await gate.release();
    await (await second).text();
    await (await fetch(`${gate.url}/dependent`)).text();
    assert.throws(() => gate.finish(), /dependent/);
  } finally { await gate.close(); }
});

test('controlled cancellation requires a completed in-flight task and an unstarted dependent', () => {
  const result = { status: 'cancelled', cause: 'operator',
    tasks: { total: 2, ok: 1, cancelled: 1, never_started: 1, failed: 0, recovered: 0, skipped: 0 },
    spend: { qualifier: 'unmetered', priced_calls: 0, unpriced_calls: 0 }, outputs: {} };
  compareControlledCancellation(result);
  for (const changed of [
    { ...result, status: 'succeeded', cause: 'normal' },
    { ...result, tasks: { ...result.tasks, never_started: 0 } },
    { ...result, tasks: { ...result.tasks, ok: 0 } },
    { ...result, tasks: { ...result.tasks, cancelled: 0 } },
  ]) assert.throws(() => compareControlledCancellation(changed));
});

test('a missing rendezvous fails on its deadline instead of releasing the fixture', async () => {
  const gate = await CancellationRendezvous.listen();
  try {
    gate.arm('missing task', 25);
    await assert.rejects(gate.arrived, /deadline exceeded/);
    await assert.rejects(gate.release(), /held/);
    assert.throws(() => gate.finish(), /deadline exceeded/);
  } finally { await gate.close(); }
});

test('closing a held rendezvous rejects the request and closes its listener', async () => {
  const gate = await CancellationRendezvous.listen();
  gate.arm('cleanup');
  const task = fetch(`${gate.url}/hold`);
  const failedTask = assert.rejects(task);
  await gate.arrived;
  await gate.close();
  await failedTask;
  await assert.rejects(fetch(`${gate.url}/hold`));
});

test('same-job comparison rejects fabricated cancellation and preserves a racing success or failure', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const actual = { status, settlement: { status, cause: status === 'succeeded' ? 'normal' :
      status === 'failed' ? 'task_failed' : 'operator', elapsed_ms: 19, tasks: { total: 1 },
      spend: { qualifier: 'unmetered' } } };
    const event = { kind: 'execution.settled', ...structuredClone(actual) };
    compareSameJobResult(actual, event);
    const fabricated = structuredClone(actual);
    fabricated.status = status === 'cancelled' ? 'succeeded' : 'cancelled';
    fabricated.settlement.status = fabricated.status;
    assert.throws(() => compareSameJobResult(fabricated, event), /same-job/);
    delete actual.settlement;
    assert.throws(() => compareSameJobResult(actual, event), /same-job/);
  }
});

test('consumer cancellation lane rejects fabricated cancellation and lost actual settlement', { timeout: 10000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'one-door-cancellation-mutation-'));
  const packageRoot = path.join(scratch, 'node_modules/@supernovae-st/nika-client');
  const owned = new OwnedProcesses();
  const env = { ...process.env };
  delete env.NIKA_BIN;
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@supernovae-st/nika-client',
      version: '0.118.1', type: 'module', exports: { '.': './index.js', './package.json': './package.json' } }));
    // Test double for both the SDK and gate control: release is an explicit
    // promise rendezvous, with no engine, installation, network, or sleep.
    writeFileSync(path.join(packageRoot, 'index.js'), `
      import { readFileSync } from 'node:fs';
      const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      globalThis.fetch = async (url) => {
        if (url.endsWith('/release')) release();
        return { ok: true, text: async () => '{}' };
      };
      export class Nika {
        async run() { return { id: 'same-job', done: held.then(() => config.result) }; }
        async cancel() { return { accepted: true, status: 'cancellation_requested' }; }
        async *events() { await held; yield config.event; }
        async attachRun() { return { done: Promise.resolve(config.attached) }; }
      }
    `);
    for (const file of ['consumer.mjs', 'contract.mjs']) {
      copyFileSync(new URL(`../scripts/one-door/${file}`, import.meta.url), path.join(scratch, file));
    }
    const settlement = { status: 'cancelled', cause: 'operator', elapsed_ms: 41,
      tasks: { total: 2, ok: 1, failed: 0, recovered: 0, skipped: 0, cancelled: 1, never_started: 1 },
      spend: { qualifier: 'unmetered', priced_calls: 0, unpriced_calls: 0 } };
    const result = { status: 'cancelled', settlement, receipt: { execution_id: 'same-execution' } };
    const event = { ...result, kind: 'execution.cancelled', sequence: 1 };
    const config = { action: 'run', name: 'cancelled', door: 'sdk-name', version: '0.118.1',
      consumer: scratch, absentBinary: path.join(scratch, 'no-binary'), cancellationControl: 'test://control',
      expected: verdict(result), result: structuredClone(result), event: structuredClone(event),
      attached: structuredClone(result) };
    const configPath = path.join(scratch, 'request.json');
    const run = async (value) => {
      writeFileSync(configPath, JSON.stringify(value));
      return owned.run(process.execPath, [path.join(scratch, 'consumer.mjs'), configPath],
        { cwd: scratch, env, timeoutMs: 2000 });
    };
    await run(config);
    for (const boundary of ['result', 'event', 'attached']) {
      const lost = structuredClone(config);
      delete lost[boundary].settlement;
      await assert.rejects(run(lost), /settlement|terminal|same-job/, `${boundary}: missing actual settlement`);
      const changed = structuredClone(config);
      changed[boundary].settlement.elapsed_ms = 0;
      await assert.rejects(run(changed), /same-job/, `${boundary}: changed actual settlement`);
    }
    for (const status of ['succeeded', 'failed']) {
      const fabricated = structuredClone(config);
      // SDK run.done falsely claims cancelled while the engine event says
      // success/failure. The accepted action receipt cannot make it green.
      fabricated.event.status = fabricated.event.settlement.status = status;
      fabricated.event.kind = 'execution.settled';
      fabricated.event.outputs = {};
      await assert.rejects(run(fabricated), /terminal event/, `fabricated cancelled over ${status}`);
    }
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

const terminal = { status: 'failed', cause: 'task_failed', tasks: { total: 1, failed: 1 },
  spend: { qualifier: 'unmetered' }, outputs: { answer: { retained: true } },
  error: { code: 'NIKA-1234', task: 'named_failure', message: 'private text' } };

test('comparator rejects missing or changed workflow outputs', () => {
  const expected = verdict(terminal);
  const missing = structuredClone(terminal);
  delete missing.outputs;
  assert.throws(() => compareResult(missing, expected));
  assert.throws(() => compareResult({ ...terminal, outputs: {} }, expected));
  assert.throws(() => compareResult({ ...terminal, outputs: { answer: { retained: false } } }, expected));
});

test('comparator rejects dropped and changed named error tasks but permits redacted prose', () => {
  const expected = verdict(terminal);
  assert.throws(() => compareResult({ ...terminal, error: { code: terminal.error.code } }, expected));
  assert.throws(() => compareResult({ ...terminal, error: { ...terminal.error, task: 'wrong_task' } }, expected));
  compareResult({ ...terminal, error: { ...terminal.error, message: '[redacted]' } }, expected);
  const { cause, tasks, spend, error, ...fields } = terminal;
  compareResult({ ...fields, settlement: { status: fields.status, cause, tasks, spend, error } }, expected);
});

const fullSettlement = { status: terminal.status, cause: terminal.cause,
  elapsed_ms: 17, tasks: terminal.tasks, spend: terminal.spend,
  error: { ...terminal.error, future_diagnostic: { message: 'engine detail' } },
  future_detail: { revision: 1, diagnostic: { message: 'keep this detail' } } };
const originalResult = { id: 'same-job', status: terminal.status, settlement: fullSettlement,
  error: fullSettlement.error, outputs: terminal.outputs, receipt: { execution_id: 'same-execution' } };
const settlementMutations = [
  ['dropped elapsed_ms', (result) => { delete result.settlement.elapsed_ms; }],
  ['changed elapsed_ms', (result) => { result.settlement.elapsed_ms = 0; }],
  ['dropped diagnostic message', (result) => { delete result.settlement.error.message; }],
  ['changed diagnostic message', (result) => { result.settlement.error.message = '[redacted again]'; }],
  ['dropped additive field', (result) => { delete result.settlement.future_detail; }],
  ['changed additive field', (result) => { result.settlement.future_detail.diagnostic.message = 'changed'; }],
];

test('native flat projection preserves optional presence without copying event metadata', () => {
  const event = { kind: 'run_settled', ...terminal, elapsed_ms: 17, sequence: 42 };
  const { outputs, sequence, kind, ...settlement } = event;
  const result = { status: event.status, settlement, error: event.error };
  compareSameJobResult(result, event);
  for (const field of ['elapsed_ms', 'error']) {
    const absentEvent = structuredClone(event);
    delete absentEvent[field];
    const absentResult = structuredClone(result);
    delete absentResult.settlement[field];
    if (field === 'error') delete absentResult.error;
    compareSameJobResult(absentResult, absentEvent);
    const added = structuredClone(absentResult);
    added.settlement[field] = undefined;
    assert.throws(() => compareSameJobResult(added, absentEvent), /same-job/);
    const explicitEvent = { ...absentEvent, [field]: undefined };
    const explicitResult = structuredClone(added);
    if (field === 'error') explicitResult.error = undefined;
    compareSameJobResult(explicitResult, explicitEvent);
    assert.throws(() => compareSameJobResult(absentResult, explicitEvent), /same-job/);
  }
});

test.each(settlementMutations)('same-job comparator rejects %s in HTTP settlements', (label, mutate) => {
  const changed = structuredClone(originalResult);
  mutate(changed);
  compareResult(changed, verdict(originalResult));
  const httpEvent = { kind: 'execution.settled', status: terminal.status, settlement: fullSettlement };
  compareSameJobResult(structuredClone(originalResult), httpEvent);
  assert.throws(() => compareSameJobResult(changed, httpEvent), /same-job/);
  // Unknown top-level native event keys are not settlement fields. Their
  // nested counterparts inside known fields still compare in full.
  const { future_detail, ...nativeSettlement } = fullSettlement;
  const nativeEvent = { kind: 'run_settled', ...nativeSettlement };
  const nativeResult = { ...originalResult, settlement: nativeSettlement };
  compareSameJobResult(structuredClone(nativeResult), nativeEvent);
  if (!label.includes('additive field')) {
    const nativeChanged = structuredClone(nativeResult);
    mutate(nativeChanged);
    assert.throws(() => compareSameJobResult(nativeChanged, nativeEvent), /same-job/);
  }
});

test('same-job comparator checks the separate error copy and all additive diagnostic fields', () => {
  for (const mutate of [
    (result) => { delete result.error; },
    (result) => { result.error.message = 'changed outer message'; },
    (result) => { delete result.error.future_diagnostic; },
    (result) => { result.error.future_diagnostic.message = 'changed outer detail'; },
    (result) => { delete result.settlement.error.future_diagnostic; },
  ]) {
    const changed = structuredClone(originalResult);
    changed.error = structuredClone(changed.error); // Mutate only one copy.
    mutate(changed);
    assert.throws(() => compareSameJobResult(changed, originalResult), /same-job/);
  }
});

test.each(['event', 'attach', 'replay'])('consumer rejects same-job settlement loss at %s', { timeout: 10000 }, async (boundary) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'one-door-settlement-test-'));
  const packageRoot = path.join(scratch, 'node_modules/@supernovae-st/nika-client');
  const owned = new OwnedProcesses();
  const env = { ...process.env };
  delete env.NIKA_BIN;
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@supernovae-st/nika-client',
      version: '0.118.1', type: 'module', exports: { '.': './index.js', './package.json': './package.json' } }));
    // A transport double only: no engine, build, npm install, or network.
    writeFileSync(path.join(packageRoot, 'index.js'), `
      import { readFileSync } from 'node:fs';
      const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      let runs = 0;
      const changedResult = () => config.mutateOriginal
        ? Object.assign(config.original, config.changed) : config.changed;
      export class Nika {
        async run() {
          const changed = config.boundary === 'event' || (config.boundary === 'replay' && ++runs > 1);
          return { id: 'same-job', done: Promise.resolve(changed ? changedResult() : config.original) };
        }
        async *events() {
          yield config.event;
          if (config.mutateOriginal && config.boundary === 'event') Object.assign(config.event.settlement, config.changed.settlement);
        }
        async attachRun() { return { done: Promise.resolve(config.boundary === 'attach' ? changedResult() : config.original) }; }
      }
    `);
    for (const file of ['consumer.mjs', 'contract.mjs']) {
      copyFileSync(new URL(`../scripts/one-door/${file}`, import.meta.url), path.join(scratch, file));
    }
    const configPath = path.join(scratch, 'request.json');
    const config = { boundary, action: boundary === 'replay' ? 'replay' : 'execute',
      name: 'failed', door: 'sdk-name', version: '0.118.1', consumer: scratch, project: scratch,
      absentBinary: path.join(scratch, 'no-binary'), expected: verdict(originalResult), original: originalResult,
      event: { kind: 'execution.settled', sequence: 1, status: terminal.status,
        settlement: fullSettlement, outputs: terminal.outputs } };
    const run = async (changed, mutateOriginal = false) => {
      writeFileSync(configPath, JSON.stringify({ ...config, changed, mutateOriginal }));
      return owned.run(process.execPath, [path.join(scratch, 'consumer.mjs'), configPath],
        { cwd: scratch, env, timeoutMs: 2000 });
    };
    await run(structuredClone(originalResult));
    for (const [label, mutate] of settlementMutations) {
      const changed = structuredClone(originalResult);
      mutate(changed);
      // These differences remain valid between separate executions.
      compareResult(changed, config.expected, label);
      await assert.rejects(run(changed), /same-job/, `${boundary}: ${label}`);
    }
    const changed = structuredClone(originalResult);
    changed.settlement.elapsed_ms = 0;
    await assert.rejects(run(changed, true), /same-job/, `${boundary}: mutation must not rewrite the original observation`);
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('supervisor refuses a subprocess without a finite deadline', async () => {
  const owned = new OwnedProcesses();
  assert.throws(() => owned.start(process.execPath, ['-e', '']), /finite timeout/);
  await owned.close();
});

function gone(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', `process ${pid} must be reaped`);
}

test('timeout reaps a consumer and its native-like child before deleting scratch', { timeout: 6000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'one-door-supervision-test-'));
  const marker = path.join(scratch, 'reaped');
  const owned = new OwnedProcesses();
  let handle;
  try {
    handle = owned.start(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(JSON.stringify({ parent: process.pid, child: child.pid }));
      process.on('SIGTERM', () => {});
      child.on('close', () => { writeFileSync(${JSON.stringify(marker)}, 'child reaped'); process.exit(0); });
    `], { timeoutMs: 500, graceMs: 1000, killMs: 1000 });
    await assert.rejects(handle.done, /timed out/);
    const pids = JSON.parse(handle.stdout);
    gone(pids.parent);
    gone(pids.child);
    assert(existsSync(marker), 'scratch remained available until the child was reaped');
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('timeout escalates an uncooperative owned child to KILL and awaits exit', { timeout: 6000 }, async () => {
  const owned = new OwnedProcesses();
  const handle = owned.start(process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"],
    { timeoutMs: 500, graceMs: 100, killMs: 1000 });
  try {
    await assert.rejects(handle.done, /timed out/);
    gone(Number(handle.stdout.trim()));
    assert.equal(handle.child.signalCode, 'SIGKILL');
  } finally { await owned.close(); }
});

test('supervisor bounds output and preserves unrelated owned groups until explicitly closed', { timeout: 6000 }, async () => {
  const owned = new OwnedProcesses();
  const unrelated = owned.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 5000 });
  const noisy = owned.start(process.execPath, ['-e', "console.log('x'.repeat(10000)); setInterval(() => {}, 1000)"],
    { timeoutMs: 2000, maxBuffer: 100 });
  try {
    await assert.rejects(noisy.done, /exceeded/);
    assert.equal(process.kill(unrelated.child.pid, 0), true, 'cleanup selected only the noisy group');
  } finally { await owned.close(); }
  gone(unrelated.child.pid);
});

test('consumer uses installed bare exports and rejects a malformed export despite valid dist code', { timeout: 6000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'one-door-export-test-'));
  const packageRoot = path.join(scratch, 'node_modules/@supernovae-st/nika-client');
  const owned = new OwnedProcesses();
  const env = { ...process.env };
  delete env.NIKA_BIN;
  try {
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(packageRoot, 'dist/index.js'), 'export class Nika { async listWorkflows() { return []; } }\n');
    for (const file of ['consumer.mjs', 'contract.mjs']) {
      copyFileSync(new URL(`../scripts/one-door/${file}`, import.meta.url), path.join(scratch, file));
    }
    const manifest = { name: '@supernovae-st/nika-client', version: '0.118.1', type: 'module',
      exports: { '.': './dist/index.js', './package.json': './package.json' } };
    const config = path.join(scratch, 'request.json');
    writeFileSync(config, JSON.stringify({ action: 'catalog', names: [], door: 'sdk-name', version: manifest.version,
      consumer: scratch, absentBinary: path.join(scratch, 'no-binary') }));
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
    const args = [path.join(scratch, 'consumer.mjs'), config];
    const options = { cwd: scratch, env, timeoutMs: 2000 };
    assert.equal(JSON.parse(await owned.run(process.execPath, args, options)).installed_package.version, manifest.version);
    manifest.exports['.'] = './missing-public-export.js';
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(owned.run(process.execPath, args, options), /ERR_MODULE_NOT_FOUND/);
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a failed invocation invalidates a prior green report before engine validation', { timeout: 6000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'one-door-stale-report-test-'));
  const report = path.join(scratch, 'report.json');
  writeFileSync(report, '{"result":"green"}');
  const owned = new OwnedProcesses();
  try {
    const result = await owned.start(process.execPath,
      [new URL('../scripts/run-one-door-e2e.mjs', import.meta.url).pathname],
      { env: { ...process.env, NIKA_BIN: 'relative-is-invalid', NIKA_ONE_DOOR_REPORT: report }, timeoutMs: 2000 }).done;
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).result, 'incomplete');
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
