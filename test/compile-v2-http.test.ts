import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isNikaCompileHeld,
  Nika,
  NikaCompatibilityError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
  nextCompileRequest,
} from '../src/index.js';
import type { NikaCompileRequest } from '../src/index.js';
import { COMPILE_SERVER_HANDOFF_MS, compileTimeoutMs } from '../src/lib/compile.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// `POST /v1/compile` generation 2 (engine 0.123 integration line,
// `crates/nika-serve/src/server/compile/{v2,author}.rs` and
// `openapi-native.json`), against a mocked fetch: no network, no provider,
// no local engine. The documents mirror `nika-compile/src/wire.rs`.

const COMPILE_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const argvLog = path.join(tmpdir(), `nika-sdk-compile-v2-http-${process.pid}.log`);
const REPLAY = '0123456789abcdef'.repeat(4);
const NATIVE_SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'compileNativeV2'];
const DEFAULT_SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile'];
const INTENT = 'Every morning at 9, summarize ./inbox/*.md into ./digest.md for the team';

const RECEIPT = {
  model: 'mistral/mistral-small-latest',
  calls: 2,
  input_tokens: 1840,
  output_tokens: 912,
  elapsed_ms: 2310,
  sampling: { temperature: null, seed: null, effective: 'providerDefaultUnknown' },
  context: [{ role: 'author', instruction_sha256: 'a'.repeat(64), message_bytes: 4096 }],
  backend: { kind: 'direct', provider: 'mistral', requested_model: 'mistral/mistral-small-latest',
    observed_models: ['mistral-small-latest'], unreported_models: 0, usage_complete: true,
    cost_basis: 'unpriced; billing_unverified', authority: { max_calls: 6, source: 'request: limits.max_calls within operator ceiling',
      invocations: { sent: 2, refused: 0 }, http_requests: { sent: 2, refused: 0, unknown: null } },
    host: 'api.mistral.ai', base_url_overridden: false, endpoint_basis: 'operator_configuration' },
};
const TRIGGER = {
  kind: 'schedule', source_hint: 'Every morning at 9', event_hint: null, cadence: 'daily', cron: '0 9 * * *',
  at: '09:00', payload_input: null, status: 'requires_binding', timezone: null, missed: null, overlap: null, ceiling: null,
};
const CHOICE = {
  key: 'const.audience', label: 'Who reads the digest?', type: 'choice', why: 'Two readers are named.', mandatory: true,
  options: [{ key: 'team', label: 'The whole team' }, { key: 'lead', label: 'The team lead' }],
};
const PROVENANCE_V1 = {
  compiler_version: '0.122.0', spec_pin: 'be8ff017d448c4d4e413d11c40613af0afb90754', skeleton: null,
  cognition: 'deterministicOnly', suggested_file: 'morning-digest.nika',
};
const PROVENANCE_V2 = {
  ...PROVENANCE_V1, cognition: 'explicitProvider', strategy: 'native',
  plan: { semantic_record: { request: 'digest' } }, decision: { route: ['native: author 1'] }, authoring: RECEIPT,
};

function document(version: 1 | 2, overrides: Record<string, unknown> = {}) {
  return {
    compile_version: version,
    status: 'incomplete',
    candidate: null,
    questions: [],
    diagnostics: [],
    requested_boundary: null,
    requested_trigger: null,
    check_preview: null,
    provenance: version === 2 ? PROVENANCE_V2 : PROVENANCE_V1,
    ...overrides,
  };
}
const fresh = (overrides: Record<string, unknown> = {}) => document(2, { questions: [CHOICE], requested_trigger: TRIGGER, ...overrides });
/**
 * A replay as the engine's own test pins it (serve `tests/compile/native.rs`, the
 * answer round): generation 1, no call, the answers bound into the kept plan's
 * candidate, and its judgment still pending, so it stays incomplete.
 */
