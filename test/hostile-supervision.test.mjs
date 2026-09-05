import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { OwnedProcesses, runOwnedProcess } from '../scripts/one-door/process.mjs';
import { bounded } from '../scripts/gauntlet-cancellation.mjs';
import { observeHostileReplay } from '../scripts/run-hostile-gauntlet.mjs';
import { stopResident, waitForHealth } from '../scripts/one-door/resident.mjs';

const never = () => new Promise(() => {});
const gone = (pid) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

function replay({ events = [], done = Promise.resolve({ status: 'cancelled' }), hang = false } = {}) {
  let closed = false;
  let observedSignal;
  const client = {
    async *events(_run, { signal }) {
      observedSignal = signal;
      try {
        for (const event of events) yield event;
        if (hang && !signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      } finally { closed = true; }
    },
  };
  return { client, run: { done }, get closed() { return closed; }, get signal() { return observedSignal; } };
}

test('hostile replay drains and clones bounded events on success', async () => {
  const event = { kind: 'execution.settled', settlement: { status: 'cancelled' } };
  const f = replay({ events: [event] });
  const proof = await observeHostileReplay(f.client, f.run);
  event.settlement.status = 'failed';
  assert.equal(proof.events[0].settlement.status, 'cancelled');
  assert.equal(proof.replayed.status, 'cancelled');
  assert(f.closed && f.signal.aborted);
});

test('hostile replay deadline aborts and awaits a never-ending subscriber', async () => {
  const f = replay({ hang: true, done: never() });
  await assert.rejects(observeHostileReplay(f.client, f.run, undefined, { timeoutMs: 30 }), /cancel replay settlement exceeded/);
  assert(f.closed && f.signal.aborted);
});

test.each([{ maxEvents: 1 }, { maxBytes: 1 }])('hostile replay caps event output and closes the observer (%j)', async (limits) => {
  const f = replay({ events: [{ kind: 'one' }, { kind: 'two' }], hang: true, done: never() });
  await assert.rejects(observeHostileReplay(f.client, f.run, undefined, { timeoutMs: 200, ...limits }), /run event output exceeded/);
  assert(f.closed && f.signal.aborted);
});

test('hostile replay settlement failure aborts and awaits its subscriber', async () => {
  const f = replay({ hang: true, done: Promise.reject(new Error('actual settlement failed')) });
  await assert.rejects(observeHostileReplay(f.client, f.run), /actual settlement failed/);
  assert(f.closed && f.signal.aborted);
});

test('hostile replay propagates runner abort and awaits the subscriber', async () => {
  const abort = new AbortController();
  const f = replay({ hang: true, done: never() });
  const observed = observeHostileReplay(f.client, f.run, abort.signal);
  abort.abort(new Error('runner stopped'));
  await assert.rejects(observed, /runner stopped/);
  assert(f.closed && f.signal.aborted);
});

test('hostile replay refuses an observer that ignores abort within a cleanup deadline', async () => {
  const client = { events: () => ({ [Symbol.asyncIterator]: () => ({ next: never }) }) };
  await assert.rejects(observeHostileReplay(client, { done: never() }, undefined,
    { timeoutMs: 20, cleanupMs: 20 }), /replay observer cleanup exceeded/);
});

test.each(['hang', 'unhealthy', 'healthy'])('hostile readiness requires successful bounded health (%s)', async (mode) => {
  let requests = 0;
  let connection;
  const http = createServer((_request, response) => {
    requests++;
    if (mode === 'unhealthy') response.writeHead(503).end('not ready');
    if (mode === 'healthy') response.writeHead(200).end('ok');
  });
  http.on('connection', (socket) => { connection = socket; });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const handle = { child: { exitCode: null, signalCode: null }, done: never() };
  try {
    const check = waitForHealth(`http://127.0.0.1:${http.address().port}`, handle, undefined,
      { timeoutMs: 100, requestMs: 25, pollMs: 5 });
    if (mode === 'healthy') await check;
    else await assert.rejects(check, /did not become healthy/);
    assert(requests > 0);
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    assert(!connection || connection.destroyed);
  }
});

test('hostile readiness notices an already exited server', async () => {
  const handle = { child: { exitCode: 0, signalCode: null }, done: Promise.resolve({ code: 0 }) };
  await assert.rejects(waitForHealth('http://127.0.0.1:1', handle), /server exited/);
});

test('hostile server close is observed even when it preceded shutdown', async () => {
  const owned = new OwnedProcesses();
  const handle = owned.start(process.execPath, ['-e', ''], { timeoutMs: 1000 });
  try {
    await handle.done;
    await stopResident(handle, { timeoutMs: 50 });
    gone(handle.child.pid);
  } finally { await owned.close(); }
});

test.each([false, true])('hostile shutdown awaits TERM/KILL fallback and never greens a deadline (ignore TERM: %s)', async (ignoreTerm) => {
  const owned = new OwnedProcesses();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const handle = owned.start(process.execPath, ['-e', `
    process.on('SIGINT', () => {});
    ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
    console.log('ready'); setInterval(() => {}, 1000);
  `], { timeoutMs: 2000, graceMs: 50, killMs: 1000, onStdout: ready });
  try {
    await started;
    await assert.rejects(stopResident(handle, { timeoutMs: 30 }), /server shutdown exceeded/);
    gone(handle.child.pid);
    assert.equal(handle.child.signalCode, ignoreTerm ? 'SIGKILL' : 'SIGTERM');
  } finally { await owned.close(); }
});

test('hostile owned consumer timeout reaps native-like descendants', async () => {
  const owned = new OwnedProcesses();
  let pids;
  try {
    await assert.rejects(runOwnedProcess(owned.start.bind(owned), process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.on('SIGTERM', () => {});
      child.on('close', () => process.exit(0));
      console.log(JSON.stringify({ parent: process.pid, child: child.pid }));
    `], { timeoutMs: 300, graceMs: 1000, killMs: 1000, onStdout: (chunk) => { pids = JSON.parse(chunk); } }), /timed out/);
    gone(pids.parent);
    gone(pids.child);
  } finally { await owned.close(); }
});

test('hostile owned process cannot green a signal exit or excessive output', async () => {
  const owned = new OwnedProcesses();
  try {
    await assert.rejects(runOwnedProcess(owned.start.bind(owned), process.execPath,
      ['-e', "process.kill(process.pid, 'SIGKILL')"], { timeoutMs: 1000 }), /SIGKILL/);
    await assert.rejects(runOwnedProcess(owned.start.bind(owned), process.execPath,
      ['-e', "console.log('x'.repeat(10000))"], { timeoutMs: 1000, maxBuffer: 100 }), /exceeded/);
  } finally { await owned.close(); }
});

test('runner interruption reaps an uncooperative build and replaces stale green with a failed proof', { timeout: 10_000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hostile-runner-test-'));
  const owned = new OwnedProcesses();
  const report = path.join(scratch, 'hostile.json');
  const marker = path.join(scratch, 'build.pid');
  mkdirSync(path.join(scratch, 'home'));
  writeFileSync(report, '{"result":"green"}');
  writeFileSync(path.join(scratch, 'npm'), `#!${process.execPath}
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
  `, { mode: 0o755 });
  // Make the executable extensionless JavaScript unambiguously ESM.
  writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}');
  let retained;
  try {
    const handle = owned.start(process.execPath, [new URL('../scripts/run-hostile-gauntlet.mjs', import.meta.url).pathname],
      { timeoutMs: 7000, graceMs: 2500, env: { PATH: scratch, HOME: path.join(scratch, 'home'),
        NIKA_BIN: process.execPath, NIKA_KEYCHAIN: 'off', NIKA_GAUNTLET_RESULTS_DIR: scratch } });
    await bounded((async () => {
      const until = performance.now() + 1900;
      while (!existsSync(marker) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      assert(existsSync(marker), 'fake build must start');
    })(), 2000, 'fake build startup');
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).result, 'incomplete');
    const buildPid = Number(readFileSync(marker, 'utf8'));
    handle.signal('SIGINT');
    const result = await handle.done;
    retained = result.stderr.match(/hostile cleanup retained scratch: (.+)/)?.[1];
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    const proof = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(proof.result, 'red');
    assert.match(proof.supervision_error, /required SIGKILL/);
    assert(retained && existsSync(retained));
    gone(buildPid);
    gone(handle.child.pid);
  } finally {
    await owned.close();
    if (retained) rmSync(retained, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
