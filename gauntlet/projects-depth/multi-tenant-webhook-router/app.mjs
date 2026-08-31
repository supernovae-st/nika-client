import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { Nika } from '@supernovae-st/nika-client';

const engine = process.env.NIKA_BIN;
assert(engine, 'NIKA_BIN is required');
const token = 'depth-router-token-0123456789abcdef0123456789';
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
  const checked = await nika.check('workflow.nika.yaml');
  assert.equal(checked.clean, true);
  let observedRun;
  const ingress = createHttpServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const delivery = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(delivery.tenants.sort(), ['atlas', 'boreal', 'cirrus']);
      const run = await nika.run('workflow.nika.yaml', { idempotencyKey: `webhook-${delivery.delivery_id}` });
      observedRun ??= run;
      const result = await run.done;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ job_id: run.id, status: result.status, routed_tenants: result.outputs?.manifest?.tenant_count }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => ingress.listen(0, '127.0.0.1', resolve).once('error', reject));
  const ingressAddress = ingress.address();
  assert(ingressAddress && typeof ingressAddress === 'object');
  const webhookUrl = `http://127.0.0.1:${ingressAddress.port}/webhooks/batch`;
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delivery_id: 'delivery-2026-08-31-001', tenants: ['cirrus', 'atlas', 'boreal'] }) };
  const responses = await Promise.all([
    fetch(webhookUrl, request).then((response) => response.json()),
    fetch(webhookUrl, request).then((response) => response.json()),
  ]);
  await new Promise((resolve, reject) => ingress.close((error) => error ? reject(error) : resolve()));
  assert.equal(responses[0].status, 'succeeded');
  assert.equal(responses[1].status, 'succeeded');
  assert.equal(responses[0].job_id, responses[1].job_id);
  assert(observedRun);
  const eventKinds = [];
  for await (const event of nika.events(observedRun)) eventKinds.push(event.kind ?? 'unknown');

  console.log(JSON.stringify({
    project: 'multi-tenant-webhook-router',
    status: 'succeeded',
    transport: 'http',
    trigger: 'real-loopback-webhook-http',
    duplicate_deliveries: 2,
    idempotent_job_identity: responses[0].job_id === responses[1].job_id,
    routed_tenants: responses[0].routed_tenants,
    sse_event_kinds: [...new Set(eventKinds)].sort(),
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
