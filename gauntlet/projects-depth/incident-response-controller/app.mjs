import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CancellationRendezvous } from '../../../scripts/one-door/cancellation.mjs';
import { cancellationFixture, compareSameJobResult, settlementFacts } from '../../../scripts/one-door/contract.mjs';
import { OwnedProcesses } from '../../../scripts/one-door/process.mjs';
import { bounded, cancelHeldRun, collectRunEvents } from '../../../scripts/gauntlet-cancellation.mjs';

// The original incident workflow completes its ten-second stabilization wait.
// Cancellation is proved separately at an explicitly held loopback fetch.
export async function exerciseIncident(nika, gate, signal) {
  const step = (promise, ms, label) => bounded(promise, ms, label, signal);
  assert.equal((await step(nika.check('workflow.nika.yaml'), 10_000, 'incident check')).clean, true);
  const original = await step(nika.run('workflow.nika.yaml', { idempotencyKey: 'incident-plan-1' }), 10_000, 'incident admission');
  const projectResult = await step(original.done, 30_000, 'incident workflow completion');
  assert.equal(projectResult.status, 'succeeded');
  assert.equal(projectResult.outputs?.plan?.incident?.id, 'inc-2042');
  assert.equal(projectResult.outputs?.plan?.breached, 3);
  assert.equal(projectResult.outputs?.completion?.state, 'reassessed');
  assert.match(projectResult.outputs?.plan_digest ?? '', /^[0-9a-f]{64}$/);

  gate.arm('depth incident cancellation');
  const run = await step(nika.run('controlled-cancel.nika.yaml', { idempotencyKey: 'incident-cancel-1' }), 10_000, 'controlled admission');
  const { cancellation, result, rendezvous } = await cancelHeldRun(nika, run, gate, signal);
  assert(result.receipt);
  const recovered = await step(nika.attachRun(run.id), 10_000, 'incident reattach');
  const observer = new AbortController();
  const observation = collectRunEvents(nika, recovered, observer.signal);
  observation.catch(() => {});
  let events;
  try {
    const [replayed, frames] = await step(Promise.all([recovered.done, observation]), 10_000, 'incident durable replay');
    events = frames;
    compareSameJobResult(replayed, result, 'incident reattach');
    compareSameJobResult(result, events.at(-1), 'incident durable replay');
  } finally {
    observer.abort();
    await bounded(observation.catch(() => {}), 2_000, 'incident replay observer cleanup');
  }
  const remoteProof = await step(nika.traceVerify(result.receipt), 5_000, 'remote receipt verdict');
  assert.equal(remoteProof.verified, false);
  assert.equal(remoteProof.verdict, 'unavailable');
  assert.equal(remoteProof.reason, 'trace_journal_unavailable');
  return {
    project: 'incident-response-controller', status: 'succeeded',
    project_workflow_status: projectResult.status,
    incident_plan_verified: true,
    cancelled_run_status: result.status,
    cancellation_idempotent: true,
    cancellation_status: cancellation.status,
    sse_event_kinds: [...new Set(events.map((event) => event.kind))].sort(),
    sse_terminal: { kind: events.at(-1).kind, status: events.at(-1).status },
    settlement: settlementFacts(result),
    same_job_terminal_and_replay_matched: true,
    cancellation_rendezvous: rendezvous,
    remote_receipt_verdict: { verdict: remoteProof.verdict, reason: remoteProof.reason },
    deterministic_cost_cap_usd: 0,
  };
}