const replayed = (overrides: Record<string, unknown> = {}) => document(1, {
  candidate: 'nika: morning-digest\nconst: { audience: "team" }\ntasks: {}\n',
  diagnostics: [{ kind: 'unknown', target: 'semantic_verification', message: 'No admitted judgment carried the whole request yet.' }],
  requested_trigger: TRIGGER,
  provenance: { ...PROVENANCE_V1, strategy: 'native', plan: { semantic_record: { request: 'digest' } },
    decision: { pending: { open: ['the whole request'] } } },
  ...overrides,
});
/**
 * A judged answer round the seat accepted (serve `tests/compile/native/replayed.rs`):
 * the kept plan replayed with the answers, one judge question and no authoring
 * call, so generation 2 with a judge-only receipt, ready.
 */
const JUDGE_RECEIPT = { ...RECEIPT, calls: 1, context: [{ role: 'judge_request', instruction_sha256: 'c'.repeat(64) }] };
const judged = (overrides: Record<string, unknown> = {}) => document(2, {
  status: 'ready', candidate: 'nika: morning-digest\nconst: { audience: "team" }\ntasks: {}\n', requested_trigger: TRIGGER,
  provenance: { ...PROVENANCE_V2, authoring: JUDGE_RECEIPT },
  ...overrides,
});
/** A judged answer round the seat did not accept: held, its plan dropped, no token. */
const judgedHeld = () => document(2, {
  candidate: 'nika: morning-digest\nconst: { audience: "team" }\ntasks: {}\n',
  diagnostics: [
    { kind: 'unknown', target: 'semantic_verification', message: 'The judge compared the whole request with the candidate\'s bytes.' },
    { kind: 'applied', target: 'verify_held', message: 'The candidate was judged and not accepted.' },
  ],
  requested_trigger: TRIGGER,
  provenance: { ...PROVENANCE_V2, plan: undefined, authoring: JUDGE_RECEIPT },
});
/** Every answer to a generation-2 request carries no-store; a kept round also the token. */
const kept = { 'Cache-Control': 'no-store', 'Nika-Compile-Replay': REPLAY };
const noStore = { 'Cache-Control': 'no-store' };

function client(fetch: typeof globalThis.fetch, extra = {}) {
  process.env.NIKA_FAKE_ARGV_LOG = argvLog;
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: COMPILE_ENGINE, fetch, ...extra });
}
function server(capabilities = NATIVE_SERVER) {
  return healthResponse({ supportedCapabilities: capabilities });
}
function respond(...responses: Response[]) {
  const fetch = vi.fn().mockResolvedValueOnce(server());
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a failure');
}
function posted(fetch: ReturnType<typeof vi.fn>, index: number): { body: string; init: RequestInit & { headers: Headers } } {
  const [url, init] = fetch.mock.calls[index]!;
  expect(url).toBe('https://nika.example/v1/compile');
  return { body: init.body as string, init };
}

