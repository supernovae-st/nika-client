import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Nika } from '../src/index.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseResponse,
} from './helpers/http-depth-harness.js';

const NATIVE_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);

const receipt = {
  job_id: 'job-1',
  execution_id: 'exe-1',
  trace_id: 'trace-1',
  snapshot_digest: 'a'.repeat(64),
  origin: { kind: 'manual' },
};

describe('run identities are the same on every settlement path', () => {
  it('names the execution and trace from the receipt when POST admission had none', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return healthResponse();
      if (url.pathname === '/v1/jobs') return jsonResponse({ id: 'job-1', status: 'queued' }, 202);
      if (url.pathname === '/v1/jobs/job-1/events') {
        return sseResponse([
          { sequence: 1, kind: 'execution.started', status: 'running' },
          {
            sequence: 2,
            kind: 'execution.settled',
            status: 'succeeded',
            outputs: { answer: 1 },
            receipt,
          },
        ]);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const nika = new Nika({
      url: 'https://nika.example',
      token: TOKEN_A,
      bin: HTTP_DEPTH_FIXTURE,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const run = await nika.run('flow.nika.yaml', { idempotencyKey: 'ids-1' });
    const result = await run.done;
    expect(result).toMatchObject({
      status: 'succeeded',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
      receipt,
    });
  });

  it('still refuses a receipt whose identity contradicts the durable record', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return healthResponse();
      if (url.pathname === '/v1/jobs/job-1') {
        return jsonResponse({ id: 'job-1', status: 'running', execution_id: 'exe-other' });
      }
      if (url.pathname === '/v1/jobs/job-1/events') {
        return sseResponse([
          { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt },
        ]);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const nika = new Nika({
      url: 'https://nika.example',
      token: TOKEN_A,
      bin: HTTP_DEPTH_FIXTURE,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const run = await nika.attachRun('job-1');
    await expect(run.done).rejects.toMatchObject({ name: 'NikaProtocolError' });
  });
});

describe('the native trace verdict speaks the HTTP vocabulary', () => {
  const bound = Object.freeze({
    receipt_format: 1,
    execution_id: 'exe-fixture',
    trace_id: 'trace-fixture',
    snapshot_digest: 'snapshot-fixture',
    trace_path: 'fixture-trace.ndjson',
    chain_head: 'fixture-head',
    chain_len: 7,
    sealed: true,
  });

  it('says verified on a receipt the evidence binds', async () => {
    const nika = new Nika({ bin: NATIVE_FIXTURE });
    await expect(nika.traceVerify(bound)).resolves.toMatchObject({
      verified: true,
      verdict: 'verified',
      exitCode: 0,
    });
  });

  it('says invalid with a reason on a receipt the evidence does not bind', async () => {
    const nika = new Nika({ bin: NATIVE_FIXTURE });
    await expect(nika.traceVerify({ ...bound, execution_id: 'other' }))
      .resolves.toMatchObject({ verified: false, verdict: 'invalid', reason: 'receipt_mismatch', exitCode: 2 });
    await expect(nika.traceVerify({ ...bound, trace_path: 'broken-trace.ndjson' }))
      .resolves.toMatchObject({ verified: false, verdict: 'invalid', exitCode: 2 });
  });
});
