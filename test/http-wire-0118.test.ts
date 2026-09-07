import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import type { NikaEvent, NikaSettlement } from '../src/index.js';
import { eventError, eventSettlement } from '../src/lib/machine.js';
import { readSettlement } from '../src/lib/settlement.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  collect,
  controlledByteStream,
  healthResponse,
  jsonResponse,
  sseFrame,
  sseResponse,
} from './helpers/http-depth-harness.js';

// Every frame and durable record below is the shape a 0.118.7 `nika serve
// --bind` answered when measured (identities shortened): the settlement is
// nested whole on the terminal frame and on the durable job, a failed one
// names its task, cancel answers 202 with the running job and the stream
// later carries the interrupted terminal once the grace expired.

const RECEIPT = Object.freeze({
  job_id: 'job-1',
  execution_id: 'exe-1',
  trace_id: 'trace-1',
  snapshot_digest: 'a'.repeat(64),
  origin: { kind: 'manual' },
});

const SETTLED: NikaSettlement = {
  cause: 'normal',
  elapsed_ms: 0,
  spend: { priced_calls: 0, qualifier: 'unpriced', unpriced_calls: 1 },
  status: 'succeeded',
  tasks: { cancelled: 0, failed: 0, never_started: 0, ok: 1, recovered: 0, skipped: 0, total: 1 },
};

const FAILED: NikaSettlement = {
  cause: 'task_failed',
  elapsed_ms: 0,
  error: {
    code: 'NIKA-BUILTIN-ASSERT-001',
    message: 'tool `nika:assert` reported an error: NIKA-BUILTIN-ASSERT-001 · deliberate',
    task: 'boom',
  },
  spend: { priced_calls: 0, qualifier: 'unmetered', unpriced_calls: 0 },
  status: 'failed',
  tasks: { cancelled: 0, failed: 1, never_started: 0, ok: 0, recovered: 0, skipped: 0, total: 1 },
};

const STARTED: NikaEvent = { sequence: 1, kind: 'execution.started', status: 'running' };

const SETTLED_FRAME: NikaEvent = {
  sequence: 2,
  kind: 'execution.settled',
  status: 'succeeded',
  outputs: { greeting: 'mock(echo) · hello' },
  receipt: RECEIPT,
  settlement: SETTLED,
};

const FAILED_FRAME: NikaEvent = {
  sequence: 2,
  kind: 'execution.settled',
  status: 'failed',
  code: 'NIKA-BUILTIN-ASSERT-001',
  message: 'task `boom`: tool `nika:assert` reported an error: NIKA-BUILTIN-ASSERT-001 · deliberate',
  outputs: { boom: null },
  receipt: RECEIPT,
  settlement: FAILED,
};

const INTERRUPTED_FRAME: NikaEvent = {
  sequence: 2,
  kind: 'execution.interrupted',
  status: 'interrupted',
  receipt: RECEIPT,
};

function client(fetch: typeof globalThis.fetch): Nika {
  return new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    bin: HTTP_DEPTH_FIXTURE,
    fetch,
  });
}

/** A resident that admits job-1 as queued and answers the other routes from the table. */
function resident(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/health') return healthResponse();
    if (path === '/v1/jobs') return jsonResponse({ id: 'job-1', status: 'queued' }, 202);
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    return route(init);
  });
}

