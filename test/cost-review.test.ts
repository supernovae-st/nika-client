import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaProtocolError } from '../src/index.js';
import type { NikaCostReview } from '../src/index.js';
import { HttpTransport } from '../src/lib/http-transport.js';
import { NativeProcessTransport } from '../src/lib/native-process-transport.js';
import { healthResponse, jsonResponse, sseResponse } from './helpers/http-depth-harness.js';

const id = 'rev-12345678-1234-1234-1234-123456789abc';
const hash = 'a'.repeat(64);
const token = 'review-bearer-public-fixture-0123456789';
const caps = ['check', 'executionSnapshot', 'eventStream', 'costReviewV1', 'jobInputs'];
const request = { workflow: 'daily.nika', inputs: { customer: 'Élodie', count: 2, enabled: false }, access: 'default' };
const review: NikaCostReview = {
  cost_review_version: 1, review_id: id, witness_sha256: hash, state: 'pending',
  created_at: '2026-09-28T00:00:00Z', expires_at: '2026-09-28T00:05:00Z',
  workflow: request.workflow, access: 'default', execution_id: 'execution-test',
  project: { root_fingerprint: null, basis: 'host-local, unauthenticated' },
  program: { snapshot_digest: hash, source_sha256: hash },
  inputs: { names: ['customer', 'count', 'enabled'], source: 'api_caller', sha256: hash },
  route: { provider: 'test', model: 'test', origin: 'https://example.invalid:443' },
  price: { state: 'unknown', native: 'unknown tariff' }, question: 'Authorize one bounded unknown-cost request?',
  bounds: { max_requests: 1, max_output_tokens: 50, request_timeout_seconds: 2, retries: 0 },
  defaults: { invocation_usd: null, project_usd: null, basis: 'no default' },
  host: { authority: 'operator_started_cost_review', evidence: {}, credential_custody: 'HOST_SERVER_MEMORY' },
  prior_journal: { length: 0, sha256: hash }, effects: ['write result'], grants: 'existing permit',
};

function remote(response: (url: string, init?: RequestInit) => Response | Promise<Response>, capabilities = caps) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => String(url).endsWith('/health')
    ? healthResponse({ supportedCapabilities: capabilities }) : response(String(url), init));
  return { fetch, nika: new Nika({ url: 'https://nika.example', token, fetch, bin: '/missing/do-not-spawn' }) };
}

