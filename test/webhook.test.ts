import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyWebhookSignature } from '../src/webhook.js';
import * as crypto from 'node:crypto';

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = 'whsec_test_secret_key_2026';

async function sign(payload: string, secret: string, timestamp?: number): Promise<string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(signedPayload);
  const signature = hmac.digest('hex');

  return `t=${ts},v1=${signature}`;
}

describe('verifyWebhookSignature', () => {
  it('verifies a valid signature', async () => {
    const payload = '{"job_id":"abc","status":"completed","output":"done"}';
    const header = await sign(payload, SECRET);

    const result = await verifyWebhookSignature(payload, header, SECRET);
    expect(result).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const payload = '{"job_id":"abc","status":"completed","output":"done"}';
    const header = await sign(payload, SECRET);

    const tampered = '{"job_id":"abc","status":"failed","output":"hacked"}';
    const result = await verifyWebhookSignature(tampered, header, SECRET);
    expect(result).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const payload = '{"job_id":"abc","status":"completed"}';
    const header = await sign(payload, SECRET);

    const result = await verifyWebhookSignature(payload, header, 'wrong-secret');
    expect(result).toBe(false);
  });

  it('rejects an expired timestamp', async () => {
    const payload = '{"job_id":"abc"}';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const header = await sign(payload, SECRET, oldTimestamp);

    const result = await verifyWebhookSignature(payload, header, SECRET, 300);
    expect(result).toBe(false);
  });

  it('accepts a timestamp within tolerance', async () => {
    const payload = '{"job_id":"abc"}';
    const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 minute ago
    const header = await sign(payload, SECRET, recentTimestamp);

    const result = await verifyWebhookSignature(payload, header, SECRET, 300);
    expect(result).toBe(true);
  });

  it('rejects malformed signature header', async () => {
    const payload = '{}';

    expect(await verifyWebhookSignature(payload, '', SECRET)).toBe(false);
    expect(await verifyWebhookSignature(payload, 'garbage', SECRET)).toBe(false);
    expect(await verifyWebhookSignature(payload, 't=abc,v1=def', SECRET)).toBe(false);
    expect(await verifyWebhookSignature(payload, 't=123', SECRET)).toBe(false);
    expect(await verifyWebhookSignature(payload, 'v1=abc', SECRET)).toBe(false);
  });
});
