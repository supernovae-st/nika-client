import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaConfigurationError } from '../src/index.js';
import { compileRequest } from '../src/lib/compile.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// `observed_world` on `POST /v1/compile` generation 2 (engine 0.123 integration
// line, `nika-serve/src/server/compile/v2.rs` and
// `nika-cli-host/src/compile/observe.rs`): over HTTP the SDK asks the LOCAL
// engine what it observes of the files the request states (`nika compile
// --observe-only`, in the client's cwd) and forwards that document unchanged,
// so the remote seat never asks the user for a shape it could have read. The
// fetch is mocked; the local engine is the compile fixture.

const COMPILE_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const argvLog = path.join(tmpdir(), `nika-sdk-compile-observed-${process.pid}.log`);
const REPLAY = '0123456789abcdef'.repeat(4);
const NATIVE = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'compileNativeV2',
  'compileJudgedAnswerRound'];
const OBSERVING = [...NATIVE, 'compileObservedWorld'];
const INTENT = 'For every appointment in ./calendar.json, save a reminder list to ./out/reminders.json';
/** The fixture's synthetic observation of `./calendar.json`, as the engine prints it. */
const WORLD = {
  observed: [{ path: './calendar.json', state: 'observed', complete: true, kind: 'json',
    columns: ['appointments', 'owner'], bytes: 512, peek_sha256: 'e'.repeat(64) }],
  kinds: { './calendar.json': { sampled: 1, nested: { paths: { 'appointments[].start': { text: 3 } } } } },
};
const RECEIPT = {
  model: 'deepseek/deepseek-v4-pro', calls: 1, input_tokens: 10, output_tokens: 5, elapsed_ms: 20,
  sampling: { temperature: null, seed: null, effective: 'providerDefaultUnknown' },
  context: [{ role: 'author', instruction_sha256: 'a'.repeat(64), message_bytes: 4096 }],
  backend: { kind: 'direct', provider: 'deepseek', requested_model: 'deepseek/deepseek-v4-pro',
    observed_models: ['deepseek-v4-pro'], unreported_models: 0, usage_complete: true,
    cost_basis: 'unpriced; billing_unverified', authority: { max_calls: null, source: 'default: no request bound',
      invocations: { sent: 1, refused: 0 }, http_requests: { sent: 1, refused: 0, unknown: null } },
    host: 'api.deepseek.com', base_url_overridden: false, endpoint_basis: 'operator_configuration' },
};
const PROVENANCE_V1 = {
  compiler_version: '0.123.0', spec_pin: 'be8ff017d448c4d4e413d11c40613af0afb90754', skeleton: null,
  cognition: 'deterministicOnly', suggested_file: null,
};
const OUTCOME = {
  compile_version: 2, status: 'incomplete', candidate: null, questions: [], diagnostics: [],
  requested_boundary: null, requested_trigger: null, check_preview: null,
  provenance: { ...PROVENANCE_V1, cognition: 'explicitProvider', strategy: 'native',
    plan: { semantic_record: {} }, authoring: RECEIPT },
};
const REPLAYED = { ...OUTCOME, compile_version: 1, provenance: PROVENANCE_V1 };

function client(fetch: typeof globalThis.fetch) {
  process.env.NIKA_FAKE_ARGV_LOG = argvLog;
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: COMPILE_ENGINE, fetch });
}
function respond(capabilities: string[], ...responses: Response[]) {
  const fetch = vi.fn().mockResolvedValueOnce(healthResponse({ supportedCapabilities: capabilities, traceFormatVersion: 2 }));
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}
function body(fetch: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const [url, init] = fetch.mock.calls[index]!;
  expect(url).toBe('https://nika.example/v1/compile');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}
