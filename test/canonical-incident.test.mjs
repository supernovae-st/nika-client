import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { OwnedProcesses } from '../scripts/one-door/process.mjs';
import { bounded, collectRunEvents } from '../scripts/gauntlet-cancellation.mjs';
import { assertAppIdentity, executeProjectApp, stageDepthProject } from '../scripts/run-depth-projects.mjs';
import { exerciseIncident, stopIncidentServer, waitForHealthyServer } from '../gauntlet/projects-depth/incident-response-controller/app.mjs';

test('depth runner does not substitute a second incident application', () => {
  const runner = readFileSync(new URL('../scripts/run-depth-projects.mjs', import.meta.url), 'utf8');
  assert(!runner.includes('gauntlet-depth-incident.mjs'), 'execute the committed app, not a replacement');
});

test('a failed depth invocation invalidates its previous green report', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'depth-failure-proof-'));
  const owned = new OwnedProcesses();
  const report = path.join(scratch, 'depth-projects.json');
  try {
    writeFileSync(report, JSON.stringify({ summary: { result: 'green' } }));
    writeFileSync(path.join(scratch, 'npm'), `#!${process.execPath}\nprocess.exitCode = 13;\n`, { mode: 0o755 });
    const result = await owned.start(process.execPath,
      [new URL('../scripts/run-depth-projects.mjs', import.meta.url).pathname],
      { timeoutMs: 3000, env: { PATH: scratch, HOME: scratch, NIKA_KEYCHAIN: 'off',
        NIKA_BIN: process.execPath, NIKA_GAUNTLET_RESULTS_DIR: scratch } }).done;
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    const failed = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(failed.summary.result, 'red');
    assert.match(failed.error, /npm failed \(13/);
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the committed incident app uses the shared controlled cancellation primitive', () => {
  const app = readFileSync(new URL('../gauntlet/projects-depth/incident-response-controller/app.mjs', import.meta.url), 'utf8');
  assert(app.includes('../../../scripts/gauntlet-cancellation.mjs'));
  assert(!app.includes('setTimeout(resolve, 250)'));
});

test('the executed file independently reports the same bytes as its source and provenance', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'canonical-incident-identity-'));
  const owned = new OwnedProcesses();
  try {
    const source = path.join(scratch, 'source');
    const project = path.join(scratch, 'gauntlet', 'projects-depth', 'fixture');
    mkdirSync(source);
    const app = `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ actual_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') }));
`;
    writeFileSync(path.join(source, 'app.mjs'), app);
    writeFileSync(path.join(source, 'package.json'), '{"type":"module"}');
    const identity = stageDepthProject(source, project, path.join(scratch, 'fixture.tgz'));
    const { result, identity: executed } = await executeProjectApp(source, project, '/unused-test-engine', owned.start.bind(owned));
    assert.equal(result.actual_sha256, createHash('sha256').update(app).digest('hex'));
    assert.deepEqual(executed, identity);
    assert.equal(executed.source_sha256, result.actual_sha256);
    assert.equal(executed.executed_sha256, result.actual_sha256);
    writeFileSync(path.join(project, 'app.mjs'), `${app}\n// hidden substitution\n`);
    assert.throws(() => assertAppIdentity(source, project), /byte-identical/);
    let launched = false;
    await assert.rejects(executeProjectApp(source, project, '/unused', () => { launched = true; }), /byte-identical/);
    assert.equal(launched, false);
  } finally {
    await owned.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

const fakeServer = () => ({
  stdout: 'nika serve: listening http://127.0.0.1:12345\n', stderr: '',
  child: { exitCode: null, signalCode: null }, done: new Promise(() => {}),
});

test('a listening URL with perpetually unhealthy responses never passes readiness', async () => {
  let attempts = 0;
  let cancelledBodies = 0;
  await assert.rejects(waitForHealthyServer(fakeServer(), {
    timeoutMs: 60, pollMs: 5, fetchTimeoutMs: 10,
    fetchImpl: async () => { attempts++; return { ok: false, body: { cancel: async () => { cancelledBodies++; } } }; },
  }), /health/);
  assert(attempts > 0);
  assert.equal(cancelledBodies, attempts);
});

test('a stalled health fetch is bounded and its request is aborted', async () => {
  const signals = [];
  await assert.rejects(waitForHealthyServer(fakeServer(), {
    timeoutMs: 60, pollMs: 5, fetchTimeoutMs: 10,
    fetchImpl: (_url, { signal }) => { signals.push(signal); return new Promise(() => {}); },
  }), /health/);
  assert(signals.length > 0);
  assert(signals.every((signal) => signal.aborted));
});

test('readiness requires a successful health response and consumes its body', async () => {
  let attempts = 0;
  let bodies = 0;
  const url = await waitForHealthyServer(fakeServer(), { timeoutMs: 500, pollMs: 1,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return { ok: ++attempts === 2, body: { cancel: async () => { bodies++; } } };
    },
  });
  assert.equal(url, 'http://127.0.0.1:12345');
  assert.equal(attempts, 2);
  assert.equal(bodies, 2);
});

