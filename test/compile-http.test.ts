import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Nika, NikaCompatibilityError, NikaConfigurationError,
  NikaOperationError, NikaProtocolError, NikaTransportError,
} from '../src/index.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

const COMPILE_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const argvLog = path.join(tmpdir(), `nika-sdk-compile-http-${process.pid}.log`);
const health = () => healthResponse({ supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'compile'] });
const outcome = (overrides: Record<string, unknown> = {}) => ({
  compile_version: 1, status: 'ready', candidate: 'nika: candidate\n',
  questions: [], diagnostics: [], requested_boundary: null, check_preview: null,
  provenance: { compiler_version: '0.120.0', spec_pin: 'pin', skeleton: null, cognition: 'deterministicOnly' },
  ...overrides,
});
function client(fetch: typeof globalThis.fetch, extra = {}) {
  process.env.NIKA_FAKE_ARGV_LOG = argvLog;
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: COMPILE_ENGINE, fetch, ...extra });
}
function respond(response: Response) {
  return vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(response);
}
function waitingBody() {
  const cancel = vi.fn();
  return { cancel, response: new Response(new ReadableStream({ cancel }), {
    headers: { 'Content-Type': 'application/json' },
  }) };
}
function waitForAbort(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(init.signal.reason);
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
}

describe('authenticated HTTP compile foundation', () => {
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    const spawned = existsSync(argvLog);
    rmSync(argvLog, { force: true });
    expect(spawned, 'HTTP compile must never spawn a local engine').toBe(false);
  });

  it('refuses an old Serve after health alone', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    await expect(client(fetch).compile('hello')).rejects.toMatchObject({
      name: 'NikaCompatibilityError', capability: 'compile', transport: 'http',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['ready', 'incomplete', 'refused'])('preserves %s as data and authenticates POST', async (status) => {
    const wire = outcome({ status, candidate: status === 'ready' ? 'source' : null });
    const fetch = respond(jsonResponse(wire));
    const result = await client(fetch).compile({ intent: 'hello', answers: { 'const.request': ['雪', 1.2345678901234567, false, null] } });
    expect(result).toEqual({ ...wire, ready: status === 'ready' });
    expect(result).not.toHaveProperty('written');
    expect(result).not.toHaveProperty('exitCode');
    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe('https://nika.example/v1/compile');
    expect(init.method).toBe('POST');
    expect(init.headers.get('Authorization')).toBe(`Bearer ${TOKEN_A}`);
    expect(init.headers.get('Content-Type')).toBe('application/json');
    expect(init.headers.has('Idempotency-Key')).toBe(false);
    expect(JSON.parse(init.body)).toEqual({ compile_version: 1, mode: 'create', intent: 'hello', answers: { 'const.request': ['雪', 1.2345678901234567, false, null] } });
  });

  it.each([
    ['Set const.request to "snow"', { text: 'Set const.request to "snow"' }],
    [{ set_constant: { name: 'request', value: { '雪': ['"quoted"', null, true, 1.23e100] } } },
      { set_constant: { name: 'request', value: { '雪': ['"quoted"', null, true, 1.23e100] } } }],
  ])('sends edit source and exact change vocabulary', async (change, expected) => {
    const fetch = respond(jsonResponse(outcome()));
    const workflow = 'nika: base\r\nconst: { request: "é" }\n';
    await client(fetch).compile({ workflow, change: change as any });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ compile_version: 1, mode: 'edit', source: workflow, change: expected });
  });

  it.each([401, 408, 413, 415, 422, 500, 503])('preserves typed HTTP %i refusal', async (status) => {
    const fetch = respond(jsonResponse({ error: { code: 'compile_refusal', message: 'Rejected' } }, status));
    await expect(client(fetch).compile('hello')).rejects.toMatchObject({
      name: 'NikaOperationError', operation: 'compile', transport: 'http', status, machineCode: 'compile_refusal',
    });
  });

  it('redacts reflected credentials in errors', async () => {
    const fetch = respond(jsonResponse({ error: { code: 'compile_busy', message: `No ${TOKEN_A}` } }, 503));
    await expect(client(fetch).compile('hello')).rejects.toThrow('No [REDACTED]');
  });

  it('rejects incompatible health before POST', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse({ machineProtocolVersion: 999, supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'compile'] }));
    await expect(client(fetch).compile('hello')).rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a different compile generation', async () => {
    const fetch = respond(jsonResponse(outcome({ compile_version: 2 })));
    await expect(client(fetch).compile('hello')).rejects.toBeInstanceOf(NikaCompatibilityError);
  });

  it.each([
    () => jsonResponse(outcome({ status: 'other' })),
    () => jsonResponse(outcome({ candidate: null })),
    () => jsonResponse(outcome({ questions: [{}] })),
    () => jsonResponse(outcome({ diagnostics: [{}] })),
    () => jsonResponse(outcome({ requested_boundary: [] })),
    () => jsonResponse(outcome({ check_preview: {} })),
    () => jsonResponse(outcome({ provenance: {} })),
    () => jsonResponse(outcome({ written: null })),
    () => jsonResponse(outcome({ error: { code: 'bad', message: 'bad' } })),
    () => jsonResponse({ error: {} }, 422),
    () => jsonResponse(outcome(), 202),
    () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}'),
    () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
  ])('rejects malformed/contradictory response %#', async (response) => {
    await expect(client(respond(response())).compile('hello')).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('bounds streamed responses and cancels the stream on overflow', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9 * 1024 * 1024)); }, cancel }), {
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(client(respond(response)).compile('hello')).rejects.toThrow(/exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('aborts before health with no requests', async () => {
    const fetch = vi.fn();
    const controller = new AbortController(); controller.abort();
    await expect(client(fetch).compile('hello', { signal: controller.signal })).rejects.toThrow(/aborted by caller/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts while waiting for health without posting', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(waitForAbort);
    const pending = client(fetch).compile('hello', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted by caller/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['health', 'post', 'body'])('times out while waiting for %s', async (phase) => {
    const fetch = phase === 'health' ? vi.fn(waitForAbort)
      : phase === 'post' ? vi.fn().mockResolvedValueOnce(health()).mockImplementationOnce(waitForAbort)
      : respond(waitingBody().response);
    await expect(client(fetch).compile('hello', { timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  it('aborts a stalled response body, including an error body', async () => {
    for (const status of [200, 503]) {
      const stalled = waitingBody();
      const controller = new AbortController();
      const fetch = respond(new Response(stalled.response.body, { status, headers: { 'Content-Type': 'application/json' } }));
      const pending = client(fetch).compile('hello', { signal: controller.signal });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted by caller/);
      expect(stalled.cancel).toHaveBeenCalledOnce();
    }
  });

  it('rejects malformed signals and non-JSON answers before HTTP', async () => {
    const fetch = vi.fn();
    await expect(client(fetch).compile('hello', { signal: {} as AbortSignal })).rejects.toBeInstanceOf(NikaConfigurationError);
    await expect(client(fetch).compile({ intent: 'hello', answers: { x: BigInt(1) } })).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
