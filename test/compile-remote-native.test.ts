/** Protocol doubles: verify SDK behavior, not provider intelligence or a release binary. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaConfigurationError, NikaProtocolError } from '../src/index.js';
import type { NikaCompileRemoteAuthoring } from '../src/index.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

const bin = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const log = path.join(tmpdir(), `nika-remote-native-${process.pid}.log`);
const token = '0123456789abcdef'.repeat(4);
const fresh = { remoteAuthoring: { cognition: 'explicitProvider' as const } };
const replay = { remoteAuthoring: { cognition: 'deterministicOnly' as const, replayToken: token } };
const caps = ['check', 'executionSnapshot', 'eventStream', 'trace', 'compile', 'compileNativeV2'];
const v2 = JSON.parse(readFileSync(new URL('./fixtures/compile-v2.json', import.meta.url), 'utf8'));
const v1 = { compile_version: 1, status: 'ready', candidate: 'source', questions: [], diagnostics: [],
  requested_boundary: null, check_preview: null,
  provenance: { compiler_version: '0.120.3', spec_pin: 'double', skeleton: null, cognition: 'deterministicOnly' } };
function client(fetch: typeof globalThis.fetch) {
  process.env.NIKA_FAKE_ARGV_LOG = log;
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, bin, fetch });
}
function responses(...values: Response[]) {
  const fetch = vi.fn().mockResolvedValueOnce(healthResponse({ supportedCapabilities: caps }));
  for (const value of values) fetch.mockResolvedValueOnce(value);
  return fetch;
}
const kept = () => jsonResponse(v2, 200, { 'Nika-Compile-Replay': token });

describe('explicit HTTP native authoring and server-kept replay', () => {
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    const spawned = existsSync(log); rmSync(log, { force: true });
    expect(spawned, 'HTTP must not probe or launch a local compiler').toBe(false);
  });

  it('keeps exact hostile input and typed answers across author then zero-cognition replay', async () => {
    const fetch = responses(kept(), jsonResponse(v1));
    const nika = client(fetch);
    const intent = '  雪 "quoted"\r\n--model=evil $(touch nope) </script> &  ';
    const first = await nika.compile(intent, { remoteAuthoring: { cognition: 'explicitProvider',
      limits: { repairs: 0, maxTokens: 2048, callTimeoutMs: 5000, deadlineMs: 10000 } } });
    expect(first).toEqual({ ...v2, ready: false, replayToken: token });
    const answers = { model: 'operator-choice', 'const.request': ['雪', null, false, 1.2345678901234567] };
    const second = await nika.compile({ intent, answers }, { remoteAuthoring: {
      cognition: 'deterministicOnly', replayToken: first.replayToken!,
    } });
    expect(second).toEqual({ ...v1, ready: true });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ compile_version: 2, mode: 'create',
      cognition: 'explicitProvider', intent, limits: { repairs: 0, max_tokens: 2048, call_timeout_ms: 5000, deadline_ms: 10000 } });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ compile_version: 2, mode: 'create',
      cognition: 'deterministicOnly', intent, answers, replay_token: token });
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(init.headers.get('Authorization')).toBe(`Bearer ${TOKEN_A}`);
      expect(init.headers.has('Idempotency-Key')).toBe(false);
      expect(init.redirect).toBe('error');
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://nika.example/health', 'https://nika.example/v1/compile', 'https://nika.example/v1/compile',
    ]);
  });

  it.each([fresh, replay])('projects source revision with exact original context %#', async (options) => {
    const fetch = responses(jsonResponse(v1));
    const request = { workflow: 'nika: source\r\n', change: '  also write ./c.md\n', originalIntent: '  Read ./a.md\r\n' };
    await client(fetch).compile(request, options);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ compile_version: 2, mode: 'edit',
      cognition: options.remoteAuthoring.cognition, source: request.workflow, change: { text: request.change },
      original_intent: request.originalIntent, ...(options === replay ? { replay_token: token } : {}) });
  });

  it('retains structured edits and accepts deterministic results without a replay token', async () => {
    const fetch = responses(jsonResponse(v1));
    const change = { set_constant: { name: 'request', value: { x: [false, null, '雪'] } } };
    expect(await client(fetch).compile({ workflow: 'source', change }, fresh)).not.toHaveProperty('replayToken');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ compile_version: 2, mode: 'edit',
      cognition: 'explicitProvider', source: 'source', change });
  });

  it('leaves v1 bytes unchanged and opts into nothing from answers', async () => {
    const fetch = responses(jsonResponse(v1));
    await client(fetch).compile({ intent: 'hello', answers: { model: 'paid/model' } });
    expect(fetch.mock.calls[1][1].body).toBe('{"compile_version":1,"mode":"create","intent":"hello","answers":{"model":"paid/model"}}');
  });

  it('serializes bounded deep literals without a JavaScript stack error; the server judges their meaning', async () => {
    let value: unknown = null;
    for (let i = 0; i < 8000; i++) value = [value];
    const fetch = responses(jsonResponse({ error: { code: 'compile_malformed', message: 'depth refused' } }, 422));
    await expect(client(fetch).compile({ intent: 'x', answers: { x: value } }, fresh))
      .rejects.toMatchObject({ name: 'NikaOperationError', status: 422 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].body).toContain('['.repeat(8000) + 'null' + ']'.repeat(8000));
  });

  it.each([{ supported: ['compile'] }, { supported: ['compileNativeV2'] }, { supported: [] }])('requires both health capabilities ($supported) before POST', async ({ supported }) => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse({ supportedCapabilities: [...caps.slice(0, 4), ...supported] }));
    await expect(client(fetch).compile('hello', fresh)).rejects.toMatchObject({ name: 'NikaCompatibilityError', transport: 'http' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, {}, { cognition: 'ambient' }, { cognition: 'explicitProvider', model: 'paid/model' },
    { cognition: 'explicitProvider', knowledge: '/private/context' },
    { cognition: 'explicitProvider', endpoint: 'https://elsewhere' },
    { cognition: 'explicitProvider', replayToken: token },
    { cognition: 'explicitProvider', limits: null },
    { cognition: 'explicitProvider', limits: { toString: 1 } },
    { cognition: 'explicitProvider', limits: JSON.parse('{"__proto__":1}') },
    { cognition: 'explicitProvider', limits: { repairs: 6 } },
    { cognition: 'explicitProvider', limits: { repairs: -1 } },
    { cognition: 'explicitProvider', limits: { maxTokens: 32769 } },
    { cognition: 'explicitProvider', limits: { maxTokens: 0 } },
    { cognition: 'explicitProvider', limits: { deadlineMs: 3600001 } },
    { cognition: 'explicitProvider', limits: { deadlineMs: NaN } },
    { cognition: 'explicitProvider', limits: { callTimeoutMs: 600001 } },
    { cognition: 'explicitProvider', limits: { callTimeoutMs: 1.5 } },
    { cognition: 'explicitProvider', limits: { repairs: null } },
    { cognition: 'explicitProvider', limits: { repairs: undefined } },
    { cognition: 'deterministicOnly' }, { cognition: 'deterministicOnly', replayToken: token.toUpperCase() },
    { cognition: 'deterministicOnly', replayToken: token, limits: {} },
  ])('rejects invalid remote option %# before any I/O', async (remoteAuthoring) => {
    const fetch = vi.fn();
    await expect(client(fetch).compile('hello', { remoteAuthoring: remoteAuthoring as NikaCompileRemoteAuthoring }))
      .rejects.toBeInstanceOf(NikaConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses accessors and proxies without inspecting them', async () => {
    const read = vi.fn();
    for (const remoteAuthoring of [Object.defineProperty({}, 'cognition', { get: read, enumerable: true }),
      new Proxy({}, { ownKeys: read })]) {
      const fetch = vi.fn();
      await expect(client(fetch).compile('hello', { remoteAuthoring: remoteAuthoring as NikaCompileRemoteAuthoring }))
        .rejects.toBeInstanceOf(NikaConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses local/remote option mixing and remote options on the local door before probing', async () => {
    const fetch = vi.fn();
    await expect(client(fetch).compile('hello', { ...fresh, authoring: { model: 'vllm/local' } })).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(new Nika({ bin }).compile('hello', replay)).rejects.toMatchObject({ name: 'NikaCompatibilityError', transport: 'native-process' });
  });

  it.each([
    { workflow: 'src', change: 'change' },
    { workflow: 'src', change: { set_constant: { name: 'x', value: 1 } }, originalIntent: 'old' },
    { intent: '雪'.repeat(1366) },
    { workflow: 'x'.repeat(512 * 1024 + 1), change: 'x', originalIntent: 'old' },
    { intent: 'x', answers: { 'intent.clarification': 'different' } },
    { intent: 'x', answers: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`k${n}`, n])) },
    { intent: 'x', answers: { ['k'.repeat(257)]: true } },
    { intent: 'x', answers: { x: 'y'.repeat(64 * 1024) } },
    { intent: 'x', answers: Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`k${n}`, 'x'.repeat(65000)])) },
  ])('rejects untranslatable or oversized input %# before health', async (request) => {
    const fetch = vi.fn();
    await expect(client(fetch).compile(request as any, fresh)).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['compile_replay_unavailable', 'compile_replay_input_changed', 'compile_context_changed', 'compile_limit'])('preserves refusal %s without retrying authoring', async (code) => {
    const fetch = responses(jsonResponse({ error: { code, message: `withheld ${token} ${TOKEN_A}` } }, 409));
    const error = await client(fetch).compile('hello', replay).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'NikaOperationError', status: 409, machineCode: code });
    expect(inspect(error)).not.toContain(token); expect(inspect(error)).not.toContain(TOKEN_A);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['bad token', token + ',' + token, TOKEN_A])('rejects malformed replay header without reflecting it (%#)', async (header) => {
    const fetch = responses(jsonResponse(v2, 200, { 'Nika-Compile-Replay': header }));
    const error = await client(fetch).compile('hello', fresh).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NikaProtocolError); expect(inspect(error)).not.toContain(header);
  });

  it.each([undefined, replay])('rejects unexpected replay headers outside fresh native authoring %#', async (options) => {
    await expect(client(responses(kept())).compile('hello', options)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('does not expose credentials or request bodies from fetch error causes', async () => {
    const fetch = responses(); fetch.mockRejectedValueOnce(new Error(`body replay_token=${token}; Bearer ${TOKEN_A}`));
    const error = await client(fetch).compile('hello', replay).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'NikaTransportError' });
    expect(inspect(error)).not.toContain(token); expect(inspect(error)).not.toContain(TOKEN_A);
    expect(error).not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('drops JSON parser causes that can quote a reflected token', async () => {
    const fetch = responses(new Response(`{"x":"${token} ${TOKEN_A}" trailing}`, { headers: { 'Content-Type': 'application/json' } }));
    const error = await client(fetch).compile('hello', replay).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NikaProtocolError);
    expect(error).not.toHaveProperty('cause');
    expect(inspect(error)).not.toContain(token); expect(inspect(error)).not.toContain(TOKEN_A);
  });

  it.each(['abort', 'timeout'])('bounds native response observation on %s without retry', async (mode) => {
    const cancel = vi.fn(); const controller = new AbortController();
    const fetch = responses(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = client(fetch).compile('hello', { ...fresh, signal: controller.signal, timeoutMs: 50 });
    if (mode === 'abort') setTimeout(() => controller.abort(new Error(token)), 10);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'NikaTransportError' });
    expect(inspect(error)).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
  });
});