test('readiness fails immediately when the owned server exits', async () => {
  const server = fakeServer();
  server.done = Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'failed' });
  server.child.exitCode = 1;
  await assert.rejects(waitForHealthyServer(server, { fetchImpl: async () => new Promise(() => {}) }), /exited before health/);
});

test('a SIGKILL result cannot count as healthy server cleanup', async () => {
  const signals = [];
  await assert.rejects(stopIncidentServer({ signal: (signal) => signals.push(signal),
    done: Promise.resolve({ code: null, signal: 'SIGKILL' }), stop: async () => {} }), /did not exit cleanly/);
  assert.deepEqual(signals, ['SIGINT']);
});

test('failed graceful cleanup escalates and reaps an uncooperative owned process, then rejects', { timeout: 5000 }, async () => {
  const owned = new OwnedProcesses();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const server = owned.start(process.execPath, ['-e',
    "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
  { timeoutMs: 3000, graceMs: 30, killMs: 1000, onStdout: () => ready() });
  try {
    await bounded(started, 1000, 'test child ready');
    await assert.rejects(stopIncidentServer(server, 30), /graceful shutdown/);
    assert.equal(server.child.signalCode, 'SIGKILL');
    assert.throws(() => process.kill(server.child.pid, 0), (error) => error.code === 'ESRCH');
  } finally { await owned.close(); }
});

test('shared event collection bounds both count and serialized output', async () => {
  const client = { async *events() { for (let index = 0; index < 4; index++) yield { value: 'abc' }; } };
  await assert.rejects(collectRunEvents(client, {}, undefined, { maxEvents: 3 }), /event output exceeded/);
  await assert.rejects(collectRunEvents(client, {}, undefined, { maxBytes: 10 }), /event output exceeded/);
});

test.each([
  (result) => { result.status = 'failed'; },
  (result) => { result.outputs.plan.incident.id = 'different'; },
  (result) => { result.outputs.plan.breached = 2; },
  (result) => { result.outputs.completion.state = 'unfinished'; },
  (result) => { result.outputs.plan_digest = 'not-a-digest'; },
])('the original incident workflow output checks must pass before controlled cancellation', async (mutate) => {
  const result = { status: 'succeeded', outputs: { plan: { incident: { id: 'inc-2042' }, breached: 3 },
    completion: { state: 'reassessed' }, plan_digest: 'a'.repeat(64) } };
  mutate(result);
  const workflows = [];
  const client = { check: async () => ({ clean: true }), run: async (workflow) => {
    workflows.push(workflow); return { done: Promise.resolve(result) };
  } };
  await assert.rejects(exerciseIncident(client, { arm() { assert.fail('cancellation must not start'); } }));
  assert.deepEqual(workflows, ['workflow.nika.yaml']);
});