function spawned(): string[][] {
  try {
    return readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

describe('HTTP compile: the local observation of the stated files (observed_world)', () => {
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    rmSync(argvLog, { force: true });
  });

  it('sends the local engine\'s observation with a provider round on a server that admits it', async () => {
    const fetch = respond(OBSERVING, jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }));
    await client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' });
    const sent = body(fetch, 1);
    expect(sent.observed_world).toEqual(WORLD);
    expect(sent.intent).toBe(INTENT);
    // The engine observed the intent itself: one bounded child, never a file read by the SDK.
    expect(spawned()).toContainEqual(['compile', '--observe-only', '--', INTENT]);
  });

  it('sends the observed files for a trial only to a server that tries candidates', async () => {
    const fetch = respond([...OBSERVING, 'compileTrialInputs'],
      jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }));
    await client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' });
    const sent = body(fetch, 1);
    expect(sent.observed_world).toEqual(WORLD);
    expect(sent.trial_inputs).toEqual({ files: [{ path: './calendar.json', text: '{"owner":"o","appointments":[]}' }] });
    const plain = respond(OBSERVING, jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }));
    await client(plain).compile({ intent: INTENT, cognition: 'explicitProvider' });
    expect(body(plain, 1)).not.toHaveProperty('trial_inputs');
  });

  it('repeats the observation on the kept round\'s judged answer round and its replay', async () => {
    const fetch = respond(OBSERVING,
      jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }),
      jsonResponse(REPLAYED, 200, { 'Cache-Control': 'no-store' }));
    const nika = client(fetch);
    await nika.compile({ intent: INTENT, cognition: 'explicitProvider', replay_token: REPLAY });
    await nika.compile({ intent: INTENT, cognition: 'deterministicOnly', replay_token: REPLAY });
    expect(body(fetch, 1).observed_world).toEqual(WORLD);
    expect(body(fetch, 2).observed_world).toEqual(WORLD);
  });

  it('observes a text revision over its original request and its change', async () => {
    const fetch = respond(OBSERVING, jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }));
    await client(fetch).compile({ workflow: 'nika: r\ntasks: {}\n', change: 'also skip cancelled ones',
      original_intent: INTENT, cognition: 'explicitProvider' });
    expect(body(fetch, 1).observed_world).toEqual(WORLD);
    expect(spawned()).toContainEqual(['compile', '--observe-only', '--', `${INTENT}\nalso skip cancelled ones`]);
  });

  it('sends nothing when the engine observes nothing, or when the caller opts out', async () => {
    const fetch = respond(OBSERVING,
      jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }),
      jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }));
    const nika = client(fetch);
    await nika.compile({ intent: 'Summarize the week', cognition: 'explicitProvider' });
    expect(body(fetch, 1)).not.toHaveProperty('observed_world');
    const before = spawned().length;
    await nika.compile({ intent: INTENT, cognition: 'explicitProvider' }, { observe: false });
    expect(body(fetch, 2)).not.toHaveProperty('observed_world');
    expect(spawned().length).toBe(before);
  });

  it('never observes for a generation-1 request or on a server that does not admit it', async () => {
    const fetch = respond(NATIVE,
      jsonResponse(OUTCOME, 200, { 'Cache-Control': 'no-store' }),
      jsonResponse(REPLAYED, 200));
    const nika = client(fetch);
    await nika.compile({ intent: INTENT, cognition: 'explicitProvider' });
    expect(body(fetch, 1)).not.toHaveProperty('observed_world');
    await nika.compile({ intent: INTENT });
    expect(body(fetch, 2)).not.toHaveProperty('observed_world');
    expect(spawned().filter((argv) => argv.includes('--observe-only'))).toEqual([]);
  });

  it('refuses typed, before posting, when the observation is required but not served', async () => {
    const fetch = respond(NATIVE);
    const error = await client(fetch).compile({ intent: INTENT, cognition: 'explicitProvider' }, { observe: true })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'compileObservedWorld', transport: 'http' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses typed, before posting, when the local engine cannot observe', async () => {
    const fetch = respond(OBSERVING);
    const error = await client(fetch)
      .compile({ intent: `${INTENT} unobservable`, cognition: 'explicitProvider' })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect((error as Error).message).toMatch(/observe: false/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('validates the option and keeps the observation off generation 1', async () => {
    const fetch = respond(OBSERVING);
    await expect(client(fetch).compile({ intent: INTENT }, { observe: 'yes' as unknown as boolean }))
      .rejects.toBeInstanceOf(NikaConfigurationError);
    expect(() => compileRequest({ intent: INTENT }, { world: '{"observed":[]}' }))
      .toThrow(NikaConfigurationError);
    expect(compileRequest({ intent: INTENT, cognition: 'explicitProvider' }, { world: '{"observed":[]}' }).body)
      .toMatch(/,"observed_world":\{"observed":\[\]\}\}$/);
    expect(compileRequest({ intent: INTENT, cognition: 'explicitProvider' },
      { world: '{"observed":[]}', trial: '{"files":[]}' }).body)
      .toMatch(/,"observed_world":\{"observed":\[\]\},"trial_inputs":\{"files":\[\]\}\}$/);
  });
});
