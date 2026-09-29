import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Nika, NikaConfigurationError } from '../src/index.js';
import type { NikaCompileResult, NikaPublishedCompileOutcome } from '../src/index.js';

// The published 0.120 compile door on this line's resident contract: the same
// program shapes (an intent string, { intent }, { workflow, change } with
// { timeoutMs }) reach the same compile_version 1 wire and resolve the
// outcome itself with `ready`; the typed V9 request keeps its own result and
// replay token; a hybrid is refused, never reinterpreted.

const token = 'compile-test-bearer-0123456789abcdef';
const replay = 'c'.repeat(64);
const outcome = {
  compile_version: 1, status: 'ready', candidate: 'nika: hello\ntasks: {}\n', check_preview: null,
  diagnostics: [], questions: [], requested_boundary: null, requested_trigger: null,
  provenance: { cognition: 'deterministicOnly', compiler_version: '0.121.0', spec_pin: 'test', skeleton: 'hello' },
};
const health = {
  status: 'ok', service: 'nika-serve', engineVersion: '0.121.0', machineProtocolVersion: 1,
  snapshotFormatVersion: 1, checkReportVersion: 1, eventFormatVersion: 1,
  supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'compile'],
};
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-nika.mjs');

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A resident that answers every compile with `outcome` and a kept-round token, and remembers each body. */
function resident(answer: (init?: RequestInit) => Promise<Response> | Response = () => json(outcome, {
  'Nika-Compile-Replay': replay,
})) {
  const bodies: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/health')) return json(health);
    bodies.push(JSON.parse(String(init?.body)));
    return answer(init);
  });
  const nika = new Nika({
    url: 'http://127.0.0.1:8787', allowInsecureHttp: true, token, bin: '/missing/compile-must-not-spawn', fetch,
  });
  return { nika, fetch, bodies };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the published compile shapes on the resident contract', () => {
  it('sends a bare intent as the compile_version 1 create wire and resolves the outcome with ready', async () => {
    const { nika, bodies } = resident();
    const result = await nika.compile('hello', { timeoutMs: 60_000 });

    expect(bodies).toEqual([{ compile_version: 1, mode: 'create', intent: 'hello' }]);
    expect(result).toEqual({ ...outcome, ready: true });
    // The kept-round token is the V9 door's authority; the published door never offered one.
    expect(result).not.toHaveProperty('replayToken');
    expect(result).not.toHaveProperty('outcome');
  });

  it('derives ready from the resident status word alone', async () => {
    const incomplete = { ...outcome, status: 'incomplete', candidate: null };
    const { nika } = resident(() => json(incomplete));
    await expect(nika.compile({ intent: 'hello' })).resolves.toEqual({ ...incomplete, ready: false });
  });

  it('keeps answers exact, false, 0, empty and null included', async () => {
    const { nika, bodies } = resident();
    await nika.compile({ intent: 'hello', answers: { 'const.a': false, 'const.b': 0, 'const.c': '', 'const.d': null } });
    expect(bodies).toEqual([{
      compile_version: 1, mode: 'create', intent: 'hello',
      answers: { 'const.a': false, 'const.b': 0, 'const.c': '', 'const.d': null },
    }]);
  });

  it('sends an edit as source and change, text or set_constant', async () => {
    const { nika, bodies } = resident();
    await nika.compile({ workflow: 'nika: base\n', change: 'Set const.tone to "dry"' });
    await nika.compile({ workflow: 'nika: base\n', change: { set_constant: { name: 'limit', value: 0 } } });
    expect(bodies).toEqual([
      { compile_version: 1, mode: 'edit', source: 'nika: base\n', change: { text: 'Set const.tone to "dry"' } },
      { compile_version: 1, mode: 'edit', source: 'nika: base\n', change: { set_constant: { name: 'limit', value: 0 } } },
    ]);
  });

  it('keeps the typed V9 request and its replay token exactly as before', async () => {
    const { nika, bodies } = resident();
    const result = await nika.compile({ compile_version: 1, mode: 'create', intent: 'hello' });
    expect(result).toEqual({ outcome, replayToken: replay });
    expect(result.outcome).not.toHaveProperty('ready');
    expect(bodies).toEqual([{ compile_version: 1, mode: 'create', intent: 'hello' }]);
  });

  it.each([
    ['an empty intent', ''],
    ['an unknown field', { intent: 'hello', mode: 'create' }],
    ['create mixed with edit', { intent: 'hello', workflow: 'nika: base\n' }],
    ['neither create nor edit', {}],
    ['an edit without its source', { change: 'Set const.x to 1' }],
    ['an empty change', { workflow: 'nika: base\n', change: '' }],
    ['a malformed set_constant', { workflow: 'nika: base\n', change: { set_constant: { name: 'a.b', value: 1 } } }],
    ['an undefined answer', { intent: 'hello', answers: { 'const.a': undefined } }],
    ['a non-finite answer', { intent: 'hello', answers: { 'const.a': Number.NaN } }],
    ['a bigint answer', { intent: 'hello', answers: { 'const.a': 1n } }],
    ['a class instance answer', { intent: 'hello', answers: { 'const.a': new Date(0) } }],
    ['a hybrid V9 edit with a published source', { compile_version: 1, mode: 'edit', workflow: 'x', change: { text: 'y' } }],
    ['a hybrid V9 edit with a text change', { compile_version: 1, mode: 'edit', source: 'x', change: 'y' }],
  ])('refuses %s before any request, never reinterpreting it', async (_label, request) => {
    const { nika, fetch } = resident();
    const refused = await (nika.compile as (request: unknown) => Promise<unknown>)(request).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NikaConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 2 ** 31])('refuses timeoutMs %s before any request', async (timeoutMs) => {
    const { nika, fetch } = resident();
    await expect(nika.compile('hello', { timeoutMs })).rejects.toBeInstanceOf(NikaConfigurationError);
    await expect(nika.compile({ compile_version: 1, mode: 'create', intent: 'hello' }, { timeoutMs }))
      .rejects.toBeInstanceOf(NikaConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts a compile at its deadline and says so', async () => {
    let aborted = false;
    const { nika } = resident((init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('the request was aborted'));
      }, { once: true });
    }));
    const failure = await nika.compile('hello', { timeoutMs: 50 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'NikaTransportError' });
    expect((failure as Error).message).toContain('compile timed out after 50 ms');
    expect(aborted).toBe(true);
  });

  it('releases its deadline timer when the compile ends first', async () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const { nika } = resident();
    await nika.compile('hello', { timeoutMs: 60_000 });
    const index = setTimer.mock.calls.findIndex((call) => call[1] === 60_000);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]?.value);
  });

  it('keeps a caller abort the transport error, not a deadline', async () => {
    const controller = new AbortController();
    const { nika } = resident((init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('caller stopped waiting')), { once: true });
      controller.abort();
    }));
    const failure = await nika.compile('hello', { signal: controller.signal, timeoutMs: 60_000 })
      .catch((error: unknown) => error);
    expect((failure as Error).message).not.toContain('timed out');
  });

  it('still refuses a native compile with a typed compatibility error', async () => {
    const failure = await new Nika({ bin: FIXTURE }).compile('hello').catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'NikaCompatibilityError', capability: 'compile' });
  });

  it('types each door by its request', () => {
    // Checked by the compiler only: the calls are never made.
    const typed = (nika: Nika) => {
      expectTypeOf(nika.compile('hello')).resolves.toEqualTypeOf<NikaPublishedCompileOutcome>();
      expectTypeOf(nika.compile({ intent: 'hello' })).resolves.toEqualTypeOf<NikaPublishedCompileOutcome>();
      expectTypeOf(nika.compile({ compile_version: 1, mode: 'create', intent: 'hello' }))
        .resolves.toEqualTypeOf<NikaCompileResult>();
    };
    expect(typeof typed).toBe('function');
  });
});
