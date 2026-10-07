import { describe, expect, it, vi } from 'vitest';
import {
  isNikaCompileHeld,
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  nextCompileRequest,
} from '../src/index.js';
import type { NikaCompileOutcome, NikaCompileRequest } from '../src/index.js';
import { normalizeCompileRequest } from '../src/lib/compile.js';

// The generation-2 request vocabulary and the answer-round helper, judged with
// no engine and no network: every refusal here is a caller mistake or a field
// the chosen door does not have, typed before any process or request exists.

const TOKEN = '0123456789abcdef'.repeat(4);

function local(): Nika {
  return new Nika({ bin: '/nonexistent/nika' });
}

function remote(fetch = vi.fn()): { nika: Nika; fetch: ReturnType<typeof vi.fn> } {
  return { nika: new Nika({ url: 'https://nika.example', token: 'x'.repeat(32), bin: '/nonexistent/nika', fetch }), fetch };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a refusal');
}

function outcome(overrides: Partial<NikaCompileOutcome> = {}): NikaCompileOutcome {
  return {
    compile_version: 2,
    status: 'incomplete',
    ready: false,
    candidate: null,
    questions: [{ key: 'const.audience', label: 'Who reads it?', type: 'choice', why: 'w', mandatory: true,
      options: [{ key: 'team', label: 'The team' }] }],
    diagnostics: [],
    requested_boundary: null,
    check_preview: null,
    provenance: { compiler_version: '0.122.0', spec_pin: 'pin', skeleton: null, cognition: 'explicitProvider' },
    ...overrides,
  };
}

