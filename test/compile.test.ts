import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaProtocolError } from '../src/index.js';

const token = 'compile-test-bearer-0123456789abcdef';
const request = { compile_version: 1, mode: 'create', intent: 'hello' } as const;
const outcome = {
  compile_version: 1, status: 'incomplete', candidate: null, check_preview: null,
  diagnostics: [], questions: [], requested_boundary: null, requested_trigger: null,
  provenance: { cognition: 'deterministicOnly', compiler_version: '0.121.0', spec_pin: 'test', skeleton: null },
};
const health = (caps = ['compile', 'compileNativeV2']) => ({
  status: 'ok', service: 'nika-serve', engineVersion: '0.121.0', machineProtocolVersion: 1,
  snapshotFormatVersion: 1, checkReportVersion: 1, eventFormatVersion: 1,
  supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', ...caps],
});
function json(body: unknown, status = 200, headers = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function client(response: () => Response, capabilities?: string[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => String(url).endsWith('/health')
    ? json(health(capabilities)) : response());
  // Deliberately nonexistent: authoring over HTTP must never resolve a local engine.
  return { nika: new Nika({ url: 'http://127.0.0.1:8787', allowInsecureHttp: true, token, bin: '/missing/compile-must-not-spawn', fetch }), fetch };
}

describe('compile over the engine-owned HTTP contract', () => {
  it('waits for a native round past the ordinary 30 second HTTP bound without a second POST', async () => {
    vi.useFakeTimers();
    try {
      const replay = 'c'.repeat(64);
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (String(url).endsWith('/health')) return json(health());
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(json(outcome, 200, { 'Nika-Compile-Replay': replay })), 35_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('connection closed before the kept round arrived'));
          }, { once: true });
        });
      });
      const nika = new Nika({ url: 'http://127.0.0.1:8787', allowInsecureHttp: true, token, fetch });
      const result = nika.compile({ compile_version: 2, mode: 'create', cognition: 'explicitProvider', intent: 'hello' })
        .then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await result).toEqual({ value: { outcome, replayToken: replay } });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors explicit caller cancellation of a pending round without retrying', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith('/health')) return json(health());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('caller stopped waiting')), { once: true });
        started();
      });
    });
    const nika = new Nika({ url: 'http://127.0.0.1:8787', allowInsecureHttp: true, token, fetch });
    const result = nika.compile(request, { signal: controller.signal }).catch(error => error);
    await entered;
    controller.abort();
    expect(await result).toMatchObject({ name: 'NikaTransportError' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves incomplete outcomes as data and posts exactly the caller request', async () => {
    const { nika, fetch } = client(() => json(outcome));
    const result = await nika.compile(request);
    expect(result).toEqual({ outcome });
    const [, init] = fetch.mock.calls[1];
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves decision and plan evidence in generation-one outcomes without another request', async () => {
    const evidence = { ...outcome, provenance: { ...outcome.provenance,
      decision: { grounding: [{ field: 'status', grade: 'observed_partial' }] },
      plan: { source: './orders.csv' }, strategy: 'native', suggested_file: 'paid.nika',
    } };
    const { nika, fetch } = client(() => json(evidence));
    expect(await nika.compile(request)).toEqual({ outcome: evidence });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns a replay token without replaying, answering or running automatically', async () => {
    // Generation-2 requests can return generation 1 when no provider call was needed.
    const replay = 'a'.repeat(64);
    const { nika, fetch } = client(() => json(outcome, 200, { 'Nika-Compile-Replay': replay }));
    expect(await nika.compile({ compile_version: 2, mode: 'create', cognition: 'explicitProvider', intent: 'hello' }))
      .toEqual({ outcome, replayToken: replay });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ caps: [] }, { caps: ['compile'] }])('refuses an unadvertised native door before authoring bytes: %j', async ({ caps }) => {
    const { nika, fetch } = client(() => json(outcome), caps);
    await expect(nika.compile({ compile_version: 2, mode: 'create', cognition: 'explicitProvider', intent: 'hello' }))
      .rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([422, 503])('keeps a typed %i refusal and never retries a potentially billable request', async (status) => {
    const { nika, fetch } = client(() => json({ error: { code: 'compile_limit', message: 'operator grant exceeded' } }, status));
    await expect(nika.compile(request)).rejects.toMatchObject({ name: 'NikaOperationError', operation: 'compile', status, code: 'compile_limit' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...outcome, status: 'succeeded' },
    { ...outcome, compile_version: 3 },
    { ...outcome, status: 'ready', candidate: null },
    { ...outcome, questions: 'question' },
    { ...outcome, check_preview: { scope: 'admitted', report: {} } },
    { ...outcome, diagnostics: [{ kind: 'passed', target: 'cost', message: 'free' }] },
    { ...outcome, provenance: { ...outcome.provenance, skeleton: 42 } },
    { ...outcome, provenance: { ...outcome.provenance, decision: false } },
    { ...outcome, provenance: { ...outcome.provenance, decision: [] } },
    { ...outcome, provenance: { ...outcome.provenance, plan: 'authority' } },
    { ...outcome, provenance: { ...outcome.provenance, strategy: 3 } },
    { ...outcome, provenance: { ...outcome.provenance, suggested_file: true } },
    { ...outcome, compile_version: 2, provenance: { ...outcome.provenance, cognition: 'explicitProvider', authoring: {} } },
  ])('does not promote a malformed document to authoring evidence', async (bad) => {
    const { nika } = client(() => json(bad));
    await expect(nika.compile(request)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects malformed replay tokens', async () => {
    const { nika } = client(() => json(outcome, 200, { 'Nika-Compile-Replay': 'not-a-kept-round' }));
    await expect(nika.compile(request)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('does not post when the caller signal was already aborted', async () => {
    const { nika, fetch } = client(() => json(outcome));
    const controller = new AbortController();
    controller.abort();
    await expect(nika.compile(request, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
