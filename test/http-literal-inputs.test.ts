import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
} from '../src/index.js';
import type { NikaRunOptions } from '../src/index.js';
import { resolveNikaEngine } from '../src/lib/binary/index.js';
import { HttpTransport } from '../src/lib/http-transport.js';
import { LITERAL_INPUTS_MAX_BYTES, encodeLiteralInputs } from '../src/lib/literal-inputs.js';
import {
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseResponse,
} from './helpers/http-depth-harness.js';

// Issue #116 · the HTTP half of `run({ inputs })` (engine nika#1642):
//
//   inputs ─▶ strict JSON ─▶ by served name? ─▶ /health advertises `jobInputs`?
//     POST /v1/jobs {"workflow":"<name>","inputs":{…}}
//
// A resident from before the envelope answered 202 to a body with an extra
// `inputs` field and applied nothing, so a 202 is never the negotiation: the
// advertised capability is. A snapshot freezes its inputs and takes no overlay.

/** What the resident of engine #1682 advertises on /health. */
const WITH_JOB_INPUTS = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs'];

const RECEIPT = Object.freeze({
  job_id: 'job-1',
  execution_id: 'execution-1',
  trace_id: 'trace-1',
  snapshot_digest: 'f'.repeat(64),
  origin: { kind: 'manual' },
});

function remote(fetch: ReturnType<typeof vi.fn>): Nika {
  return new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    fetch: fetch as typeof globalThis.fetch,
  });
}

function request(
  fetch: ReturnType<typeof vi.fn>,
  index: number,
): { url: string; init: RequestInit } {
  const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
  return { url: String(url), init };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error('expected a refusal');
}

describe('run by served name carries literal inputs (issue #116 · engine #1642)', () => {
  it('posts the serialized map as `inputs`, byte for byte, once the resident advertises jobInputs', async () => {
    const inputs = {
      ticket: '@env:SERVER_SECRET',
      expression: '${{ tasks.x.output }}',
      numeral: '42',
      count: 42,
      tags: ['é', '東京'],
      record: { name: '🦋', nothing: null },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ supportedCapabilities: WITH_JOB_INPUTS }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([{
        sequence: 1,
        kind: 'execution.settled',
        status: 'succeeded',
        outputs: { value: inputs },
        receipt: RECEIPT,
      }]));
    const nika = remote(fetch);
    const run = await nika.run('triage.nika.yaml', { inputs, idempotencyKey: 'triage-42' });

    const { url, init } = request(fetch, 1);
    expect(url).toBe('https://nika.example/v1/jobs');
    expect(init.method).toBe('POST');
    // The same bytes the native transport writes to stdin ride the envelope.
    expect(init.body).toBe(`{"workflow":"triage.nika.yaml","inputs":${encodeLiteralInputs(inputs).json}}`);
    expect(JSON.parse(String(init.body))).toEqual({ workflow: 'triage.nika.yaml', inputs });
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBe('triage-42');
    expect(headers.get('Content-Type')).toBe('application/json');

    // The Run owns its lifecycle: one settled frame, named in the lifecycle
    // vocabulary, with the resident's protocol frame untouched on `raw`.
    const observed: string[] = [];
    for await (const event of run.events()) observed.push(`${event.kind} <- ${event.raw.kind}`);
    expect(observed).toEqual(['run.settled <- execution.settled']);
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', outputs: { value: inputs } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('sends an empty map as `"inputs":{}`: a present map is the channel', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ supportedCapabilities: WITH_JOB_INPUTS }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT },
      ]));
    const run = await remote(fetch).run('triage.nika.yaml', { inputs: {}, idempotencyKey: 'k' });
    expect(request(fetch, 1).init.body).toBe('{"workflow":"triage.nika.yaml","inputs":{}}');
    await run.result();
  });

  it('keeps the body of a run without inputs exactly as it was', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT },
      ]));
    const run = await remote(fetch).run('triage.nika.yaml', { idempotencyKey: 'k' });
    expect(request(fetch, 1).init.body).toBe('{"workflow":"triage.nika.yaml"}');
    await run.result();
  });

  it('escapes the workflow name itself as JSON', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ supportedCapabilities: WITH_JOB_INPUTS }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT },
      ]));
    const name = 'équipe/"quoted".nika.yaml';
    const run = await remote(fetch).run(name, { inputs: { a: 1 }, idempotencyKey: 'k' });
    expect(JSON.parse(String(request(fetch, 1).init.body))).toEqual({ workflow: name, inputs: { a: 1 } });
    await run.result();
  });
});