describe('the settlement the resident nests on the wire (engine 0.118)', () => {
  it('rides execution.settled into run.done, frame kept whole', async () => {
    const fetch = resident({
      '/v1/jobs/job-1/events': () => sseResponse([STARTED, SETTLED_FRAME]),
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');

    await expect(collect(nika.events(run))).resolves.toEqual([STARTED, SETTLED_FRAME]);
    const result = await run.done;
    expect(result).toMatchObject({
      id: 'job-1',
      status: 'succeeded',
      transport: 'http',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
      outputs: { greeting: 'mock(echo) · hello' },
      receipt: RECEIPT,
      settlement: SETTLED,
    });
    expect(result.error).toBeUndefined();
  });

  it('names a failed run from the settlement, task included', async () => {
    const fetch = resident({
      '/v1/jobs/job-1/events': () => sseResponse([STARTED, FAILED_FRAME]),
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');

    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      outputs: { boom: null },
      error: FAILED.error,
      settlement: FAILED,
    });
  });

  it('reads the settlement from the durable job when no frame carried it', async () => {
    const durable = {
      id: 'job-1',
      status: 'failed',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
      error: { code: 'NIKA-BUILTIN-ASSERT-001', message: 'task `boom`: tool `nika:assert` reported an error' },
      outputs: { boom: null },
      receipt: RECEIPT,
      settlement: FAILED,
    };
    const fetch = resident({
      '/v1/jobs/job-1': () => jsonResponse(durable),
      '/v1/jobs/job-1/events': () => sseResponse([STARTED, FAILED_FRAME]),
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.attachRun('job-1');

    // The terminal durable read settles before any frame; the settlement's
    // error names the task the job's own error does not.
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
      error: FAILED.error,
      settlement: FAILED,
    });
  });

  it('keeps an additive settlement field and refuses a malformed known fact', async () => {
    const additive = resident({
      '/v1/jobs/job-1/events': () => sseResponse([
        STARTED,
        { ...SETTLED_FRAME, settlement: { ...SETTLED, novel: { future: true } } },
      ]),
    });
    const kept = await client(additive as typeof globalThis.fetch).run('flow.nika.yaml');
    await expect(kept.done).resolves.toMatchObject({
      settlement: { ...SETTLED, novel: { future: true } },
    });

    const malformed = resident({
      '/v1/jobs/job-1/events': () => sseResponse([
        STARTED,
        { ...SETTLED_FRAME, settlement: { ...SETTLED, elapsed_ms: 'soon' } },
      ]),
    });
    const refused = await client(malformed as typeof globalThis.fetch).run('flow.nika.yaml');
    await expect(refused.done).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(refused.done).rejects.toThrow(/settlement was malformed: elapsed_ms/);

    const contradicting = resident({
      '/v1/jobs/job-1': () => jsonResponse({
        id: 'job-1',
        status: 'succeeded',
        settlement: { ...SETTLED, status: 'failed' },
      }),
    });
    await expect(client(contradicting as typeof globalThis.fetch).attachRun('job-1'))
      .rejects.toThrow(/status failed contradicts the record's succeeded/);
  });

  it('still refuses a durable job carrying a field outside the projection', async () => {
    // The canary for the durable allow-list: a path or a token the resident
    // never projects must keep dying here, as it does on the SSE frame.
    for (const stray of [{ path: '/srv/jobs/job-1' }, { token: 'x'.repeat(32) }]) {
      const fetch = resident({
        '/v1/jobs/job-1': () => jsonResponse({ id: 'job-1', status: 'succeeded', ...stray }),
      });
      const refused = client(fetch as typeof globalThis.fetch).attachRun('job-1');
      await expect(refused).rejects.toBeInstanceOf(NikaProtocolError);
      await expect(refused).rejects.toThrow('Durable job response contained unknown fields');
    }
  });
});

describe('cancellation on the 0.118 wire', () => {
  it('accepts 202 with the running job and settles from the terminal the stream carries later', async () => {
    const stream = controlledByteStream();
    const fetch = resident({
      '/v1/jobs/job-1/events': () => stream.response,
      '/v1/jobs/job-1/cancel': () => jsonResponse({
        id: 'job-1',
        status: 'running',
        execution_id: 'exe-1',
        trace_id: 'trace-1',
      }, 202),
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');
    const observer = nika.events(run)[Symbol.asyncIterator]();
    stream.enqueue(sseFrame(STARTED));
    await expect(observer.next()).resolves.toMatchObject({ done: false, value: STARTED });

    const cancellation = nika.cancel(run);
    expect(nika.cancel(run)).toBe(cancellation);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/v1/jobs/job-1/cancel'))).toBe(true);
    await expect(Promise.race([
      run.done,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])).resolves.toBe('pending');

    // The grace expired on the resident: the owner recorded interrupted.
    stream.enqueue(sseFrame(INTERRUPTED_FRAME));
    stream.close();
    await expect(cancellation).resolves.toEqual({
      runId: 'job-1',
      accepted: true,
      status: 'cancellation_requested',
      transport: 'http',
    });
    const result = await run.done;
    expect(result).toMatchObject({
      id: 'job-1',
      status: 'interrupted',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
      receipt: RECEIPT,
    });
    expect(result.settlement).toBeUndefined();
    await expect(observer.next()).resolves.toEqual({ done: false, value: INTERRUPTED_FRAME });
    await expect(observer.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('refuses a 202 that carries a terminal job', async () => {
    const stream = controlledByteStream();
    const fetch = resident({
      '/v1/jobs/job-1': () => jsonResponse({ id: 'job-1', status: 'interrupted', receipt: RECEIPT }),
      '/v1/jobs/job-1/events': () => stream.response,
      '/v1/jobs/job-1/cancel': () => jsonResponse({ id: 'job-1', status: 'cancelled' }, 202),
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');

    await expect(nika.cancel(run)).rejects.toThrow(/Pending cancellation returned a terminal job/);
    stream.close();
  });

  it('replays an ended observation with 200 and reports nothing cancelled', async () => {
    const stream = controlledByteStream();
    const fetch = resident({
      '/v1/jobs/job-1': () => jsonResponse({ id: 'job-1', status: 'interrupted', receipt: RECEIPT }),
      '/v1/jobs/job-1/events': () => stream.response,
      '/v1/jobs/job-1/cancel': () => jsonResponse({
        id: 'job-1',
        status: 'interrupted',
        execution_id: 'exe-1',
        trace_id: 'trace-1',
        receipt: RECEIPT,
      }),
    });
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.run('flow.nika.yaml');

    await expect(nika.cancel(run)).resolves.toEqual({
      runId: 'job-1',
      accepted: false,
      status: 'already_settled',
      transport: 'http',
    });
    await expect(run.done).resolves.toMatchObject({ status: 'interrupted', receipt: RECEIPT });
    // The settled cancel closed the observation itself; the body is already cancelled.
  });
});

describe('the trace verdict the door answers', () => {
  const receipt = { job_id: 'job-1', trace_id: 'trace-1' };

  function verify(answer: unknown) {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(answer));
    return client(fetch as typeof globalThis.fetch).traceVerify(receipt);
  }

  it.each([
    ['SEALED', true],
    ['OK', true],
    ['ANCHORED', true],
    ['REPLAYED', true],
    ['verified', true],
    ['INCOMPLETE', false],
    ['TAMPERED', false],
    ['invalid', false],
  ])('reads a %s verdict without demanding a reason', async (verdict, verified) => {
    await expect(verify({ verdict, trace_id: 'trace-1' })).resolves.toEqual({
      verified,
      verdict,
      trace_id: 'trace-1',
    });
  });

  it('keeps the typed unavailable refusal the 0.118 door still answers', async () => {
    await expect(verify({
      verdict: 'unavailable',
      reason: 'trace_journal_unavailable',
      trace_id: 'trace-1',
    })).resolves.toEqual({
      verified: false,
      verdict: 'unavailable',
      reason: 'trace_journal_unavailable',
      trace_id: 'trace-1',
    });
  });

  it('never holds a verdict bound to another trace', async () => {
    await expect(verify({ verdict: 'SEALED', trace_id: 'trace-other' }))
      .resolves.toMatchObject({ verified: false, verdict: 'SEALED' });
  });

  it('never holds a verdict the door did not bind to a trace', async () => {
    await expect(verify({ verdict: 'SEALED' }))
      .resolves.toEqual({ verified: false, verdict: 'SEALED' });
  });

  it('refuses a verdict or a reason that is not a string', async () => {
    await expect(verify({ verdict: 3 })).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(verify({ verdict: 'SEALED', reason: 7 })).rejects.toBeInstanceOf(NikaProtocolError);
  });
});

describe('the settlement readers', () => {
  it('keeps status and the named error on a nested settlement', () => {
    const frame = { ...FAILED_FRAME } as NikaEvent;
    expect(eventSettlement(frame)).toEqual(FAILED);
    // The settlement's error names the task; the frame's code and message do not.
    expect(eventError(frame)).toEqual(FAILED.error);
  });

  it('validates known facts and rides the rest through', () => {
    expect(readSettlement({}, 'http')).toEqual({});
    expect(readSettlement(
      { spend: { total_cost_usd: null, priced_calls: 0, unpriced_calls: 0, qualifier: 'unmetered' } },
      'http',
    ).spend).toEqual({ total_cost_usd: null, priced_calls: 0, unpriced_calls: 0, qualifier: 'unmetered' });
    expect(readSettlement(
      { spend: { total_cost_usd: 0.000003, by_source: { openai: 0.000003 }, priced_calls: 1, unpriced_calls: 0, qualifier: 'priced' } },
      'http',
    ).spend).toMatchObject({ by_source: { openai: 0.000003 } });
    expect(() => readSettlement({ tasks: { ok: -1 } }, 'http')).toThrow(/tasks.ok/);
    expect(() => readSettlement({ spend: { by_source: { openai: 'x' } } }, 'http')).toThrow(/by_source.openai/);
    expect(() => readSettlement({ error: { code: 'NIKA-X' } }, 'http')).toThrow(/error omitted/);
    expect(() => readSettlement('settled', 'http')).toThrow(/not an object/);
    expect(() => readSettlement({ status: 'failed' }, 'http', 'succeeded')).toThrow(/contradicts/);
  });
});
