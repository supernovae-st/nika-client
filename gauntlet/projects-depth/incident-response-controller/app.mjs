import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { Nika } from '@supernovae-st/nika-client';

const engine = process.env.NIKA_BIN;
assert(engine, 'NIKA_BIN is required');
const token = 'depth-incident-token-0123456789abcdef01234567';
const runtime = path.join(process.cwd(), '.runtime');
await mkdir(runtime, { recursive: true });
const tokenFile = path.join(runtime, 'serve.token');
await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
await chmod(tokenFile, 0o600);
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const server = spawn(engine, ['serve', '--bind', `127.0.0.1:${port}`, '--workflows', '.', '--token-file', tokenFile, '--state-root', path.join(runtime, 'state'), '--plain'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostics = '';
server.stderr.setEncoding('utf8');
server.stderr.on('data', (chunk) => { diagnostics += chunk; });

try {
  await waitForHealth(url);
  const nika = new Nika({ url, token, allowInsecureHttp: true, bin: engine, cwd: process.cwd(), eventBufferSize: 128 });
  assert.equal((await nika.check('workflow.nika.yaml')).clean, true);
  const run = await nika.run('workflow.nika.yaml', { idempotencyKey: 'incident-inc-2042-controller-1' });
  // Cancel the controller inside its stabilization window: the durable status
  // reads `queued` at admission and `running` once the resident owns the
  // execution, and one second later the run is inside its 10 s `nika:wait`.
  // On engine 0.118 a cancel that lands on `running` is a 202
  // `cancellation_requested`; the execution owner then records
  // `execution.interrupted` once its grace expires inside the task, or
  // `cancelled` with `cause: operator` at a task boundary. A cancel that lands
  // on `queued` is a 200 `cancelled` with an `execution.cancelled` terminal.
  // This consumer records the interrupted shape.
  await untilRunning(nika, run);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const statusBeforeCancellation = await nika.status(run);
  assert.equal(statusBeforeCancellation, 'running');
  const firstCancel = nika.cancel(run);
  assert.equal(nika.cancel(run), firstCancel);
  const [cancellation, result] = await Promise.all([firstCancel, run.done]);
  assert.equal(cancellation.accepted, true);
  assert.equal(cancellation.status, 'cancellation_requested');
  assert.equal(result.status, 'interrupted');
  assert(result.receipt);
  const recovered = await nika.attachRun(run.id);
  const events = [];
  for await (const event of nika.events(recovered)) {
    events.push({
      kind: event.kind ?? 'unknown',
      status: event.status,
      ...(event.settlement ? { settlement_cause: event.settlement.cause } : {}),
    });
  }
  await recovered.done;
  const terminal = events.at(-1);
  assert(terminal);
  assert.equal(terminal.kind, 'execution.interrupted');
  assert.equal(terminal.status, result.status);
  const remoteProof = await nika.traceVerify(result.receipt);
  assert.equal(remoteProof.verified, false);
  assert.equal(remoteProof.verdict, 'unavailable');
  assert.equal(remoteProof.reason, 'trace_journal_unavailable');

  console.log(JSON.stringify({
    project: 'incident-response-controller',
    status: 'succeeded',
    status_before_cancellation: statusBeforeCancellation,
    cancelled_run_status: result.status,
    cancellation_idempotent: true,
    cancellation_status: cancellation.status,
    sse_event_kinds: [...new Set(events.map((event) => event.kind))].sort(),
    sse_terminal: terminal,
    remote_receipt_verdict: { verdict: remoteProof.verdict, reason: remoteProof.reason },
    deterministic_cost_cap_usd: 0,
  }));
} finally {
  server.kill('SIGINT');
  await Promise.race([new Promise((resolve) => server.once('close', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (server.exitCode && server.exitCode !== 130) throw new Error(`nika serve exited ${server.exitCode}: ${diagnostics.slice(-500)}`);
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nika serve did not become healthy');
}

async function untilRunning(client, run) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = await client.status(run);
    if (status !== 'queued') return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the resident never took ownership of the execution');
}