describe('HTTP compile generation 2 (provider rounds and kept-round replay)', () => {
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    const spawned = existsSync(argvLog);
    rmSync(argvLog, { force: true });
    expect(spawned, 'HTTP compile must never spawn a local engine').toBe(false);
  });

  it('refuses a provider round on a resident without compileNativeV2, after /health alone', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(server(DEFAULT_SERVER));
    const error = await failure(client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' }));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'compileNativeV2', transport: 'http' });
    expect(error.message).toMatch(/Nothing was posted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a replay on a resident without compileNativeV2 the same way', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(server(DEFAULT_SERVER));
    const error = await failure(client(fetch).compile({ intent: INTENT, cognition: 'deterministicOnly', replay_token: REPLAY }));
    expect(error).toMatchObject({ name: 'NikaCompatibilityError', capability: 'compileNativeV2' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('posts the exact fresh envelope and hands back the replay token beside the outcome', async () => {
    const fetch = respond(jsonResponse(fresh(), 200, kept));
    const outcome = await client(fetch).compile({
      intent: INTENT,
      workflow_id: 'morning-digest',
      cognition: 'explicitProvider',
      limits: { max_calls: 6, repairs: 1, max_tokens: 8192, call_timeout_ms: 90_000, deadline_ms: 600_000 },
      answers: { 'const.tone': 'short' },
    });
    const { body, init } = posted(fetch, 1);
    expect(body).toBe(
      `{"compile_version":2,"mode":"create","cognition":"explicitProvider","intent":${JSON.stringify(INTENT)},`
      + '"workflow_id":"morning-digest","answers":{"const.tone":"short"},'
      + '"limits":{"max_calls":6,"repairs":1,"max_tokens":8192,"call_timeout_ms":90000,"deadline_ms":600000}}',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.get('Authorization')).toBe(`Bearer ${TOKEN_A}`);
    expect(init.headers.has('Idempotency-Key')).toBe(false);
    expect(outcome).toEqual({ ...fresh(), ready: false, replay_token: REPLAY });
    expect(outcome.compile_version).toBe(2);
    expect(outcome.provenance.cognition).toBe('explicitProvider');
    expect(outcome.provenance.authoring?.calls).toBe(2);
    expect(outcome.questions[0]).toMatchObject({ type: 'choice', options: [{ key: 'team' }, { key: 'lead' }] });
    expect(outcome.requested_trigger).toMatchObject({ kind: 'schedule', cron: '0 9 * * *', status: 'requires_binding' });
  });

  it('answers a kept round with its judged answer round: the seat only judges, ready', async () => {
    const fetch = respond(jsonResponse(fresh(), 200, kept), jsonResponse(judged(), 200, noStore));
    const nika = client(fetch);
    const first = { intent: INTENT, workflow_id: 'morning-digest', cognition: 'explicitProvider' as const, limits: { max_calls: 6 } };
    const round1 = await nika.compile(first);
    const round2 = await nika.compile(nextCompileRequest(first, round1, { 'const.audience': 'team' }));
    expect(posted(fetch, 2).body).toBe(
      `{"compile_version":2,"mode":"create","cognition":"explicitProvider","intent":${JSON.stringify(INTENT)},`
      + `"workflow_id":"morning-digest","answers":{"const.audience":"team"},"limits":{"max_calls":6},`
      + `"replay_token":"${REPLAY}"}`,
    );
    expect(round2).toMatchObject({ compile_version: 2, status: 'ready', ready: true });
    expect(round2.candidate).toContain('audience: "team"');
    expect(round2.provenance.authoring?.context).toEqual([expect.objectContaining({ role: 'judge_request' })]);
    expect(isNikaCompileHeld(round2)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3); // the identity probe is not repeated
  });

  it('accepts a new token a judged round answers, and the next round follows it', async () => {
    const newer = 'fedcba9876543210'.repeat(4);
    const fetch = respond(jsonResponse(fresh(), 200, kept),
      jsonResponse(judged({ status: 'incomplete', candidate: null, questions: [CHOICE] }), 200,
        { 'Cache-Control': 'no-store', 'Nika-Compile-Replay': newer }));
    const nika = client(fetch);
    const first = { intent: INTENT, cognition: 'explicitProvider' as const };
    const round1 = await nika.compile(first);
    const request2 = nextCompileRequest(first, round1, { 'const.audience': 'team' });
    const round2 = await nika.compile(request2);
    expect(round2.replay_token).toBe(newer);
    expect(nextCompileRequest(request2, round2, { 'const.tone': 'short' })).toMatchObject({
      cognition: 'explicitProvider', replay_token: newer, answers: { 'const.audience': 'team', 'const.tone': 'short' },
    });
  });

  it('a judged round the seat does not accept is held; its forgotten token then answers 409', async () => {
    const unavailable = { error: { code: 'compile_replay_unavailable',
      message: 'this server run keeps no round under that token (unknown, past an explicit lifetime, or kept by another server run); author again with explicitProvider' } };
    const fetch = respond(jsonResponse(fresh(), 200, kept), jsonResponse(judgedHeld(), 200, noStore),
      jsonResponse(unavailable, 409));
    const nika = client(fetch);
    const first = { intent: INTENT, cognition: 'explicitProvider' as const };
    const round1 = await nika.compile(first);
    const judgedRound = nextCompileRequest(first, round1, { 'const.audience': 'team' });
    const round2 = await nika.compile(judgedRound);
    expect(round2).toMatchObject({ compile_version: 2, status: 'incomplete', ready: false });
    expect(isNikaCompileHeld(round2)).toBe(true);
    expect(round2.candidate).toContain('audience: "team"');
    expect(round2).not.toHaveProperty('replay_token');
    // The helper builds no answer round from a held outcome.
    expect(() => nextCompileRequest(judgedRound, round2, {})).toThrow(/held/);
    // Sent anyway, the forgotten token is refused, typed.
    const error = await failure(nika.compile(judgedRound));
    expect(error).toBeInstanceOf(NikaOperationError);
    expect(error).toMatchObject({ operation: 'compile', status: 409, code: 'compile_replay_unavailable' });
  });

  it('answers a kept round with its zero-call replay on request: no call, no judge, a preview', async () => {
    const fetch = respond(jsonResponse(fresh(), 200, kept), jsonResponse(replayed(), 200, noStore),
      jsonResponse(replayed(), 200, noStore));
    const nika = client(fetch);
    const first = { intent: INTENT, workflow_id: 'morning-digest', cognition: 'explicitProvider' as const, limits: { max_calls: 6 } };
    const round1 = await nika.compile(first);
    const replay = nextCompileRequest(first, round1, { 'const.audience': 'team' }, { cognition: 'deterministicOnly' });
    const round2 = await nika.compile(replay);
    expect(posted(fetch, 2).body).toBe(
      `{"compile_version":2,"mode":"create","cognition":"deterministicOnly","intent":${JSON.stringify(INTENT)},`
      + `"workflow_id":"morning-digest","answers":{"const.audience":"team"},"replay_token":"${REPLAY}"}`,
    );
    // The answers are bound with no call, but a replay asks no verifier: still a preview.
    expect(round2).toMatchObject({ compile_version: 1, status: 'incomplete', ready: false, questions: [] });
    expect(round2.candidate).toContain('audience: "team"');
    expect(round2.provenance.decision).toEqual({ pending: { open: ['the whole request'] } });
    expect(round2).not.toHaveProperty('replay_token');
    expect(round2.provenance).not.toHaveProperty('authoring');
    // A zero-call replay stays one: asking again is the same round with the same token.
    const again = nextCompileRequest(replay, round2, {});
    expect(again).toEqual(replay);
    expect(await nika.compile(again)).toEqual(round2);
    // Its judged answer round is one option away.
    expect(nextCompileRequest(replay, round2, {}, { cognition: 'explicitProvider' })).toMatchObject({
      cognition: 'explicitProvider', replay_token: REPLAY, answers: { 'const.audience': 'team' },
    });
  });

  it('types a server from before the judged answer round as a compatibility gap, nothing spent', async () => {
    const malformed = { error: { code: 'malformed_compile_request',
      message: 'use compile_version 2 with cognition explicitProvider (create {intent} or edit {source, change}; a text change also carries original_intent) or deterministicOnly with the replay_token of that round' } };
    const fetch = respond(jsonResponse(malformed, 422));
    const error = await failure(client(fetch).compile({
      intent: INTENT, cognition: 'explicitProvider', replay_token: REPLAY, answers: { 'const.audience': 'team' },
    }));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'compileJudgedAnswerRound', transport: 'http' });
    expect(error.message).toMatch(/predates that round/);
    expect(error.message).toMatch(/cognition: 'deterministicOnly'/);
    expect(error.message).not.toContain(REPLAY);
  });

  it.each([
    [422, 'malformed_compile_request', { intent: INTENT, cognition: 'explicitProvider' as const }],
    [422, 'malformed_compile_request', { intent: INTENT, cognition: 'deterministicOnly' as const, replay_token: REPLAY }],
    [422, 'compile_limit', { intent: INTENT, cognition: 'explicitProvider' as const, replay_token: REPLAY, limits: { max_calls: 99 } }],
    [409, 'compile_replay_unavailable', { intent: INTENT, cognition: 'explicitProvider' as const, replay_token: REPLAY }],
    [409, 'compile_replay_input_changed', { intent: INTENT, cognition: 'explicitProvider' as const, replay_token: REPLAY }],
    [422, 'compile_new_intent_required', { intent: INTENT, cognition: 'explicitProvider' as const, replay_token: REPLAY,
      answers: { 'intent.clarification': 'weekly instead' } }],
    [503, 'compile_replay_capacity', { intent: INTENT, cognition: 'explicitProvider' as const, replay_token: REPLAY }],
  ])('keeps the %i %s refusal the engine\'s own for %j', async (status, code, request) => {
    const fetch = respond(jsonResponse({ error: { code, message: `the server said ${code}` } }, status));
    const error = await failure(client(fetch).compile(request));
    expect(error).toBeInstanceOf(NikaOperationError);
    expect(error).toMatchObject({ status, code, machineCode: code });
  });

  it('a provider round without a kept plan answers no token; the next round is a new fresh round', async () => {
    const fetch = respond(jsonResponse(fresh(), 200, noStore));
    const first = { intent: INTENT, cognition: 'explicitProvider' as const, limits: { max_calls: 4 } };
    const outcome = await client(fetch).compile(first);
    expect(outcome).not.toHaveProperty('replay_token');
    expect(nextCompileRequest(first, outcome, { 'const.audience': 'lead' })).toEqual({
      ...first, answers: { 'const.audience': 'lead' },
    });
  });

  it('a provider round that needed no call answers generation 1', async () => {
    const fetch = respond(jsonResponse(document(1, { status: 'ready', candidate: 'nika: hello\n', provenance: { ...PROVENANCE_V1, skeleton: 'hello', strategy: 'skeleton' } }), 200, noStore));
    const outcome = await client(fetch).compile({ intent: 'hello', cognition: 'explicitProvider' });
    expect(outcome).toMatchObject({ compile_version: 1, ready: true, provenance: { skeleton: 'hello' } });
  });

  it('posts an edit revision with its original intent, and a structured constant without one', async () => {
    // A structured constant needs no call: generation 1 (wire.rs: 2 exactly with a receipt).
    const constant = document(1, { status: 'ready', candidate: 'nika: morning-digest\nconst: { audience: "lead" }\n' });
    const fetch = respond(jsonResponse(fresh(), 200, noStore), jsonResponse(constant, 200, noStore));
    const nika = client(fetch);
    const source = 'nika: morning-digest\r\nconst: { audience: "team" }\n';
    await nika.compile({ workflow: source, change: 'send it weekly instead', original_intent: INTENT, cognition: 'explicitProvider' });
    expect(posted(fetch, 1).body).toBe(
      `{"compile_version":2,"mode":"edit","cognition":"explicitProvider","source":${JSON.stringify(source)},`
      + `"change":{"text":"send it weekly instead"},"original_intent":${JSON.stringify(INTENT)}}`,
    );
    await nika.compile({ workflow: source, change: { set_constant: { name: 'audience', value: 'lead' } }, cognition: 'explicitProvider' });
    expect(JSON.parse(posted(fetch, 2).body)).toEqual({
      compile_version: 2, mode: 'edit', cognition: 'explicitProvider', source,
      change: { set_constant: { name: 'audience', value: 'lead' } },
    });
  });

  it('names the generation-1 cognition explicitly without opening generation 2', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(server(DEFAULT_SERVER)).mockResolvedValueOnce(jsonResponse(document(1)));
    await client(fetch).compile({ intent: 'hello', cognition: 'deterministicOnly' });
    expect(posted(fetch, 1).body).toBe('{"compile_version":1,"mode":"create","cognition":"deterministicOnly","intent":"hello"}');
  });

  it('keeps a held candidate a preview: incomplete, never ready, never a replay', async () => {
    const held = fresh({
      questions: [],
      candidate: 'nika: held-digest\ntasks: {}\n',
      diagnostics: [
        { kind: 'unknown', target: 'semantic_verification', message: 'it does not carry « every morning »' },
        { kind: 'applied', target: 'verify_held', message: 'The candidate was judged and not accepted.' },
      ],
      provenance: { ...PROVENANCE_V2, plan: undefined },
    });
    const fetch = respond(jsonResponse(held, 200, noStore));
    const outcome = await client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' });
    expect(outcome.status).toBe('incomplete');
    expect(outcome.ready).toBe(false);
    expect(isNikaCompileHeld(outcome)).toBe(true);
    expect(outcome.candidate).toBe('nika: held-digest\ntasks: {}\n');
    expect(outcome).not.toHaveProperty('replay_token');
  });

  it.each([
    [401, 'unauthorized'],
    [408, 'request_timeout'],
    [408, 'compile_deadline_exceeded'],
    [409, 'compile_replay_unavailable'],
    [409, 'compile_replay_input_changed'],
    [409, 'compile_context_changed'],
    [413, 'body_too_large'],
    [415, 'unsupported_media_type'],
    [415, 'unsupported_content_encoding'],
    [422, 'malformed_compile_request'],
    [422, 'compile_version_unsupported'],
    [422, 'compile_mode_unsupported'],
    [422, 'compile_cognition_unsupported'],
    [422, 'compile_limit'],
    [422, 'compile_new_intent_required'],
    [500, 'internal_error'],
    [500, 'compile_disclosure_refused'],
    [503, 'compile_busy'],
    [503, 'compile_replay_capacity'],
    [503, 'stopping'],
  ])('types the %i %s refusal as NikaOperationError', async (status, code) => {
    const fetch = respond(jsonResponse({ error: { code, message: `the server said ${code}` } }, status));
    const error = await failure(client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider', limits: { max_calls: 6 } }));
    expect(error).toBeInstanceOf(NikaOperationError);
    expect(error).toMatchObject({ operation: 'compile', transport: 'http', status, code, machineCode: code });
    expect(error.message).toContain(`HTTP ${status} for /v1/compile: ${code}`);
  });

  it('an intent.clarification answer reaches the server, whose refusal is typed', async () => {
    const fetch = respond(jsonResponse({ error: { code: 'compile_new_intent_required',
      message: 'intent.clarification replaces the request: send the complete replacement as a new create intent' } }, 422));
    const error = await failure(client(fetch).compile({
      intent: INTENT, cognition: 'explicitProvider', answers: { 'intent.clarification': 'Summarize weekly instead' },
    }));
    expect(error).toMatchObject({ name: 'NikaOperationError', code: 'compile_new_intent_required', status: 422 });
    expect(JSON.parse(posted(fetch, 1).body).answers).toEqual({ 'intent.clarification': 'Summarize weekly instead' });
  });

  it('never quotes a malformed replay header', async () => {
    const forged = 'Z'.repeat(64);
    const fetch = respond(jsonResponse(fresh(), 200, { 'Nika-Compile-Replay': forged }));
    const error = await failure(client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' }));
    expect(error).toBeInstanceOf(NikaProtocolError);
    expect(error.message).toMatch(/malformed Nika-Compile-Replay/);
    expect(error.message).not.toContain(forged);
    expect(inspect(error)).not.toContain(forged);
  });

  it.each<[string, NikaCompileRequest, () => Response, RegExp]>([
    ['a token answered to a generation-1 request', { intent: 'hello' },
      () => jsonResponse(document(1), 200, kept), /token to a request that keeps no round/],
    ['a token answered to a replay', { intent: INTENT, cognition: 'deterministicOnly', replay_token: REPLAY },
      () => jsonResponse(replayed(), 200, kept), /token to a request that keeps no round/],
    ['a ready candidate the verifier held', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ status: 'ready', candidate: 'nika: x\n',
        diagnostics: [{ kind: 'applied', target: 'verify_held', message: 'held' }] })), /verify_held or verify_resume marker/],
    ['a ready candidate no judgment admitted', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ status: 'ready', candidate: 'nika: x\n',
        diagnostics: [{ kind: 'applied', target: 'verify_resume', message: 'not judged' }] })), /verify_held or verify_resume marker/],
    ['generation 2 without its receipt', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ provenance: { ...PROVENANCE_V2, authoring: undefined } })), /compile_version 2 outcome carries no provenance\.authoring receipt/],
    ['generation 1 with a receipt', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(document(1, { provenance: { ...PROVENANCE_V1, authoring: RECEIPT } })), /compile_version 1 outcome carries a provider-call receipt/],
    ['a receipt without its calls', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ provenance: { ...PROVENANCE_V2, authoring: { ...RECEIPT, calls: '2' } } })), /provenance\.authoring lacks its/],
    ['a receipt with a non-object backend', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ provenance: { ...PROVENANCE_V2, authoring: { ...RECEIPT, backend: 'mistral' } } })), /provenance\.authoring lacks its/],
    ['an unknown cognition word', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ provenance: { ...PROVENANCE_V2, cognition: 'implicitProvider' } })), /provenance lacks its compiler_version\/spec_pin\/skeleton\/cognition shape/],
    ['a strategy that is no word', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ provenance: { ...PROVENANCE_V2, strategy: 7 } })), /provenance\.strategy is not a word/],
    ['a plan that is no record', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ provenance: { ...PROVENANCE_V2, plan: 'kept' } })), /provenance\.plan is not an object/],
    ['choice options without labels', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ questions: [{ ...CHOICE, options: [{ key: 'team' }] }] })), /options lack their key\/label shape/],
    ['a trigger without its status', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ requested_trigger: { ...TRIGGER, status: undefined } })), /requested_trigger lacks its kind\/status shape/],
    ['a trigger field that is no text', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ requested_trigger: { ...TRIGGER, cron: 9 } })), /requested_trigger\.cron is neither text nor null/],
    ['a local engine fact on the HTTP door', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ plan_record_error: { path: '.nika/compile/x.plan.json', message: 'denied' } })), /carries the local engine's plan_record_error/],
    ['an existing destination on the HTTP door', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ existing_destination: 'x.nika' })), /carries the local engine's existing_destination/],
  ])('refuses %s as a protocol fault', async (_case, request, response, message) => {
    const error = await failure(client(respond(response())).compile(request));
    expect(error).toBeInstanceOf(NikaProtocolError);
    expect(error.message).toMatch(message);
  });

  it.each<[string, NikaCompileRequest, () => Response, RegExp]>([
    ['a generation-2 answer to a replay', { intent: INTENT, cognition: 'deterministicOnly', replay_token: REPLAY },
      () => jsonResponse(fresh()), /compile wire 2; expected 1$/],
    ['a generation-2 answer to a generation-1 request', { intent: 'hello' },
      () => jsonResponse(fresh()), /compile wire 2; expected 1$/],
    ['a future generation to a provider round', { intent: INTENT, cognition: 'explicitProvider' },
      () => jsonResponse(fresh({ compile_version: 3 })), /compile wire 3; expected 1 or 2$/],
  ])('refuses %s as a generation the request cannot receive', async (_case, request, response, message) => {
    const fetch = vi.fn().mockResolvedValueOnce(server()).mockResolvedValueOnce(response());
    const error = await failure(client(fetch).compile(request));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error.message).toMatch(message);
  });

  it('sets no SDK deadline on a provider round without timeoutMs or limits.deadline_ms', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return server();
      // Longer than requestTimeout: a generation-1 request would have been stopped. The
      // engine sets no default round deadline either (serve compile/native.rs).
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(init?.signal).toBeUndefined();
      return jsonResponse(fresh(), 200, kept);
    });
    const outcome = await client(fetch, { requestTimeout: 20 }).compile({ intent: INTENT, cognition: 'explicitProvider' });
    expect(outcome.replay_token).toBe(REPLAY);
  });

  it('with limits.deadline_ms, waits past requestTimeout for the server\'s own deadline refusal', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return server();
      expect(init?.signal).toBeInstanceOf(AbortSignal); // deadline 50 ms + 5 s handoff + requestTimeout
      await new Promise((resolve) => setTimeout(resolve, 120));
      return jsonResponse({ error: { code: 'compile_deadline_exceeded', message: 'the native round reached its deadline' } }, 408);
    });
    const error = await failure(client(fetch, { requestTimeout: 20 }).compile({
      intent: INTENT, cognition: 'explicitProvider', limits: { deadline_ms: 50 },
    }));
    expect(error).toBeInstanceOf(NikaOperationError);
    expect(error).toMatchObject({ code: 'compile_deadline_exceeded', status: 408 });
  });

  it('keeps requestTimeout on /health when a provider round has only a caller signal', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const error = await failure(client(fetch, { requestTimeout: 30 }).compile(
      { intent: INTENT, cognition: 'explicitProvider' }, { signal: controller.signal },
    ));
    expect(error).toBeInstanceOf(NikaTransportError);
    expect(error.message).toBe('HTTP request timed out after 30ms');
    expect(controller.signal.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads a generation-2 answer beyond machineBufferBytes, up to the 8 MiB compile bound', async () => {
    const preview = `nika: digest\n# ${'x'.repeat(100 * 1024)}\n`;
    const fetch = respond(jsonResponse(fresh({ candidate: preview }), 200, kept));
    const outcome = await client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' });
    expect(outcome.candidate).toBe(preview);
  });

  it('keeps a generation-1 answer within machineBufferBytes, as before', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(server()).mockResolvedValueOnce(
      jsonResponse(document(1, { candidate: `nika: big\n# ${'x'.repeat(100 * 1024)}\n` })));
    const error = await failure(client(fetch).compile('hello'));
    expect(error).toBeInstanceOf(NikaProtocolError);
    expect(error.message).toMatch(/exceeded 65536 bytes/);
  });

  it('still bounds a provider round by an explicit timeoutMs', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return Promise.resolve(server());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const error = await failure(client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' }, { timeoutMs: 40 }));
    expect(error).toBeInstanceOf(NikaTransportError);
    expect(error.message).toBe('compile timed out after 40 ms');
  });

  it('keeps the client requestTimeout on a replay, which the server answers within its request deadline', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/health')) return Promise.resolve(server());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const error = await failure(client(fetch, { requestTimeout: 30 }).compile({
      intent: INTENT, cognition: 'deterministicOnly', replay_token: REPLAY,
    }));
    expect(error.message).toBe('compile timed out after 30 ms');
  });
});

