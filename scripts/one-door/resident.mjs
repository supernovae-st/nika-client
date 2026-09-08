import assert from 'node:assert/strict';
import { bounded } from '../gauntlet-cancellation.mjs';

export async function stopResident(server, { timeoutMs = 5_000 } = {}) {
  if (!server) return;
  let result;
  try {
    // OwnedProcesses installed done/close at spawn time, before any signal.
    server.signal('SIGINT');
    result = await bounded(server.done, timeoutMs, 'server shutdown');
  } finally {
    // A deadline remains a failure even when TERM/KILL successfully reaps it.
    await server.stop();
    await server.done.catch(() => {});
  }
  assert.equal(result.signal, null, `server exited via ${result.signal}`);
  assert([0, 130].includes(result.code), `server exited ${result.code}: ${result.stderr.slice(-500)}`);
}

export async function waitForHealth(url, server, signal,
  { timeoutMs = 5_000, requestMs = 500, pollMs = 25 } = {}) {
  const deadline = performance.now() + timeoutMs;
  const exited = server.done.then(() => { throw new Error(`server exited before readiness: ${server.stderr ?? ''}`); });
  exited.catch(() => {});
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    assert(server.child.exitCode === null && server.child.signalCode === null, 'server exited before readiness');
    const request = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, request.signal]) : request.signal;
    const remaining = Math.max(1, Math.min(requestMs, deadline - performance.now()));
    try {
      const healthy = await bounded(Promise.race([exited, (async () => {
        const response = await fetch(`${url}/health`, { signal: requestSignal });
        await response.body?.cancel();
        return response.ok;
      })()]), remaining, 'server health request', signal);
      signal?.throwIfAborted();
      if (healthy) return;
    } catch {
      signal?.throwIfAborted();
      // Retry startup connection errors and nonresponsive health requests,
      // but only inside the overall readiness deadline.
    } finally { request.abort(); }
    await bounded(new Promise((resolve) => setTimeout(resolve, pollMs)), pollMs + 100, 'health retry', signal);
  }
  throw new Error(`server did not become healthy at ${url} within ${timeoutMs}ms`);
}