export async function waitForHealthyServer(server, {
  timeoutMs = 10_000, fetchTimeoutMs = 750, pollMs = 25, fetchImpl = fetch, signal,
} = {}) {
  const deadline = performance.now() + timeoutMs;
  const exited = server.done.then((result) => {
    throw new Error(`incident server exited before health: ${JSON.stringify(result)}`);
  });
  exited.catch(() => {});
  let lastError = 'no listening URL';
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const diagnostics = `${server.stdout}\n${server.stderr}`;
    const url = diagnostics.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) {
      const request = new AbortController();
      const limit = Math.max(1, Math.min(fetchTimeoutMs, deadline - performance.now()));
      try {
        const attempt = (async () => {
          const response = await fetchImpl(`${url}/health`, { signal: request.signal, redirect: 'error' });
          try { return response.ok; } finally { await response.body?.cancel(); }
        })();
        const healthy = await bounded(Promise.race([attempt, exited]), limit, 'incident health request', signal);
        if (healthy) return url;
        lastError = 'health returned a non-success status';
      } catch (error) {
        lastError = error.message;
        if (server.child.exitCode !== null || server.child.signalCode !== null) throw error;
      } finally {
        request.abort();
      }
    }
    await bounded(Promise.race([delay(Math.min(pollMs, Math.max(1, deadline - performance.now()))), exited]),
      Math.max(1, deadline - performance.now()), 'incident health polling', signal);
  }
  throw new Error(`incident health did not succeed within ${timeoutMs}ms: ${lastError}\n${server.stdout}\n${server.stderr}`);
}

export async function stopIncidentServer(server, graceMs = 5_000) {
  server.signal('SIGINT');
  let settled = false;
  try {
    const result = await bounded(server.done, graceMs, 'incident server graceful shutdown');
    settled = true;
    assert((result.signal === null && [0, 130].includes(result.code))
      || (result.signal === 'SIGINT' && result.code === null),
    `incident server did not exit cleanly: ${JSON.stringify(result)}`);
    return { exit_code: result.code, signal: result.signal, forced: false, reaped: true };
  } finally {
    // Even a timeout, rejected done, or unexpected signal must reap the owned
    // process group. Escalation never turns the preceding failure green.
    if (!settled) await server.stop();
    await server.done.catch(() => {});
  }
}

async function main() {
  const engine = process.env.NIKA_BIN;
  assert(engine, 'NIKA_BIN is required');
  const sdkEntry = realpathSync(fileURLToPath(import.meta.resolve('@supernovae-st/nika-client')));
  const installedPackage = path.join(process.cwd(), 'node_modules', '@supernovae-st', 'nika-client');
  assert(sdkEntry.startsWith(`${installedPackage}${path.sep}`), 'SDK must resolve inside this installed npm-pack consumer');
  const { Nika } = await import('@supernovae-st/nika-client');
  const executedAppSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const runtime = path.join(process.cwd(), '.runtime');
  mkdirSync(runtime, { recursive: true });
  const token = 'depth-incident-token-0123456789abcdef01234567';
  const tokenFile = path.join(runtime, 'serve.token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const owned = new OwnedProcesses();
  const abort = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal,
    () => abort.abort(new Error(`incident app received ${signal}`))]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const timer = setTimeout(() => abort.abort(new Error('incident app exceeded 75s')), 75_000);
  let gate;
  let server;
  let report;
  let failure;
  try {
    gate = await CancellationRendezvous.listen();
    writeFileSync('controlled-cancel.nika.yaml', cancellationFixture(gate.url));
    server = owned.start(engine, ['serve', '--bind', '127.0.0.1:0', '--workflows', '.',
      '--token-file', tokenFile, '--state-root', path.join(runtime, 'state'), '--plain'],
    { cwd: process.cwd(), env: process.env, timeoutMs: 85_000, maxBuffer: 64 * 1024 });
    const url = await waitForHealthyServer(server, { signal: abort.signal });
    const nika = new Nika({ url, token, allowInsecureHttp: true, bin: engine,
      cwd: process.cwd(), eventBufferSize: 128 });
    report = await exerciseIncident(nika, gate, abort.signal);
  } catch (error) {
    failure = error;
  } finally {
    abort.abort();
    clearTimeout(timer);
    const cleanup = await Promise.allSettled([
      gate ? bounded(gate.close(), 2_000, 'incident rendezvous cleanup') : undefined,
      server ? stopIncidentServer(server) : undefined,
    ]);
    try { await owned.close(); } catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
    for (const [signal, handler] of handlers) process.off(signal, handler);
    const errors = cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (server?.child.signalCode === 'SIGKILL') errors.push(new Error('incident server required SIGKILL'));
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], 'incident proof or cleanup failed');
    if (!failure) report.server_cleanup = cleanup[1].value;
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ ...report, executed_app_sha256: executedAppSha256,
    sdk_entry: path.relative(process.cwd(), sdkEntry) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await main();