describe('compileTimeoutMs (the client deadline of one HTTP compile)', () => {
  const create = { intent: 'x' };
  it.each<[string, Parameters<typeof compileTimeoutMs>, number | undefined]>([
    ['the caller\'s timeoutMs wins', [{ ...create, cognition: 'explicitProvider', limits: { deadline_ms: 9_000 } }, true, 1_234, 30_000], 1_234],
    ['a generation-1 request keeps requestTimeout', [create, false, undefined, 30_000], 30_000],
    ['a replay keeps requestTimeout', [{ ...create, cognition: 'deterministicOnly', replay_token: REPLAY }, false, undefined, 30_000], 30_000],
    ['a provider round without a deadline has none', [{ ...create, cognition: 'explicitProvider' }, true, undefined, 30_000], undefined],
    ['a judged answer round is a provider round', [{ ...create, cognition: 'explicitProvider', replay_token: REPLAY }, true, undefined, 30_000], undefined],
    ['a provider round waits for its deadline, the handoff and requestTimeout',
      [{ ...create, cognition: 'explicitProvider', limits: { deadline_ms: 120_000 } }, true, undefined, 30_000],
      120_000 + COMPILE_SERVER_HANDOFF_MS + 30_000],
    ['the derived deadline stays a valid timer', [{ ...create, cognition: 'explicitProvider', limits: { deadline_ms: Number.MAX_SAFE_INTEGER } }, true, undefined, 30_000], 0x7fffffff],
  ])('%s', (_case, args, expected) => {
    expect(compileTimeoutMs(...args)).toBe(expected);
  });
});
