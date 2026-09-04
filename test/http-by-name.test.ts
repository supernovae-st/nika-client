import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaEngineUnavailable,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import type { NikaEvent } from '../src/index.js';
import { resolveNikaEngine } from '../src/lib/binary/index.js';
import { HttpTransport } from '../src/lib/http-transport.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  collect,
  healthResponse,
  jsonResponse,
  sseResponse,
} from './helpers/http-depth-harness.js';

// The digest is the resident's own: nothing was captured locally to bind it to.
const RECEIPT = Object.freeze({
  job_id: 'job-1',
  execution_id: 'execution-1',
  trace_id: 'trace-1',
  snapshot_digest: 'f'.repeat(64),
  origin: { kind: 'manual' },
});

const SETTLEMENT = Object.freeze({
  cause: 'normal',
  elapsed_ms: 12,
  tasks: { total: 2, ok: 2, failed: 0, recovered: 0, skipped: 0, cancelled: 0, never_started: 0 },
  spend: { priced_calls: 0, unpriced_calls: 0, qualifier: 'unmetered' },
});

const ACK = Object.freeze({
  status: 'accepted',
  snapshot_digest: 'f'.repeat(64),
  root: 'daily.nika.yaml',
  units: 3,
});

const NOT_FOUND = Object.freeze({
  code: 'not_found',
  message: 'no workflow by that name under the served registry, '
    + 'GET /v1/workflows lists the names this resident admits',
});

/** A client built from `url` and `token` alone: no `bin`, so no local engine is reachable. */
function remote(fetch: ReturnType<typeof vi.fn>): Nika {
  return new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    fetch: fetch as typeof globalThis.fetch,
  });
}

