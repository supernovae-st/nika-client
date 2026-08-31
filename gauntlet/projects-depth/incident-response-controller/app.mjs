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
  const events = [];
  const observed = (async () => { for await (const event of nika.events(run)) events.push(event.kind ?? 'unknown'); })();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const firstCancel = nika.cancel(run);
  assert.equal(nika.cancel(run), firstCancel);
  const [cancellation, result] = await Promise.all([firstCancel, run.done, observed]).then(([cancel, settled]) => [cancel, settled]);
  assert.equal(cancellation.accepted, true);
  assert.equal(result.status, 'cancelled');
  assert(result.receipt);
  const remoteProof = await nika.traceVerify(result.receipt);
  assert.equal(remoteProof.verified, false);
  assert.equal(remoteProof.verdict, 'unavailable');
  assert.equal(remoteProof.reason, 'trace_journal_unavailable');

  console.log(JSON.stringify({
    project: 'incident-response-controller',
    status: 'succeeded',
    cancelled_run_status: result.status,
    cancellation_idempotent: true,
    cancellation_status: cancellation.status,
    sse_event_kinds: [...new Set(events)].sort(),
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
