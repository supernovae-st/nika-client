import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaProtocolError,
} from '../src/index.js';
import type { NikaEvent } from '../src/index.js';
import { resolveNikaEngine } from '../src/lib/binary/index.js';
import { HttpTransport } from '../src/lib/http-transport.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  collect,
  controlledByteStream,
  healthResponse,
  jsonResponse,
  sseFrame,
  sseResponse,
  sseText,
} from './helpers/http-depth-harness.js';

const RECEIPT = Object.freeze({
  job_id: 'job-1',
  execution_id: 'execution-1',
  trace_id: 'trace-1',
  snapshot_digest: 'a'.repeat(64),
  origin: { kind: 'manual' },
});

function client(
  fetch: typeof globalThis.fetch,
  options: { eventBufferSize?: number; requestTimeout?: number } = {},
): Nika {
  return new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    bin: HTTP_DEPTH_FIXTURE,
    fetch,
    ...options,
  });
}

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
    engine: resolveNikaEngine(HTTP_DEPTH_FIXTURE),
    retryDelay: async () => {},
  });
}

function admissionThen(...responses: Response[]): ReturnType<typeof vi.fn> {
  return vi.fn()
    .mockResolvedValueOnce(healthResponse())
    .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
    .mockImplementation(() => Promise.resolve(responses.shift()));
}

describe('independent event observers', () => {
  it('isolates a slow observer overflow from a fast observer and run settlement', async () => {
    const stream = controlledByteStream();
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(stream.response);
    const nika = client(fetch as typeof globalThis.fetch, { eventBufferSize: 4 });
    const run = await nika.run('flow.nika.yaml');
    const fast = collect(nika.events(run, { bufferSize: 4 }));
    const slow = nika.events(run, { bufferSize: 1 })[Symbol.asyncIterator]();
    for (const event of [
      { sequence: 1, kind: 'execution.queued', status: 'queued' },
      { sequence: 2, kind: 'execution.running', status: 'running' },
      {
        sequence: 3,
        kind: 'execution.completed',
        status: 'succeeded',
        receipt: RECEIPT,
      },
    ] satisfies NikaEvent[]) stream.enqueue(sseFrame(event));
    stream.close();

    await expect(fast).resolves.toHaveLength(3);
    await expect(run.done).resolves.toMatchObject({ id: 'job-1', status: 'succeeded' });
    await expect(collect(slow)).rejects.toMatchObject({
      name: 'NikaEventBufferOverflowError',
      runId: 'job-1',
      limit: 1,
    });
  });

  it('treats subscriber abort as local cleanup without cancelling the run', async () => {
    const stream = controlledByteStream();
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(stream.response);
    const nika = client(fetch as typeof globalThis.fetch, { eventBufferSize: 4 });
    const run = await nika.run('flow.nika.yaml');
    const controller = new AbortController();
    const stopped = collect(nika.events(run, { signal: controller.signal }));
    const durable = collect(nika.events(run));
    controller.abort();
    stream.enqueue(sseFrame({ sequence: 1, kind: 'running', status: 'running' }));
    stream.enqueue(sseFrame({
      sequence: 2,
      kind: 'settled',
      status: 'succeeded',
      receipt: RECEIPT,
    }));
    stream.close();

    await expect(stopped).resolves.toEqual([]);
    await expect(durable).resolves.toHaveLength(2);
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
  });

  it.each([
    [2, undefined, 'global replay capacity'],
    [6, 2, 'smaller observer capacity'],
  ] as const)('refuses late observation after exceeding %s', async (eventBufferSize, bufferSize) => {
    const replay = Array.from({ length: 5 }, (_, index) => ({
      sequence: index + 1,
      kind: index === 4 ? 'settled' : 'running',
      status: index === 4 ? 'succeeded' : 'running',
    } satisfies NikaEvent));
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return healthResponse();
      if (path === '/v1/jobs/durable-job') {
        return jsonResponse({ id: 'durable-job', status: 'running' });
      }
      if (path === '/v1/jobs/durable-job/events') return sseResponse(replay);
      throw new Error(`unexpected ${path}`);
    });
    const nika = client(fetch as typeof globalThis.fetch, { eventBufferSize });
    const run = await nika.attachRun('durable-job');
    await run.done;

    expect(() => nika.events(run, bufferSize === undefined ? {} : { bufferSize }))
      .toThrowError(expect.objectContaining({
      name: 'NikaEventBufferOverflowError',
      runId: 'durable-job',
      limit: 2,
      }));
  });
});