describe('compile request vocabulary (no engine, no network)', () => {
  it.each([
    [{ intent: 'x', cognition: 'providerPlease' }, /cognition must be explicitProvider or deterministicOnly/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { max_calls: 0 } }, /limits\.max_calls must be an integer from 1 to 4294967295/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { max_calls: 2 ** 32 } }, /limits\.max_calls must be an integer/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { repairs: -1 } }, /limits\.repairs must be an integer from 0/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { max_tokens: 1.5 } }, /limits\.max_tokens must be an integer/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { deadline_ms: '60000' } }, /limits\.deadline_ms must be an integer/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { call_timeout_ms: 0 } }, /limits\.call_timeout_ms must be an integer from 1/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: { budget_usd: 1 } }, /unknown limit budget_usd/],
    [{ intent: 'x', cognition: 'explicitProvider', limits: [6] }, /limits must be a plain object/],
    [{ intent: 'x', limits: { max_calls: 2 } }, /limits bound a provider round: name cognition 'explicitProvider'/],
    [{ intent: 'x', cognition: 'deterministicOnly', replay_token: TOKEN, limits: { max_calls: 2 } }, /deterministicOnly request makes no call/],
    [{ intent: 'x', replay_token: TOKEN }, /a replay_token rides a cognition/],
    [{ intent: 'x', cognition: 'deterministicOnly', replay_token: TOKEN.toUpperCase() }, /64 lowercase hexadecimal digits/],
    [{ intent: 'x', original_intent: 'y' }, /a create request carries its own intent/],
    [{ workflow: 'nika: w\n', change: { set_constant: { name: 'a', value: 1 } }, original_intent: 'y' }, /set_constant edit is applied without it/],
    [{ workflow: 'nika: w\n', change: 'c', workflow_id: 'w' }, /workflow_id belongs to a create request/],
    [{ workflow: 'nika: w\n', change: 'c', decisionModel: 'typesafe/jev-1.13.0' }, /decisionModel belongs to a create request/],
    [{ workflow: 'nika: w\n', change: 'c', fresh: true }, /fresh belongs to a create request/],
    [{ intent: 'x', fresh: 'yes' }, /fresh must be a boolean/],
    [{ intent: 'x', workflow_id: '' }, /workflow_id must be a non-empty string/],
    [{ intent: 'x', authoringModel: 'mistral/m\0' }, /NUL byte/],
    [{ intent: 'x', output: 42 }, /output must be a non-empty string/],
  ])('refuses %j before any engine', async (request, message) => {
    const error = await refusal(local().compile(request as unknown as NikaCompileRequest));
    expect(error).toBeInstanceOf(NikaConfigurationError);
    expect(error.message).toMatch(message);
  });

  it('accepts the judged answer round: explicitProvider with a kept round\'s token, limits narrowing it', () => {
    const judged = { intent: 'x', cognition: 'explicitProvider' as const, replay_token: TOKEN, limits: { max_calls: 2 } };
    expect(normalizeCompileRequest(judged)).toEqual(judged);
    const edit = { workflow: 'nika: w\n', change: 'weekly', original_intent: 'x', cognition: 'explicitProvider' as const,
      replay_token: TOKEN };
    expect(normalizeCompileRequest(edit)).toEqual(edit);
  });

  it('never quotes a malformed replay token', async () => {
    const secretish = `${TOKEN.slice(0, 63)}Z`;
    const error = await refusal(local().compile({ intent: 'x', cognition: 'deterministicOnly', replay_token: secretish }));
    expect(error.message).not.toContain(secretish);
  });

  it('judges limits from descriptors without running a getter', async () => {
    const get = vi.fn(() => 6);
    const limits = Object.defineProperty({}, 'max_calls', { get, enumerable: true });
    const error = await refusal(local().compile({ intent: 'x', cognition: 'explicitProvider', limits }));
    expect(error).toBeInstanceOf(NikaConfigurationError);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [{ intent: 'x', cognition: 'explicitProvider' as const }, 'cognition'],
    [{ intent: 'x', cognition: 'deterministicOnly' as const, replay_token: TOKEN }, 'cognition'],
    [{ intent: 'x', workflow_id: 'digest' }, 'workflow_id'],
    [{ intent: 'x', authoringModel: 'mistral/mistral-small-latest', limits: { deadline_ms: 60_000 } }, 'limits.deadline_ms'],
    [{ intent: 'x', authoringModel: 'mistral/mistral-small-latest', limits: { call_timeout_ms: 1500 } }, 'limits.call_timeout_ms'],
  ])('a local engine refuses the HTTP-only %j before it is even probed', async (request, field) => {
    const error = await refusal(local().compile(request));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'compileOptions', transport: 'native-process' });
    expect(error.message).toContain(field);
  });

  it.each([
    [{ intent: 'x', authoringModel: 'mistral/mistral-small-latest' }, 'authoringModel'],
    [{ intent: 'x', decisionModel: 'typesafe/jev-1.13.0' }, 'decisionModel'],
    [{ intent: 'x', fresh: true }, 'fresh'],
    [{ intent: 'x', output: 'out/x.nika' }, 'output'],
  ])('a server refuses the local-engine %j before any request', async (request, field) => {
    const { nika, fetch } = remote();
    const error = await refusal(nika.compile(request));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'compileOptions', transport: 'http' });
    expect(error.message).toContain(field);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ workflow: 'nika: w\n', change: 'make it weekly', cognition: 'explicitProvider' as const }, /add original_intent/],
    [{ workflow: 'nika: w\n', change: 'make it weekly', original_intent: 'digest' }, /original_intent is a generation-2 field/],
  ])('a server refuses the generation pairing %j before any request', async (request, message) => {
    const { nika, fetch } = remote();
    const error = await refusal(nika.compile(request));
    expect(error).toBeInstanceOf(NikaConfigurationError);
    expect(error.message).toMatch(message);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('nextCompileRequest', () => {
  it('answers a kept round with its judged answer round: exact input, the token, the limits', () => {
    const first = {
      intent: 'Every morning, summarize ./inbox into ./digest.md',
      workflow_id: 'digest',
      cognition: 'explicitProvider' as const,
      limits: { max_calls: 6 },
      answers: { 'const.tone': 'short' },
    };
    const next = nextCompileRequest(first, outcome({ replay_token: TOKEN }), { 'const.audience': 'team' });
    expect(next).toEqual({
      intent: first.intent,
      workflow_id: 'digest',
      answers: { 'const.tone': 'short', 'const.audience': 'team' },
      cognition: 'explicitProvider',
      limits: { max_calls: 6 },
      replay_token: TOKEN,
    });
    // The previous request is left as it was.
    expect(first.answers).toEqual({ 'const.tone': 'short' });
    expect(first).not.toHaveProperty('replay_token');
  });

  it('asks for the zero-call replay on request: deterministicOnly, no limits', () => {
    const first = { intent: 'x', workflow_id: 'digest', cognition: 'explicitProvider' as const, limits: { max_calls: 6 } };
    expect(nextCompileRequest(first, outcome({ replay_token: TOKEN }), { 'const.audience': 'team' },
      { cognition: 'deterministicOnly' })).toEqual({
      intent: 'x', workflow_id: 'digest', answers: { 'const.audience': 'team' },
      cognition: 'deterministicOnly', replay_token: TOKEN,
    });
  });

  it('answers a kept edit round with its original intent', () => {
    const first = {
      workflow: 'nika: digest\n',
      change: 'make it weekly',
      original_intent: 'Every morning, summarize ./inbox',
      cognition: 'explicitProvider' as const,
      limits: { repairs: 0 },
    };
    expect(nextCompileRequest(first, outcome({ replay_token: TOKEN }), { 'trigger.timezone': 'Europe/Paris' })).toEqual({
      workflow: first.workflow,
      change: first.change,
      original_intent: first.original_intent,
      answers: { 'trigger.timezone': 'Europe/Paris' },
      cognition: 'explicitProvider',
      limits: { repairs: 0 },
      replay_token: TOKEN,
    });
  });

  it('keeps answering a judged round by its token while no new one comes back', () => {
    const judged = { intent: 'x', cognition: 'explicitProvider' as const, replay_token: TOKEN, limits: { max_calls: 2 }, answers: { a: 1 } };
    expect(nextCompileRequest(judged, outcome({ compile_version: 2 }), { b: 2 })).toEqual({
      intent: 'x', answers: { a: 1, b: 2 }, cognition: 'explicitProvider', limits: { max_calls: 2 }, replay_token: TOKEN,
    });
  });

  it('follows the newest token a round answered', () => {
    const newer = 'fedcba9876543210'.repeat(4);
    const judged = { intent: 'x', cognition: 'explicitProvider' as const, replay_token: TOKEN };
    expect(nextCompileRequest(judged, outcome({ replay_token: newer }), {})).toMatchObject({ replay_token: newer });
  });

  it('turns a zero-call replay into its judged answer round only on request', () => {
    const replay = { intent: 'x', cognition: 'deterministicOnly' as const, replay_token: TOKEN, answers: { a: 1 } };
    expect(nextCompileRequest(replay, outcome({ compile_version: 1 }), {}, { cognition: 'explicitProvider' })).toEqual({
      intent: 'x', answers: { a: 1 }, cognition: 'explicitProvider', replay_token: TOKEN,
    });
  });

  it('keeps answering a replay with the same token', () => {
    const replay = { intent: 'x', cognition: 'deterministicOnly' as const, replay_token: TOKEN, answers: { a: 1 } };
    const gen1 = outcome({ compile_version: 1, provenance: { ...outcome().provenance, cognition: 'deterministicOnly' } });
    expect(nextCompileRequest(replay, gen1, { b: [true, null] })).toEqual({
      intent: 'x', cognition: 'deterministicOnly', replay_token: TOKEN, answers: { a: 1, b: [true, null] },
    });
  });

  it('repeats a tokenless request with merged answers; a later answer wins', () => {
    const first = { intent: 'x', cognition: 'explicitProvider' as const, limits: { max_calls: 3 }, answers: { a: 1 } };
    expect(nextCompileRequest(first, outcome(), { a: 2, b: 'two' })).toEqual({
      intent: 'x', cognition: 'explicitProvider', limits: { max_calls: 3 }, answers: { a: 2, b: 'two' },
    });
  });

  it('drops fresh natively so the answer round replays the recorded plan, and keeps the seat', () => {
    const first = {
      intent: 'x',
      authoringModel: 'mistral/mistral-small-latest',
      decisionModel: 'typesafe/jev-1.13.0',
      limits: { max_calls: 4 },
      fresh: true,
      output: 'out/x.nika',
    };
    expect(nextCompileRequest(first, outcome(), { 'const.audience': 'team' })).toEqual({
      intent: 'x',
      authoringModel: 'mistral/mistral-small-latest',
      decisionModel: 'typesafe/jev-1.13.0',
      limits: { max_calls: 4 },
      output: 'out/x.nika',
      answers: { 'const.audience': 'team' },
    });
  });

  it('refuses a held outcome: no answer round, its token is forgotten, asking again would author anew', () => {
    const held = outcome({
      candidate: 'nika: preview\n',
      diagnostics: [{ kind: 'applied', target: 'verify_held', message: 'held' }],
    });
    const judged = { intent: 'x', cognition: 'explicitProvider' as const, replay_token: TOKEN };
    expect(() => nextCompileRequest(judged, held, { a: 1 })).toThrow(NikaConfigurationError);
    expect(() => nextCompileRequest(judged, held, { a: 1 })).toThrow(/held/);
    expect(() => nextCompileRequest('x', held, {})).toThrow(/held/);
  });

  it('refuses the cognition option when no kept round is involved', () => {
    expect(() => nextCompileRequest({ intent: 'x', cognition: 'explicitProvider' }, outcome(), { a: 1 },
      { cognition: 'deterministicOnly' })).toThrow(/kept none/);
    expect(() => nextCompileRequest('x', outcome({ compile_version: 1 }), {}, { cognition: 'explicitProvider' }))
      .toThrow(/kept none/);
  });

  it.each([
    [{ cognition: 'implicitProvider' }, /cognition must be explicitProvider or deterministicOnly/],
    [{ judge: true }, /unknown option judge/],
    [[], /options must be a plain object/],
  ])('refuses the options %j', (options, message) => {
    expect(() => nextCompileRequest({ intent: 'x', cognition: 'explicitProvider' }, outcome({ replay_token: TOKEN }), {},
      options as never)).toThrow(message);
  });

  it('reads the held marker without running caller code, a revoked Proxy included', () => {
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    expect(() => nextCompileRequest('x', outcome({ diagnostics: revocable.proxy as never }), {}))
      .toThrow(NikaConfigurationError);
    const get = vi.fn(() => 'applied');
    const accessor = Object.defineProperty({ target: 'verify_held', message: 'm' }, 'kind', { get, enumerable: true });
    expect(nextCompileRequest('x', outcome({ diagnostics: [accessor as never] }), {})).toEqual({ intent: 'x', answers: {} });
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a token its request could not have opened', () => {
    expect(() => nextCompileRequest('hello', outcome({ replay_token: TOKEN }), {})).toThrow(/could not have opened/);
  });

  it('accepts the bare-string shorthand as the previous request', () => {
    expect(nextCompileRequest('classify-and-route', outcome({ compile_version: 1 }), { 'const.request': 'x' }))
      .toEqual({ intent: 'classify-and-route', answers: { 'const.request': 'x' } });
  });

  it.each([
    [{ x: 1n }, /bigint/],
    [{ x: undefined }, /undefined/],
    [['const.request=1'], /answers must be a plain object/],
  ])('refuses answers JSON cannot carry: %#', (answers, message) => {
    expect(() => nextCompileRequest('x', outcome(), answers as unknown as Record<string, unknown>))
      .toThrow(message);
  });

  it('refuses an outcome whose token is not one a server issues, without quoting it', () => {
    const forged = 'not-a-token-but-maybe-a-secret';
    let error: unknown;
    try {
      nextCompileRequest('x', outcome({ replay_token: forged }), {});
    } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(NikaConfigurationError);
    expect((error as Error).message).not.toContain(forged);
  });

  it('judges the previous request by the same law as compile()', () => {
    expect(() => nextCompileRequest({ intent: 'x', dest: 'f.nika' } as unknown as NikaCompileRequest, outcome(), {}))
      .toThrow(/unknown request field dest/);
  });
});

describe('isNikaCompileHeld', () => {
  it('is true exactly for the applied verify_held marker', () => {
    const held = { kind: 'applied' as const, target: 'verify_held', message: 'held' };
    expect(isNikaCompileHeld(outcome({ candidate: 'nika: preview\n', diagnostics: [held] }))).toBe(true);
    expect(isNikaCompileHeld(outcome({ diagnostics: [{ ...held, kind: 'unknown' }] }))).toBe(false);
    expect(isNikaCompileHeld(outcome({ diagnostics: [{ ...held, target: 'verify_resume' }] }))).toBe(false);
    expect(isNikaCompileHeld(outcome())).toBe(false);
  });
});