describe('a resident that does not advertise jobInputs is refused before admission', () => {
  it('rejects after /health alone, with the capability and the evidence it read', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    const refused = await failure(remote(fetch).run('triage.nika.yaml', {
      inputs: { ticketId: '42' },
      idempotencyKey: 'triage-42',
    }));
    expect(refused).toBeInstanceOf(NikaCompatibilityError);
    expect(refused).toMatchObject({
      name: 'NikaCompatibilityError',
      capability: 'jobInputs',
      transport: 'http',
    });
    const message = (refused as Error).message;
    expect(message).toContain('jobInputs');
    expect(message).toContain('0.114.0');
    expect(message).toContain('check, executionSnapshot, eventStream, trace, cancel');
    // The old resident would have answered 202 and applied nothing: no POST was made.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(request(fetch, 0).url).toBe('https://nika.example/health');
  });

  it('refuses an empty map on that resident too', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    await expect(remote(fetch).run('triage.nika.yaml', { inputs: {}, idempotencyKey: 'k' }))
      .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'jobInputs' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not read a native capability as the HTTP one', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse({
      supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'inputsLiteral'],
    }));
    await expect(remote(fetch).run('triage.nika.yaml', { inputs: { a: 1 }, idempotencyKey: 'k' }))
      .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'jobInputs' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('an execution snapshot takes no input overlay', () => {
  function transport(fetch: ReturnType<typeof vi.fn>, resolveEngine: () => never): HttpTransport {
    return new HttpTransport({
      url: 'https://nika.example',
      token: TOKEN_A,
      fetch: fetch as typeof globalThis.fetch,
      requestTimeout: 1_000,
      machineBufferBytes: 64 * 1024,
      resolveEngine: resolveEngine as unknown as () => ReturnType<typeof resolveNikaEngine>,
      retryDelay: async () => {},
    });
  }

  it.each([
    ['a relative path', './flow.nika.yaml', { a: 1 }],
    ['an absolute path', '/srv/flow.nika.yaml', { a: 1 }],
    ['an empty map', './flow.nika.yaml', {}],
  ])('refuses inputs for %s before any capture or request', async (_name, workflow, inputs) => {
    const fetch = vi.fn();
    const resolveEngine = vi.fn(() => {
      throw new Error('a refused overlay must not capture a snapshot');
    });
    const refused = await failure(transport(fetch, resolveEngine as never).startRun(workflow, {
      inputs,
      idempotencyKey: 'k',
    }));
    expect(refused).toBeInstanceOf(NikaCompatibilityError);
    expect(refused).toMatchObject({ capability: 'snapshotInputs', transport: 'http' });
    expect((refused as Error).message).toContain('served name');
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveEngine).not.toHaveBeenCalled();
  });
});

describe('a map the SDK cannot send is refused before any request', () => {
  const blob = 'x'.repeat(LITERAL_INPUTS_MAX_BYTES);
  it.each<[string, NikaRunOptions, RegExp]>([
    ['inputs beside vars', { inputs: { a: 1 }, vars: { a: 1 } }, /inputs and the deprecated vars/],
    ['undefined', { inputs: { a: undefined } }, /inputs\.a is undefined/],
    ['a function', { inputs: { a: () => 1 } }, /inputs\.a is a function/],
    ['a symbol', { inputs: { a: Symbol('s') } }, /inputs\.a is a symbol/],
    ['a bigint', { inputs: { a: 1n } }, /inputs\.a is a bigint/],
    ['a non-finite number', { inputs: { a: Number.POSITIVE_INFINITY } }, /non-finite number/],
    ['a class instance', { inputs: { at: new Date(0) } }, /inputs\.at is a Date instance/],
    ['an array hole', { inputs: { list: [1, , 3] } }, /inputs\.list\[1\] is an array hole/],
    ['a map over 1 MiB', { inputs: { blob } }, /exceeds 1048576 bytes/],
  ])('refuses %s', async (_name, options, message) => {
    const fetch = vi.fn();
    const refused = await failure(remote(fetch).run('triage.nika.yaml', {
      ...options,
      idempotencyKey: 'k',
    }));
    expect(refused).toBeInstanceOf(NikaConfigurationError);
    expect((refused as Error).message).toMatch(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a map of exactly 1 MiB: the bound is the map, not the request', async () => {
    const shell = '{"blob":""}'.length;
    const inputs = { blob: 'x'.repeat(LITERAL_INPUTS_MAX_BYTES - shell) };
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ supportedCapabilities: WITH_JOB_INPUTS }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT },
      ]));
    const run = await remote(fetch).run('triage.nika.yaml', { inputs, idempotencyKey: 'k' });
    const body = String(request(fetch, 1).init.body);
    expect(Buffer.byteLength(body))
      .toBe('{"workflow":"triage.nika.yaml","inputs":}'.length + LITERAL_INPUTS_MAX_BYTES);
    await run.result();
  });
});

describe('vars, model and maxCostUsd still have no HTTP envelope', () => {
  it('refuses them ahead of any request, and points vars at inputs', async () => {
    const fetch = vi.fn();
    const nika = remote(fetch);
    for (const options of [{ vars: { x: 1 } }, { model: 'mock/echo' }, { maxCostUsd: 1 }]) {
      await expect(nika.run('triage.nika.yaml', { ...options, idempotencyKey: 'k' }))
        .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'runOptions' });
    }
    // Neither is smuggled in beside a valid map.
    for (const options of [{ model: 'mock/echo' }, { maxCostUsd: 1 }]) {
      await expect(nika.run('triage.nika.yaml', { ...options, inputs: { a: 1 }, idempotencyKey: 'k' }))
        .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'runOptions' });
    }
    const vars = await failure(nika.run('triage.nika.yaml', { vars: { x: 1 }, idempotencyKey: 'k' }));
    expect((vars as Error).message).toContain('inputs');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the resident judges the map: its 422 rejects run() with its code', () => {
  it.each([
    ['an undeclared key', 'unknown_input', 'input key is not declared by this workflow'],
    ['a type mismatch', 'input_type_mismatch', 'input JSON value does not conform to its declared type'],
    ['a missing required input', 'NIKA-1708', 'required workflow inputs have no caller value or declared default'],
    ['an unresolvable declared type', 'invalid_input_type', 'declared input type could not be resolved'],
  ])('%s', async (_name, code, message) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ supportedCapabilities: WITH_JOB_INPUTS }))
      .mockResolvedValueOnce(jsonResponse({ error: { code, message } }, 422));
    const refused = await failure(remote(fetch).run('triage.nika.yaml', {
      inputs: { ticketId: '42', ninja: true },
      idempotencyKey: 'triage-42',
    }));
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({
      name: 'NikaOperationError',
      operation: 'run',
      transport: 'http',
      code,
      machineCode: code,
      status: 422,
    });
    expect((refused as Error).message).toContain(message);
    // No job exists: nothing was observed after the refusal.
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