describe('SSE replay, reconnect, and terminal authority', () => {
  it('drops an exact duplicate replay and reconnects from the last accepted sequence', async () => {
    const running = { sequence: 1, kind: 'running', status: 'running' } as const;
    const fetch = admissionThen(
      sseText(sseFrame(running)),
      jsonResponse({ id: 'job-1', status: 'running' }),
      sseText(sseFrame(running) + sseFrame({
        sequence: 2,
        kind: 'settled',
        status: 'succeeded',
        receipt: RECEIPT,
      })),
    );
    const source = await transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).resolves.toHaveLength(2);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
    const headers = new Headers(fetch.mock.calls[4]?.[1]?.headers);
    expect(headers.get('Last-Event-ID')).toBe('1');
  });

  it.each([
    [
      'different duplicate',
      sseFrame({ sequence: 1, kind: 'running', status: 'running' })
        + sseFrame({ sequence: 1, kind: 'changed', status: 'running' }),
      /replayed with different data/,
    ],
    [
      'sequence gap',
      sseFrame({ sequence: 2, kind: 'running', status: 'running' }),
      /SSE gap/,
    ],
  ])('rejects a %s without reconnecting', async (_name, body, message) => {
    const fetch = admissionThen(sseText(body as string));
    const source = await transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).rejects.toThrow(message as RegExp);
    await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops at the first terminal frame even if trailing bytes are corrupt', async () => {
    const terminal = {
      sequence: 1,
      kind: 'settled',
      status: 'succeeded',
      receipt: RECEIPT,
    } as const;
    const fetch = admissionThen(sseText(
      sseFrame(terminal) + 'id: 2\ndata: not-json\n\n',
    ));
    const source = await transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).resolves.toEqual([terminal]);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('settles from durable interrupted state after a server process reset', async () => {
    const fetch = admissionThen(
      sseText(sseFrame({ sequence: 1, kind: 'running', status: 'running' }), true),
      jsonResponse({
        id: 'job-1',
        status: 'interrupted',
        execution_id: 'execution-1',
        trace_id: 'trace-1',
        receipt: RECEIPT,
      }),
    );
    const source = await transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).resolves.toEqual([
      { sequence: 1, kind: 'running', status: 'running' },
    ]);
    await expect(source.done).resolves.toMatchObject({
      id: 'job-1',
      status: 'interrupted',
      execution_id: 'execution-1',
      trace_id: 'trace-1',
      receipt: RECEIPT,
    });
  });

  it('bounds durable JSON inspected during reconnect', async () => {
    const fetch = admissionThen(
      sseText(''),
      jsonResponse({ id: 'job-1', status: 'running', padding: 'x'.repeat(4_096) }),
    );
    const source = await transport(fetch as typeof globalThis.fetch, {
      machineBufferBytes: 1_024,
    }).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects an oversized SSE frame without retrying it as a reset', async () => {
    const fetch = admissionThen(sseText(
      `id: 1\ndata: ${'x'.repeat(2_048)}\n\n`,
    ));
    const source = await transport(fetch as typeof globalThis.fetch, {
      machineBufferBytes: 1_024,
    }).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('cancellation and terminal identity', () => {
  it('settles a terminal 200 admission immediately while replaying persisted SSE', async () => {
    const terminal = {
      sequence: 1,
      kind: 'settled',
      status: 'succeeded',
      receipt: RECEIPT,
      outputs: { replayed: true },
    } as const;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return healthResponse();
      if (path === '/v1/jobs') {
        return jsonResponse({
          id: 'job-1',
          status: 'succeeded',
          execution_id: 'execution-1',
          trace_id: 'trace-1',
          outputs: { replayed: true },
          receipt: RECEIPT,
        });
      }
      if (path === '/v1/jobs/job-1/events') return sseResponse([terminal]);
      throw new Error(`unexpected ${path}`);
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml', { idempotencyKey: 'same-request' });

    await expect(run.done).resolves.toMatchObject({
      id: 'job-1',
      status: 'succeeded',
      outputs: { replayed: true },
      receipt: RECEIPT,
    });
    await expect(collect(nika.events(run))).resolves.toEqual([terminal]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['succeeded', false, 'already_settled'],
    ['cancelled', true, 'cancelled'],
  ] as const)(
    'reconciles cancellation when the server terminal winner is %s',
    async (status, accepted, cancelStatus) => {
      const stream = controlledByteStream();
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/health') return healthResponse();
        if (path === '/v1/jobs') {
          return jsonResponse({ id: 'job-1', status: 'queued' }, 202);
        }
        if (path === '/v1/jobs/job-1/events') return stream.response;
        if (path === '/v1/jobs/job-1/cancel') {
          return jsonResponse({
            id: 'job-1',
            status,
            execution_id: 'execution-1',
            trace_id: 'trace-1',
            receipt: RECEIPT,
          });
        }
        throw new Error(`unexpected ${path}`);
      });
      const nika = client(fetch as typeof globalThis.fetch);
      const run = await nika.run('flow.nika.yaml');
      await expect(nika.cancel(run)).resolves.toEqual({
        runId: 'job-1',
        accepted,
        status: cancelStatus,
        transport: 'http',
      });
      await expect(run.done).resolves.toMatchObject({
        id: 'job-1',
        status,
        receipt: RECEIPT,
      });
    },
  );

  it('settles run.done when cancellation wins even if the SSE body stays open', async () => {
    const stream = controlledByteStream();
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return healthResponse();
      if (path === '/v1/jobs') {
        return jsonResponse({ id: 'job-1', status: 'queued' }, 202);
      }
      if (path === '/v1/jobs/job-1/events') return stream.response;
      if (path === '/v1/jobs/job-1/cancel') {
        return jsonResponse({
          id: 'job-1',
          status: 'cancelled',
          execution_id: 'execution-1',
          trace_id: 'trace-1',
          receipt: RECEIPT,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');

    await nika.cancel(run);
    await expect(Promise.race([
      run.done,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])).resolves.toMatchObject({ id: 'job-1', status: 'cancelled' });
  });

  it('rejects a terminal SSE receipt bound to another run', async () => {
    const fetch = admissionThen(sseResponse([{
      sequence: 1,
      kind: 'settled',
      status: 'succeeded',
      receipt: { ...RECEIPT, job_id: 'job-other' },
    }]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects an incomplete terminal SSE receipt', async () => {
    const fetch = admissionThen(sseResponse([{
      sequence: 1,
      kind: 'settled',
      status: 'succeeded',
      receipt: { job_id: 'job-1' },
    }]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects non-canonical schedule provenance in a terminal receipt', async () => {
    const fetch = admissionThen(sseResponse([{
      sequence: 1,
      kind: 'settled',
      status: 'succeeded',
      receipt: {
        ...RECEIPT,
        origin: {
          kind: 'schedule',
          schedule_origin: 'api',
          schedule_id: 'daily',
          schedule_revision: 'x',
          slot_id: 'x',
          decision: 'scheduled',
          scheduled_for: 'x',
          fired_at: 'x',
          arm_generation: 'x',
        },
      },
    }]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('binds a terminal SSE receipt to identities retained from attach', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-1',
        status: 'running',
        execution_id: 'execution-1',
        trace_id: 'trace-1',
      }))
      .mockResolvedValueOnce(sseResponse([{
        sequence: 1,
        kind: 'settled',
        status: 'succeeded',
        receipt: {
          ...RECEIPT,
          execution_id: 'execution-other',
          trace_id: 'trace-other',
        },
      }]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.attachRun('job-1');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects durable identity replacement after attach', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-1',
        status: 'running',
        execution_id: 'execution-1',
        trace_id: 'trace-1',
      }))
      .mockResolvedValueOnce(sseText(''))
      .mockResolvedValueOnce(jsonResponse({
        id: 'job-1',
        status: 'succeeded',
        execution_id: 'execution-2',
        trace_id: 'trace-2',
        receipt: {
          ...RECEIPT,
          execution_id: 'execution-2',
          trace_id: 'trace-2',
        },
      }));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.attachRun('job-1');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('binds a new run receipt to the exact locally captured snapshot', async () => {
    const fetch = admissionThen(sseResponse([{
      sequence: 1,
      kind: 'settled',
      status: 'succeeded',
      receipt: { ...RECEIPT, snapshot_digest: 'b'.repeat(64) },
    }]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it.each([
    ['missing kind', { sequence: 1, status: 'running' }],
    ['missing status', { sequence: 1, kind: 'running' }],
    ['non-object outputs', {
      sequence: 1, kind: 'settled', status: 'succeeded', outputs: 'private',
    }],
    ['non-object receipt', {
      sequence: 1, kind: 'settled', status: 'succeeded', receipt: 'private',
    }],
  ])('rejects %s in the closed SSE projection', async (_name, event) => {
    const fetch = admissionThen(sseResponse([event]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects terminal SSE fields outside the public redacted projection', async () => {
    const fetch = admissionThen(sseResponse([{
      sequence: 1,
      kind: 'settled',
      status: 'failed',
      code: 'NIKA-TEST-PRIVATE',
      message: 'redacted summary',
      path: '/Users/private/workflow.nika.yaml',
      token: 'CANARY_SECRET',
    }]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('rejects a durable receipt whose identities disagree with its job', async () => {
    const fetch = admissionThen(
      sseText(''),
      jsonResponse({
        id: 'job-1',
        status: 'succeeded',
        execution_id: 'execution-1',
        trace_id: 'trace-1',
        receipt: { ...RECEIPT, trace_id: 'trace-other' },
      }),
    );
    const source = await transport(fetch as typeof globalThis.fetch).startRun('flow.nika.yaml', {});
    await expect(collect(source.events)).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('preserves matching receipt, output, and run identity without synthesizing fields', async () => {
    const terminal = {
      sequence: 1,
      kind: 'execution.completed',
      status: 'succeeded',
      outputs: { answer: 42 },
      receipt: RECEIPT,
    } as const;
    const fetch = admissionThen(sseResponse([terminal]));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    const result = await run.done;
    expect(result).toEqual({
      id: 'job-1',
      status: 'succeeded',
      transport: 'http',
      outputs: { answer: 42 },
      receipt: RECEIPT,
    });
    expect(result.receipt?.job_id).toBe(run.id);
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(result).not.toHaveProperty('workflow');
    expect(result).not.toHaveProperty('path');
  });
});
