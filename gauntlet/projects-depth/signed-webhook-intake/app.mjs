// App-owned signed webhook intake. The application owns HTTP, raw-body
// signature verification and normalization; Nika owns admission, execution,
// idempotency, events and proof. No Nika webhook route, no SDK verifier.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { Nika, NikaConfigurationError, NikaOperationError } from '@supernovae-st/nika';

const engine = process.env.NIKA_BIN;
assert(engine, 'NIKA_BIN is required');
const token = 'depth-intake-token-0123456789abcdef0123456789';
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

// The sender's signing secret (Standard Webhooks `whsec_` form). It lives in
// the application boundary: never in the workflow, never sent to Nika.
const secretBytes = randomBytes(24);
const TOLERANCE_SECONDS = 300;
const sign = (id, timestamp, body) => createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${body}`).digest('base64');

// Verify over the exact received bytes BEFORE any parsing. Failure classes are
// named so a refusal is never "webhook failed".
function verifyStandardWebhook(headers, rawBody, nowSeconds) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signature = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') return { ok: false, failure: 'INGRESS_AUTH' };
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return { ok: false, failure: 'INGRESS_REPLAY' };
  const expected = Buffer.from(sign(id, timestamp, rawBody), 'base64');
  const presented = signature.split(' ').filter((entry) => entry.startsWith('v1,')).map((entry) => Buffer.from(entry.slice(3), 'base64'));
  const matched = presented.some((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected));
  return matched ? { ok: true, id } : { ok: false, failure: 'INGRESS_AUTH' };
}

try {
  await waitForHealth(url);
  const nika = new Nika({ url, token, allowInsecureHttp: true, bin: engine, cwd: process.cwd(), eventBufferSize: 128 });
  assert.equal((await nika.check('workflow.nika')).clean, true);

  const admitted = new Map();
  const ingress = createHttpServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const verdict = verifyStandardWebhook(request.headers, rawBody, Math.floor(Date.now() / 1000));
      if (!verdict.ok) return reply(401, { failure: verdict.failure });
      let payload;
      try { payload = JSON.parse(rawBody); } catch { return reply(400, { failure: 'INGRESS_PARSE' }); }
      // Normalize the sender's shape into the workflow's declared input. The
      // sender delivery id is the idempotency key: stable across retries.
      const object = payload.data?.object ?? {};
      const event = compact({ id: payload.id, type: payload.type, amount: object.amount, currency: object.currency, customer: object.customer });
      let run;
      try {
        run = await nika.run('workflow.nika', { inputs: { event }, idempotencyKey: `webhook-${verdict.id}` });
      } catch (error) {
        // A payload the workflow's declared input refuses (engine 422) and a
        // normalized event that is not strict JSON (SDK refusal before any
        // request) are both mapping defects at this boundary.
        if (error instanceof NikaOperationError && error.status === 422) return reply(422, { failure: 'INPUT_MAPPING', code: error.code });
        if (error instanceof NikaConfigurationError) return reply(422, { failure: 'INPUT_MAPPING', code: 'not_strict_json' });
        return reply(503, { failure: 'ADMISSION', error: error?.constructor?.name, code: error?.code, status: error?.status, message: error instanceof Error ? error.message : String(error) });
      }
      admitted.set(verdict.id, run);
      const result = await run.done;
      return reply(200, { job_id: run.id, status: result.status, decision: result.outputs?.decision });
    } catch (error) {
      return reply(500, { failure: 'RUNTIME', message: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => ingress.listen(0, '127.0.0.1', resolve).once('error', reject));
  const ingressAddress = ingress.address();
  assert(ingressAddress && typeof ingressAddress === 'object');
  const webhookUrl = `http://127.0.0.1:${ingressAddress.port}/webhooks/payments`;

  // The sender: signs id.timestamp.body; a retry keeps the id and body and
  // carries a fresh timestamp and signature (the Stripe and Svix retry law).
  const deliver = (id, body, { timestamp = Math.floor(Date.now() / 1000), signature } = {}) => fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature ?? `v1,${sign(id, timestamp, body)}` },
    body,
  }).then(async (response) => ({ http: response.status, ...(await response.json()) }));

  const paymentBody = JSON.stringify({ id: 'evt_2026_0920_0001', type: 'payment_intent.succeeded', data: { object: { amount: 12000, currency: 'eur', customer: 'cus_42' } } });
  const deliveryId = 'msg_intake_2026_0920_0001';
  const now = Math.floor(Date.now() / 1000);
  const [first, retry] = await Promise.all([
    deliver(deliveryId, paymentBody, { timestamp: now }),
    deliver(deliveryId, paymentBody, { timestamp: now + 1 }),
  ]);
  assert.equal(first.http, 200);
  assert.equal(retry.http, 200);
  assert.equal(first.status, 'succeeded');
  assert.equal(retry.status, 'succeeded');
  assert.equal(first.job_id, retry.job_id, 'a retried delivery must reuse the admitted job');
  assert.equal(first.decision?.tier, 'large');
  assert.equal(first.decision?.review_required, true);

  const tampered = await deliver(deliveryId, paymentBody.replace('12000', '12'), { timestamp: now, signature: `v1,${sign(deliveryId, now, paymentBody)}` });
  assert.deepEqual([tampered.http, tampered.failure], [401, 'INGRESS_AUTH']);
  const stale = await deliver('msg_intake_stale', paymentBody, { timestamp: now - 900 });
  assert.deepEqual([stale.http, stale.failure], [401, 'INGRESS_REPLAY']);
  const malformed = await deliver('msg_intake_malformed', '{"id":"evt_x",');
  assert.deepEqual([malformed.http, malformed.failure], [400, 'INGRESS_PARSE']);
  const mistyped = await deliver('msg_intake_mistyped', JSON.stringify({ id: 'evt_2', type: 'payment_intent.succeeded', data: { object: { amount: '12000', currency: 'eur' } } }));
  assert.deepEqual([mistyped.http, mistyped.failure], [422, 'INPUT_MAPPING'], JSON.stringify(mistyped));
  await new Promise((resolve, reject) => ingress.close((error) => error ? reject(error) : resolve()));

  // Only the signed, well-typed delivery reached Nika; its durable job is the
  // one the retry replayed.
  assert.deepEqual([...admitted.keys()], [deliveryId]);
  const attached = await nika.attachRun(first.job_id);
  assert.equal(await attached.status(), 'succeeded');
  const eventKinds = new Set();
  for await (const event of admitted.get(deliveryId).events()) eventKinds.add(event.kind);

  // Same program, second trigger: a manual SDK run with the same inputs and a
  // fresh caller key is a distinct job with an identical decision.
  const manual = await nika.run('workflow.nika', { inputs: { event: { id: 'evt_manual', type: 'payment_intent.succeeded', amount: 12000, currency: 'eur' } }, idempotencyKey: 'manual-intake-2026-09-20-001' });
  const manualResult = await manual.done;
  assert.equal(manualResult.status, 'succeeded');
  assert.notEqual(manual.id, first.job_id);
  assert.equal(manualResult.outputs?.decision?.tier, 'large');

  // Same program, third trigger: a resident schedule fires it once with the
  // declared default (the heartbeat). The schedule binds the workflow by name
  // at the Serve layer; the workflow bytes are unchanged.
  const fireAt = new Date(Date.now() + 1500).toISOString();
  const scheduled = await nika.schedule('workflow.nika', { id: 'intake-heartbeat', when: { kind: 'once', at: fireAt }, maxCostUsd: 0.000001, missed: 'catch-up-once' });
  assert.equal(scheduled.applied, true);
  let fired;
  for (let attempt = 0; attempt < 240 && !fired; attempt += 1) {
    const status = await nika.scheduleStatus('intake-heartbeat');
    fired = status.lastDecision?.claim?.runId;
    if (!fired) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(fired, 'the once schedule must claim a run');
  const scheduledRun = await nika.attachRun(fired);
  const scheduledResult = await scheduledRun.done;
  assert.equal(scheduledResult.status, 'succeeded');
  assert.equal(scheduledResult.outputs?.decision?.tier, 'heartbeat');
  assert.notEqual(fired, first.job_id);
  assert.notEqual(fired, manual.id);

  console.log(JSON.stringify({
    project: 'signed-webhook-intake',
    status: 'succeeded',
    transport: 'http',
    trigger: 'app-owned-signed-webhook-http',
    signature: 'standard-webhooks hmac-sha256 over raw bytes, 300s tolerance, app-owned',
    duplicate_deliveries: 2,
    idempotent_job_identity: first.job_id === retry.job_id,
    refusals: { tampered: tampered.failure, stale: stale.failure, malformed: malformed.failure, mistyped: mistyped.failure },
    admitted_deliveries: admitted.size,
    // Behavioral verdicts only: a fresh job id per replay is not evidence.
    same_program_triggers: ['webhook', 'manual', 'schedule'],
    distinct_job_identities: new Set([first.job_id, manual.id, fired]).size,
    scheduled_decision_tier: scheduledResult.outputs?.decision?.tier,
    sse_event_kinds: [...eventKinds].sort(),
    deterministic_cost_cap_usd: 0,
  }));
} finally {
  server.kill('SIGINT');
  await Promise.race([new Promise((resolve) => server.once('close', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (server.exitCode && server.exitCode !== 130) throw new Error(`nika serve exited ${server.exitCode}: ${diagnostics.slice(-500)}`);
}

// The normalized event must be strict JSON: an absent optional field is
// omitted, never carried as `undefined`.
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = probe.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nika serve did not become healthy');
}