function transport(
  fetch: ReturnType<typeof vi.fn>,
  resolveEngine: () => ReturnType<typeof resolveNikaEngine>,
): HttpTransport {
  return new HttpTransport({
    url: 'https://nika.example',
    token: TOKEN_A,
    fetch: fetch as typeof globalThis.fetch,
    requestTimeout: 1_000,
    machineBufferBytes: 64 * 1024,
    resolveEngine,
    retryDelay: async () => {},
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

describe('run by served name (ADR-131)', () => {
  it('posts {"workflow"} to /v1/jobs and settles from the stream without a local engine', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        {
          sequence: 2,
          kind: 'execution.completed',
          status: 'succeeded',
          outputs: { answer: 42 },
          receipt: RECEIPT,
        },
      ]));
    const nika = remote(fetch);
    const run = await nika.run('daily.nika.yaml', { idempotencyKey: 'daily-2026-09-04' });
    expect(run.id).toBe('job-1');

    const { url, init } = request(fetch, 1);
    expect(url).toBe('https://nika.example/v1/jobs');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"workflow":"daily.nika.yaml"}');
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBe('daily-2026-09-04');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN_A}`);

    await expect(collect(nika.events(run))).resolves.toHaveLength(2);
    await expect(run.done).resolves.toEqual({
      id: 'job-1',
      status: 'succeeded',
      transport: 'http',
      execution_id: 'execution-1',
      trace_id: 'trace-1',
      outputs: { answer: 42 },
      receipt: RECEIPT,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.some(([called]) => String(called).includes('/v1/workflows'))).toBe(false);
  });

  it('generates one idempotency key when the caller omits it', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT },
      ]));
    const run = await remote(fetch).run('daily.nika.yaml');
    const key = new Headers(request(fetch, 1).init.headers).get('Idempotency-Key');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('carries the settlement the resident nests on the terminal frame', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([{
        sequence: 1,
        kind: 'execution.settled',
        status: 'succeeded',
        receipt: RECEIPT,
        settlement: SETTLEMENT,
      }]));
    const run = await remote(fetch).run('daily.nika.yaml');
    const result = await run.done;
    expect(result.status).toBe('succeeded');
    expect(result.settlement).toEqual(SETTLEMENT);
  });

  it('refuses a settlement that is not an object', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([{
        sequence: 1,
        kind: 'execution.settled',
        status: 'succeeded',
        receipt: RECEIPT,
        settlement: 'private',
      } as unknown as NikaEvent]));
    const run = await remote(fetch).run('daily.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('accepts an idempotent replay (200) as the run for that job', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 200))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT },
      ]));
    const run = await remote(fetch).run('daily.nika.yaml', { idempotencyKey: 'same-key' });
    expect(run.id).toBe('job-1');
    await expect(run.done).resolves.toMatchObject({ id: 'job-1', status: 'succeeded' });
  });

  it('rejects an unknown name with the typed not_found refusal', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ error: NOT_FOUND }, 404));
    const refused = await failure(remote(fetch).run('missing.nika.yaml'));
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({
      operation: 'run',
      transport: 'http',
      code: 'not_found',
      machineCode: 'not_found',
      status: 404,
    });
    expect(String(refused)).toContain('GET /v1/workflows');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the run option gap and the idempotency key rule ahead of any request', async () => {
    const fetch = vi.fn();
    const nika = remote(fetch);
    for (const options of [{ vars: { x: 1 } }, { model: 'mock/echo' }, { maxCostUsd: 1 }]) {
      await expect(nika.run('daily.nika.yaml', options))
        .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'runOptions' });
    }
    await expect(nika.run('daily.nika.yaml', { idempotencyKey: '' }))
      .rejects.toBeInstanceOf(NikaTransportError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('check by served name (ADR-131)', () => {
  it('returns the resident acknowledgement with clean: true and nothing invented', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(ACK));
    const report = await remote(fetch).check('daily.nika.yaml');
    expect(report).toEqual({ clean: true, ...ACK });
    expect(report).not.toHaveProperty('report_version');
    expect(report).not.toHaveProperty('findings');
    expect(report).not.toHaveProperty('exitCode');
    const { url, init } = request(fetch, 1);
    expect(url).toBe('https://nika.example/v1/check');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"workflow":"daily.nika.yaml"}');
    expect(new Headers(init.headers).has('Idempotency-Key')).toBe(false);
  });

  it.each([
    ['a 422 with a message', 422, { code: 'malformed_snapshot', message: 'x' }],
    ['a 422 with a stamped code alone', 422, { code: 'NIKA-AUTH-006' }],
    ['a 404 for a name the registry does not list', 404, NOT_FOUND],
  ])('returns %s as a red result', async (_name, status, error) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ error }, status));
    await expect(remote(fetch).check('daily.nika.yaml'))
      .resolves.toEqual({ clean: false, error });
  });

  it('still throws when the refusal judges the request, not the workflow', async () => {
    const unauthorized = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'unauthorized', message: 'authentication required' } },
        401,
      ));
    await expect(remote(unauthorized).check('daily.nika.yaml')).rejects.toMatchObject({
      name: 'NikaOperationError',
      operation: 'check',
      code: 'unauthorized',
      machineCode: 'unauthorized',
      status: 401,
    });
    const untyped = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(new Response(`reflected ${TOKEN_A}`, { status: 503 }));
    const failed = await failure(remote(untyped).check('daily.nika.yaml'));
    expect(failed).toBeInstanceOf(NikaTransportError);
    expect(String(failed)).toContain('[REDACTED]');
    expect(String(failed)).not.toContain(TOKEN_A);
  });

  it.each([
    ['an unknown field', { ...ACK, path: '/private/daily.nika.yaml' }],
    ['a status other than accepted', { ...ACK, status: 'rejected' }],
    ['a digest that is not canonical', { ...ACK, snapshot_digest: 'short' }],
    ['a unit count below one', { ...ACK, units: 0 }],
    ['an empty root', { ...ACK, root: '' }],
  ])('refuses an acknowledgement with %s', async (_name, body) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(body));
    await expect(remote(fetch).check('daily.nika.yaml'))
      .rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('keeps the check option gap ahead of any request', async () => {
    const fetch = vi.fn();
    await expect(remote(fetch).check('daily.nika.yaml', { model: 'mock/echo' }))
      .rejects.toMatchObject({ capability: 'checkOptions', transport: 'http' });
    await expect(remote(fetch).check('daily.nika.yaml', { nativeStrict: true }))
      .rejects.toMatchObject({ capability: 'checkOptions', transport: 'http' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the local capture path is unchanged', () => {
  it('captures a local path through the local engine and posts the snapshot bytes', async () => {
    const resolveEngine = vi.fn(() => resolveNikaEngine(HTTP_DEPTH_FIXTURE));
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([{
        sequence: 1,
        kind: 'execution.settled',
        status: 'succeeded',
        receipt: { ...RECEIPT, snapshot_digest: 'a'.repeat(64) },
      }]));
    const source = await transport(fetch, resolveEngine).startRun('./flow.nika.yaml', {});
    expect(resolveEngine).toHaveBeenCalledTimes(1);
    const body = String(request(fetch, 1).init.body);
    expect(JSON.parse(body)).toMatchObject({ format_version: 1, digest: 'a'.repeat(64) });
    expect(body).not.toContain('"workflow"');
    // A transport run is observed by iterating its events; the facade does this eagerly.
    await expect(collect(source.events)).resolves.toHaveLength(1);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
  });

  it.each([
    ['a relative path', './flow.nika.yaml'],
    ['a parent path', '../flow.nika.yaml'],
    ['an absolute path', '/srv/flow.nika.yaml'],
    ['a backslash path', 'dir\\flow.nika.yaml'],
    ['a name without the extension', 'flow.yaml'],
  ])('routes %s to the local engine, never to the by-name door', async (_name, workflow) => {
    const fetch = vi.fn();
    const unavailable = () => {
      throw new NikaEngineUnavailable('darwin', 'arm64', '@supernovae-st/nika-darwin-arm64');
    };
    await expect(transport(fetch, unavailable).startRun(workflow, {}))
      .rejects.toBeInstanceOf(NikaEngineUnavailable);
    await expect(transport(fetch, unavailable).check(workflow, {}))
      .rejects.toBeInstanceOf(NikaEngineUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['flow.nika.yaml'], ['nested/daily.nika.yaml']])(
    'submits %s by name without resolving an engine',
    async (workflow) => {
      const resolveEngine = vi.fn(() => {
        throw new Error('the local engine must not be touched on the by-name path');
      });
      const fetch = vi.fn()
        .mockResolvedValueOnce(healthResponse())
        .mockResolvedValueOnce(jsonResponse({ ...ACK, root: workflow }));
      await expect(transport(fetch, resolveEngine).check(workflow, {}))
        .resolves.toMatchObject({ clean: true, root: workflow });
      expect(resolveEngine).not.toHaveBeenCalled();
    },
  );
});
