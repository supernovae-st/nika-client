import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaConfigurationError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import { resolveNikaEngine } from '../src/lib/binary/index.js';
import { HttpTransport } from '../src/lib/http-transport.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  TOKEN_B,
  delayedJsonResponse,
  healthResponse,
  jsonResponse,
  makeSnapshotFixture,
  scheduleStatus,
  sseResponse,
} from './helpers/http-depth-harness.js';

function transport(
  fetch: typeof globalThis.fetch,
  options: { requestTimeout?: number; machineBufferBytes?: number } = {},
): HttpTransport {
  return new HttpTransport({
    url: 'https://nika.example',
    token: TOKEN_A,
    fetch,
    requestTimeout: options.requestTimeout ?? 1_000,
    machineBufferBytes: options.machineBufferBytes ?? 64 * 1024,
    resolveEngine: () => resolveNikaEngine(HTTP_DEPTH_FIXTURE),
    retryDelay: async () => {},
  });
}

function client(fetch: typeof globalThis.fetch, token = TOKEN_A, bin = HTTP_DEPTH_FIXTURE): Nika {
  return new Nika({
    url: 'https://nika.example',
    token,
    bin,
    fetch,
  });
}

describe('HTTP configuration and bearer boundaries', () => {
  it('refuses bearer material that nika serve cannot authorize', () => {
    for (const token of [
      'a'.repeat(31),
      'a'.repeat(513),
      `${'a'.repeat(32)} `,
      ` ${'a'.repeat(32)}`,
      `${'a'.repeat(16)}\t${'a'.repeat(16)}`,
      `${'a'.repeat(16)}\n${'a'.repeat(16)}`,
    ]) {
      expect(() => new Nika({
        url: 'https://nika.example',
        token,
        bin: HTTP_DEPTH_FIXTURE,
      }), JSON.stringify(token)).toThrow(NikaConfigurationError);
    }
  });

  it.each([
    'https://user@nika.example',
    'https://user:password@nika.example',
    'https://nika.example?token=secret',
    'https://nika.example/#secret',
  ])('refuses credential, query, and fragment ambiguity in %s', (url) => {
    expect(() => new Nika({ url, token: TOKEN_A, bin: HTTP_DEPTH_FIXTURE }))
      .toThrow(NikaConfigurationError);
  });

  it('keeps token rotation instance-scoped and never authenticates health', async () => {
    let activeToken = TOKEN_A;
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const authorization = new Headers(init?.headers).get('Authorization');
      seen.push({ path, authorization });
      if (path === '/health') return healthResponse();
      if (authorization !== `Bearer ${activeToken}`) {
        return jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401);
      }
      return jsonResponse({
        verdict: 'unavailable',
        reason: 'trace_journal_unavailable',
        trace_id: 'trace-1',
      });
    });

    const oldClient = client(fetch as typeof globalThis.fetch, TOKEN_A);
    await expect(oldClient.traceVerify({ job_id: 'job-1', trace_id: 'trace-1' }))
      .resolves.toMatchObject({ verified: false });
    activeToken = TOKEN_B;
    await expect(oldClient.traceVerify({ job_id: 'job-1', trace_id: 'trace-1' }))
      .rejects.toMatchObject({
        name: 'NikaOperationError',
        transport: 'http',
        operation: 'traceVerify',
        code: 'unauthorized',
        status: 401,
      });
    const rotatedClient = client(fetch as typeof globalThis.fetch, TOKEN_B);
    await expect(rotatedClient.traceVerify({ job_id: 'job-1', trace_id: 'trace-1' }))
      .resolves.toMatchObject({ trace_id: 'trace-1' });

    expect(seen.filter(({ path }) => path === '/health'))
      .toEqual([
        { path: '/health', authorization: null },
        { path: '/health', authorization: null },
      ]);
  });
});

describe('HTTP response framing, status, and deadlines', () => {
  it('aborts a request that never produces response headers', async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('deadline', 'AbortError'));
        }, { once: true });
      },
    ));
    await expect(transport(fetch as typeof globalThis.fetch, {
      requestTimeout: 5,
    }).startRun('flow.nika.yaml', {})).rejects.toMatchObject({
      name: 'NikaTransportError',
      transport: 'http',
      message: expect.stringMatching(/timed out/),
    });
  });

  it('requires JSON content-type on job admission', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-1', status: 'queued' }), {
        status: 202,
        headers: { 'Content-Type': 'text/plain' },
      }));
    await expect(transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {}))
      .rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('refuses a successful but non-contract admission status', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 201));
    await expect(transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {}))
      .rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('bounds JSON response bodies before parsing them', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-1',
        status: 'queued',
        padding: 'x'.repeat(4_096),
      }, 202));
    await expect(transport(fetch as typeof globalThis.fetch, {
      machineBufferBytes: 1_024,
    }).startRun('flow.nika.yaml', {})).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('keeps the request deadline active while the admission body is read', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockImplementationOnce(() => Promise.resolve(
        delayedJsonResponse({ id: 'job-1', status: 'queued' }, 40),
      ));
    await expect(transport(fetch as typeof globalThis.fetch, {
      requestTimeout: 5,
    }).startRun('flow.nika.yaml', {})).rejects.toMatchObject({
      name: 'NikaTransportError',
      transport: 'http',
    });
  });

  it('honors a check AbortSignal after response headers but before its body', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return healthResponse();
      setTimeout(() => controller.abort(new Error('caller stopped check')), 5);
      return delayedJsonResponse({
        status: 'accepted',
        snapshot_digest: 'fixture-digest',
        root: 'fixture.nika.yaml',
        units: 1,
      }, 40);
    });
    await expect(transport(fetch as typeof globalThis.fetch).check(
      'flow.nika.yaml',
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(NikaTransportError);
  });

  it('keeps non-2xx admission failures typed and redacted', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 'idempotency_conflict',
          message: `reflected ${TOKEN_A}`,
        },
      }, 409));
    let failure: unknown;
    try {
      await transport(fetch as typeof globalThis.fetch).startRun(
        'flow.nika.yaml',
        { idempotencyKey: 'same-key' },
      );
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(NikaOperationError);
    expect(failure).toMatchObject({
      name: 'NikaOperationError',
      transport: 'http',
      operation: 'run',
      code: 'idempotency_conflict',
      status: 409,
    });
    expect(String(failure)).toContain('HTTP 409 for /v1/jobs: idempotency_conflict');
    expect(String(failure)).toContain('[REDACTED]');
    expect(String(failure)).not.toContain(TOKEN_A);
  });

  it('keeps an untyped non-2xx body redacted', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(new Response(`reflected ${TOKEN_A}`, { status: 502 }));
    let failure: unknown;
    try {
      await transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {});
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(NikaTransportError);
    expect(failure).not.toBeInstanceOf(NikaOperationError);
    expect(String(failure)).toContain('HTTP 502 for /v1/jobs: [REDACTED]');
    expect(String(failure)).not.toContain(TOKEN_A);
  });
});