describe('explicit, single-use cost review', () => {
  it('prepares exactly the caller input, without approving or starting a job', async () => {
    const { nika, fetch } = remote(() => jsonResponse(review, 201));
    expect(await nika.prepareCostReview(request, { idempotencyKey: 'prepare-1' })).toEqual(review);
    const [url, init] = fetch.mock.calls[1];
    expect(String(url)).toBe('https://nika.example/v1/cost-reviews');
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('prepare-1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['approved', 'consumed', 'expired'] as const)('preserves a replay in current state %s without renewing it', async state => {
    const { nika, fetch } = remote(() => jsonResponse({ ...review, state }));
    expect(await nika.prepareCostReview(request, { idempotencyKey: 'same-key' })).toMatchObject({ state });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns no-review-required as data and creates no synthetic reference', async () => {
    const result = { cost_review_version: 1, review_required: false, observer: true, reason: 'declared-free' };
    const { nika, fetch } = remote(() => jsonResponse(result));
    expect(await nika.prepareCostReview(request)).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['approve_once', 'decline'] as const)('sends only the explicit %s decision and never runs', async decision => {
    const state = decision === 'decline' ? 'declined' : 'approved';
    const { nika, fetch } = remote(() => jsonResponse({ ...review, state }));
    expect(await nika.decideCostReview(id, { decision, witness_sha256: hash })).toMatchObject({ state });
    expect(String(fetch.mock.calls[1][0]).endsWith(`/v1/cost-reviews/${id}/decision`)).toBe(true);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ decision, witness_sha256: hash });
    expect(fetch.mock.calls[1][1]?.redirect).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads without changing authority', async () => {
    const { nika, fetch } = remote(() => jsonResponse({ ...review, state: 'expired' }));
    expect(await nika.costReview(id)).toMatchObject({ state: 'expired' });
    expect(fetch.mock.calls[1][1]?.method).toBe('GET');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([[404, 'review_unknown'], [409, 'review_witness_mismatch'], [410, 'review_expired'], [422, 'cost_review_refused']])(
    'retains refusal %i %s without retries', async (status, code) => {
      const { nika, fetch } = remote(() => jsonResponse({ error: { code, message: 'explicit refusal' } }, status as number));
      await expect(nika.decideCostReview(id, { decision: 'approve_once', witness_sha256: hash }))
        .rejects.toMatchObject({ name: 'NikaOperationError', operation: 'decideCostReview', status, code });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

  it('does not retry a lost decision response', async () => {
    const { nika, fetch } = remote(() => { throw new Error('connection reset after decision'); });
    await expect(nika.decideCostReview(id, { decision: 'approve_once', witness_sha256: hash }))
      .rejects.toMatchObject({ name: 'NikaTransportError' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { cost_review_version: 1, review_required: false, observer: true, reason: 'none' },
    { ...review, state: 'approved' },
  ])('does not accept invented creation authority in a 201 response', async value => {
    const { nika } = remote(() => jsonResponse(value, 201));
    await expect(nika.prepareCostReview(request)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('snapshots the request before asynchronous identity discovery', async () => {
    let release!: () => void;
    const healthReady = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      if (String(url).endsWith('/health')) { await healthReady; return healthResponse({ supportedCapabilities: caps }); }
      return jsonResponse(review, 201);
    });
    const nika = new Nika({ url: 'https://nika.example', token, fetch });
    const mutable = structuredClone(request);
    const pending = nika.prepareCostReview(mutable);
    mutable.inputs.customer = 'changed after call';
    release();
    await pending;
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual(request);
  });

  it.each(['prepare', 'read', 'decide', 'run'])('refuses missing capability before %s bytes', async op => {
    const { nika, fetch } = remote(() => { throw new Error('must not dispatch'); }, caps.filter(c => c !== 'costReviewV1'));
    const operation = op === 'prepare' ? nika.prepareCostReview(request)
      : op === 'read' ? nika.costReview(id)
        : op === 'decide' ? nika.decideCostReview(id, { decision: 'decline', witness_sha256: hash })
          : nika.run('daily.nika', { costReview: { review_id: id, witness_sha256: hash } });
    await expect(operation).rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...review, witness_sha256: 'invented' }, { ...review, state: 'ready' },
    { ...review, host: {} }, { ...review, inputs: null }, { ...review, bounds: { ...review.bounds, retries: 1 } },
    { ...review, account: { attempts: -1 } }, { ...review, cost_review_version: 2 },
    { ...review, review_id: 'rev-aaaaaaaa-1234-1234-1234-123456789abc' },
    { cost_review_version: 1, review_required: false, observer: true, reason: 'none' },
  ])('rejects malformed or mismatched observed evidence', async malformed => {
    const { nika } = remote(() => jsonResponse(malformed));
    await expect(nika.costReview(id)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('submits the approved reference and exact typed inputs only on explicit run()', async () => {
    const { nika, fetch } = remote(url => url.endsWith('/events')
      ? sseResponse([{ sequence: 1, kind: 'execution.settled', status: 'succeeded' }])
      : jsonResponse({ id: 'job-1', status: 'queued' }, 202));
    const reference = { review_id: id, witness_sha256: hash };
    const run = await nika.run(request.workflow, { inputs: request.inputs, access: request.access, costReview: reference, idempotencyKey: 'job-1' });
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ ...request, cost_review: reference });
    expect(fetch.mock.calls[1][1]?.redirect).toBe('error');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('cost-reviews'))).toHaveLength(0);
  });

  it('refuses inputs on a server without jobInputs instead of dropping them', async () => {
    const { nika, fetch } = remote(() => { throw new Error('must not dispatch'); }, caps.filter(c => c !== 'jobInputs'));
    await expect(nika.run('daily.nika', { inputs: request.inputs })).rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects HTTP-only options before local source capture or process verification', async () => {
    const resolveEngine = vi.fn(() => { throw new Error('must not resolve'); });
    const http = new HttpTransport({ url: 'https://nika.example', token, fetch: vi.fn(), requestTimeout: 100, machineBufferBytes: 4096, resolveEngine });
    await expect(http.startRun('/absolute/workflow.nika', { costReview: { review_id: id, witness_sha256: hash } }))
      .rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(resolveEngine).not.toHaveBeenCalled();
    const native = new NativeProcessTransport({ engine: {} as never, machineBufferBytes: 4096 });
    await expect(native.startRun('daily.nika', { inputs: {} })).rejects.toBeInstanceOf(NikaCompatibilityError);
    await expect(native.prepareCostReview(request, {})).rejects.toBeInstanceOf(NikaCompatibilityError);
  });

  it('honors cancellation before any preparation or decision bytes', async () => {
    const { nika, fetch } = remote(() => { throw new Error('must not dispatch'); });
    const signal = AbortSignal.abort();
    await expect(nika.prepareCostReview(request, { signal })).rejects.toBeDefined();
    await expect(nika.decideCostReview(id, { decision: 'approve_once', witness_sha256: hash }, { signal })).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
