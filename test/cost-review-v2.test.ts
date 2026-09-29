import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaProtocolError } from '../src/index.js';
import { healthResponse, jsonResponse, sseResponse } from './helpers/http-depth-harness.js';
import { id, hash, token, request, review } from './helpers/cost-review-fixture.js';

const v2 = {
  ...review, cost_review_version: 2,
  bounds: { max_requests: 6, max_in_flight: 2, max_output_tokens: 50,
    request_timeout_seconds: 2, transport_retries: 0 },
  dispatch: { requests: 6, max_in_flight: 2, authored_retry: true,
    tasks: [{ task: 'ask', items: 3, attempts: 2, calls_per_attempt: 1, max_parallel: 2, requests: 6 }] },
};
const caps = ['check', 'executionSnapshot', 'eventStream', 'costReviewV2', 'jobInputs'];
function remote(response: (url: string, init?: RequestInit) => Response | Promise<Response>, capabilities = caps) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => String(url).endsWith('/health')
    ? healthResponse({ supportedCapabilities: capabilities }) : response(String(url), init));
  return { fetch, nika: new Nika({ url: 'https://nika.example', token, fetch, bin: '/missing/no-local-engine' }) };
}

describe('explicit cost-review protocol version', () => {
  it('prepares V2 once with the exact input and explicit replay key', async () => {
    const { nika, fetch } = remote(() => jsonResponse(v2, 201));
    expect(await nika.prepareCostReview(request, { version: 2, idempotencyKey: 'fan-1' })).toEqual(v2);
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe('https://nika.example/v2/cost-reviews');
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('fan-1');
    expect(init?.redirect).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reads at the creating version and preserves dispatch evidence', async () => {
    const { nika, fetch } = remote(() => jsonResponse({ ...v2, state: 'consumed' }));
    expect(await nika.costReview(id, { version: 2 })).toEqual({ ...v2, state: 'consumed' });
    expect(fetch.mock.calls[1][0]).toBe(`https://nika.example/v2/cost-reviews/${id}`);
    expect(fetch.mock.calls[1][1]?.method).toBe('GET');
  });

  it.each(['approve_once', 'decline'] as const)('sends one explicit V2 %s decision without admission', async decision => {
    const state = decision === 'decline' ? 'declined' : 'approved';
    const { nika, fetch } = remote(() => jsonResponse({ ...v2, state }));
    expect(await nika.decideCostReview(id, { decision, witness_sha256: hash }, { version: 2 }))
      .toMatchObject({ state, cost_review_version: 2 });
    expect(fetch.mock.calls[1][0]).toBe(`https://nika.example/v2/cost-reviews/${id}/decision`);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ decision, witness_sha256: hash });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves zero work as a fact without minting a reference', async () => {
    const zero = { cost_review_version: 2, review_required: false, observer: true, reason: 'zero physical requests' };
    const { nika } = remote(() => jsonResponse(zero));
    expect(await nika.prepareCostReview(request, { version: 2 })).toEqual(zero);
  });

  it.each(['prepare', 'read', 'decide'])('never downgrades %s to the advertised V1', async operation => {
    const { nika, fetch } = remote(() => jsonResponse(review), caps.map(c => c === 'costReviewV2' ? 'costReviewV1' : c));
    const pending = operation === 'prepare' ? nika.prepareCostReview(request, { version: 2 })
      : operation === 'read' ? nika.costReview(id, { version: 2 })
        : nika.decideCostReview(id, { decision: 'decline', witness_sha256: hash }, { version: 2 });
    await expect(pending).rejects.toMatchObject({ capability: 'costReviewV2' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a V1 answer to an explicitly requested V2 observation', async () => {
    const { nika } = remote(() => jsonResponse(review), [...caps, 'costReviewV1']);
    await expect(nika.costReview(id, { version: 2 })).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('retains a V2 refusal without trying another version', async () => {
    const { nika, fetch } = remote(() => jsonResponse({ error: { code: 'review_unknown', message: 'unknown review' } }, 404));
    await expect(nika.costReview(id, { version: 2 })).rejects.toMatchObject({ status: 404, code: 'review_unknown' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not resend a lost V2 decision', async () => {
    const { nika, fetch } = remote(() => { throw new Error('response lost'); });
    await expect(nika.decideCostReview(id, { decision: 'approve_once', witness_sha256: hash }, { version: 2 }))
      .rejects.toMatchObject({ name: 'NikaTransportError' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...v2, bounds: { ...v2.bounds, transport_retries: 1 } },
    { ...v2, bounds: { ...v2.bounds, max_in_flight: 7 } },
    { ...v2, bounds: { ...v2.bounds, retries: 0 } },
    { ...v2, dispatch: { ...v2.dispatch, requests: 5 } },
    { ...v2, dispatch: { ...v2.dispatch, max_in_flight: 1 } },
    { ...v2, dispatch: { ...v2.dispatch, authored_retry: 'true' } },
    { ...v2, dispatch: { ...v2.dispatch, tasks: {} } },
    { ...v2, dispatch: { ...v2.dispatch, tasks: [{ ...v2.dispatch.tasks[0], items: -1 }] } },
    { ...v2, dispatch: { ...v2.dispatch, tasks: [{ ...v2.dispatch.tasks[0], requests: 1.5 }] } },
    { ...v2, dispatch: { ...v2.dispatch, tasks: [{ ...v2.dispatch.tasks[0], surprise: 'not in contract' }] } },
  ])('refuses malformed or contradictory V2 evidence', async value => {
    const { nika } = remote(() => jsonResponse(value));
    await expect(nika.costReview(id, { version: 2 })).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('uses the version-neutral job reference on a V2-capable resident', async () => {
    const { nika, fetch } = remote(url => url.endsWith('/events')
      ? sseResponse([{ sequence: 1, kind: 'execution.settled', status: 'succeeded' }])
      : jsonResponse({ id: 'job-1', status: 'queued' }, 202));
    const reference = { review_id: id, witness_sha256: hash };
    const run = await nika.run(request.workflow, { inputs: request.inputs, access: request.access, costReview: reference, idempotencyKey: 'review-v2-job' });
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ ...request, cost_review: reference });
    expect(fetch.mock.calls.some(([url]) => String(url).includes('cost-reviews'))).toBe(false);
  });

  it('refuses unknown protocol versions before any request', async () => {
    const { nika, fetch } = remote(() => jsonResponse(v2));
    await expect(nika.prepareCostReview(request, { version: 3 } as never)).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the selected version when caller options change during identity I/O', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      if (String(url).endsWith('/health')) {
        await waiting;
        return healthResponse({ supportedCapabilities: [...caps, 'costReviewV1'] });
      }
      return jsonResponse(v2);
    });
    const nika = new Nika({ url: 'https://nika.example', token, fetch });
    const options: { version: 1 | 2 } = { version: 2 };
    const pending = nika.costReview(id, options);
    options.version = 1;
    release();
    await expect(pending).resolves.toMatchObject({ cost_review_version: 2 });
    expect(fetch.mock.calls[1][0]).toBe(`https://nika.example/v2/cost-reviews/${id}`);
  });

  it.each(['prepare', 'read', 'decide'])('reports V2 unavailable on native %s without spawning a binary', async operation => {
    const nika = new Nika({ bin: '/missing/no-local-engine' });
    const pending = operation === 'prepare' ? nika.prepareCostReview(request, { version: 2 })
      : operation === 'read' ? nika.costReview(id, { version: 2 })
        : nika.decideCostReview(id, { decision: 'decline', witness_sha256: hash }, { version: 2 });
    await expect(pending).rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'costReviewV2' });
  });

  it('keeps the default at V1 even on a V2-only server', async () => {
    const { nika, fetch } = remote(() => jsonResponse(v2));
    await expect(nika.prepareCostReview(request)).rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