describe('cross-client concurrency contracts', () => {
  it('replays identical two-client admissions and refuses a conflicting binding', async () => {
    const fixtureA = makeSnapshotFixture('a');
    const fixtureB = makeSnapshotFixture('b');
    const admissions = new Map<string, { body: string; id: string; digest: string }>();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return healthResponse();
      if (url.pathname === '/v1/jobs') {
        const key = new Headers(init?.headers).get('Idempotency-Key') ?? '';
        const body = String(init?.body);
        const digest = String((JSON.parse(body) as { digest?: unknown }).digest);
        const existing = admissions.get(key);
        if (existing && existing.body !== body) {
          return jsonResponse({
            error: {
              code: 'idempotency_conflict',
              message: 'idempotency key is already bound to another request',
            },
          }, 409);
        }
        const admission = existing ?? { body, id: 'job-shared', digest };
        admissions.set(key, admission);
        return jsonResponse(
          { id: admission.id, status: 'queued' },
          existing ? 200 : 202,
        );
      }
      if (url.pathname === '/v1/jobs/job-shared/events') {
        const admission = admissions.get('shared-key')!;
        return sseResponse([{
          sequence: 1,
          kind: 'execution.completed',
          status: 'succeeded',
          receipt: {
            job_id: admission.id,
            execution_id: 'execution-shared',
            trace_id: 'trace-shared',
            snapshot_digest: admission.digest,
          },
        }]);
      }
      throw new Error(`unexpected ${url.pathname}`);
    });

    try {
      const firstClient = client(fetch as typeof globalThis.fetch, TOKEN_A, fixtureA.bin);
      const replayClient = client(fetch as typeof globalThis.fetch, TOKEN_A, fixtureA.bin);
      const conflictClient = client(fetch as typeof globalThis.fetch, TOKEN_A, fixtureB.bin);
      const first = await firstClient.run('flow.nika.yaml', { idempotencyKey: 'shared-key' });
      const replay = await replayClient.run('flow.nika.yaml', { idempotencyKey: 'shared-key' });
      expect(first.id).toBe(replay.id);
      await expect(Promise.all([first.done, replay.done])).resolves.toEqual([
        expect.objectContaining({ id: 'job-shared', status: 'succeeded' }),
        expect.objectContaining({ id: 'job-shared', status: 'succeeded' }),
      ]);
      await expect(conflictClient.run('flow.nika.yaml', {
        idempotencyKey: 'shared-key',
      })).rejects.toMatchObject({
        name: 'NikaOperationError',
        transport: 'http',
        operation: 'run',
        code: 'idempotency_conflict',
        status: 409,
      });
      expect(admissions).toHaveLength(1);
    } finally {
      fixtureA.cleanup();
      fixtureB.cleanup();
    }
  });

  it('allows exactly one stale schedule revision writer', async () => {
    const oldRevision = `sha256:${'a'.repeat(64)}`;
    const newRevision = `sha256:${'b'.repeat(64)}`;
    let writes = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') {
        return healthResponse({
          supportedCapabilities: [
            'check',
            'executionSnapshot',
            'eventStream',
            'trace',
            'cancel',
            'schedule',
          ],
        });
      }
      writes += 1;
      if (writes === 1) {
        return jsonResponse({
          applied: true,
          changed: true,
          status: scheduleStatus(newRevision),
        });
      }
      return jsonResponse({
        error: {
          code: 'schedule_precondition_failed',
          message: 'stale revision',
          currentRevision: newRevision,
        },
      }, 412);
    });
    const options = {
      id: 'daily',
      when: { kind: 'cadence' as const, expression: 'daily at 09:00 Europe/Paris' },
      maxCostUsd: 0.25,
      missed: 'catch-up-once' as const,
      revision: oldRevision,
    };
    const results = await Promise.allSettled([
      client(fetch as typeof globalThis.fetch).schedule('flow.nika.yaml', options),
      client(fetch as typeof globalThis.fetch).schedule('flow.nika.yaml', options),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(NikaOperationError);
    expect(rejected.reason).toMatchObject({
      code: 'schedule_conflict',
      currentRevision: newRevision,
      status: 412,
      transport: 'http',
    });
  });
});
