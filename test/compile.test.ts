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
