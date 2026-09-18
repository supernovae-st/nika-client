import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError, isNikaRunSucceeded } from '../src/index.js';
import type { NikaJournalEvidence, NikaRunResult } from '../src/index.js';
import { TOKEN_A, healthResponse, jsonResponse, sseResponse } from './helpers/http-depth-harness.js';

// The resident's projections on ENGINE MAIN, ahead of this package's pin.
//
// Two additive, optional fields reach the closed `JobEvent` and `Job`
// projections after the pinned 0.118.7 contract (and after released 0.119.0,
// measured: it writes neither):
//
//   JobEvent.at        when the resident admitted the event (RFC 3339, UTC)
//   JobEvent.evidence  a reported journal delivery loss, closed:
//   Job.evidence         { status: "mirror_lost",
//                          reason: "write_failed" | "record_refused" }
//
// The frames below are copied from two captures of a CANDIDATE build of engine
// main (`nika 0.120.0-dev`, unreleased): a healthy run, and a run whose journal
// mirror could not be written. They pin how the SDK reads that wire, not what a
// release writes: recapture them from the release that ships these fields.
// `record_refused` was never observed; it is the contract's other word only.

const JOB = '546eccc2-7004-486e-bd5a-675b3cbaa5f8';
const OUTPUTS = Object.freeze({
  value: {
    approved: false, count: 42, note: null, ratio: 0.5,
    record: { name: '🦋' }, region: 'eu', tags: ['é', '東京'], ticket: 'T-1',
  },
});
const SETTLEMENT = Object.freeze({
  cause: 'normal',
  elapsed_ms: 13,
  spend: { priced_calls: 0, qualifier: 'unmetered', unpriced_calls: 0 },
  status: 'succeeded',
  tasks: { cancelled: 0, failed: 0, never_started: 0, ok: 1, recovered: 0, skipped: 0, total: 1 },
});
/** A lost mirror cannot advertise a chain head: the measured receipt carries none. */
const RECEIPT = Object.freeze({
  job_id: JOB,
  execution_id: 'exe-01a0b4c8-499c-77e3-b82d-011bd95be4df',
  trace_id: '01a0b4c8499c77e3b82d011bd95be4df',
  snapshot_digest: 'ab7556e0d6ff8fd2b921ef40777a8241f2b0ab5d7290a7068702637417055fea',
  origin: { kind: 'manual' },
});
const MIRROR_LOST: NikaJournalEvidence = Object.freeze({ status: 'mirror_lost', reason: 'write_failed' });

const QUEUED = { sequence: 1, at: '2026-09-18T13:50:20.033809Z', kind: 'execution.queued', status: 'queued' };
const STARTED = { sequence: 2, at: '2026-09-18T13:50:20.066876Z', kind: 'execution.started', status: 'running' };
const SETTLED = {
  sequence: 3,
  at: '2026-09-18T13:50:20.436656Z',
  kind: 'execution.settled',
  status: 'succeeded',
  outputs: OUTPUTS,
  receipt: RECEIPT,
  settlement: SETTLEMENT,
};
const DURABLE = {
  id: JOB,
  status: 'succeeded',
  execution_id: RECEIPT.execution_id,
  trace_id: RECEIPT.trace_id,
  outputs: OUTPUTS,
  receipt: RECEIPT,
  settlement: SETTLEMENT,
};

function remote(fetch: ReturnType<typeof vi.fn>): Nika {
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, fetch: fetch as typeof globalThis.fetch });
}

/** A run by served name whose stream is exactly `frames`. */
async function observed(frames: Record<string, unknown>[]) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(healthResponse())
    .mockResolvedValueOnce(jsonResponse({ id: JOB, status: 'queued' }, 202))
    .mockResolvedValueOnce(sseResponse(frames as never));
  const run = await remote(fetch).run('flow.nika.yaml', { idempotencyKey: 'engine-main' });
  return run;
}

/** Reattach to a job whose durable record is already terminal: settled from GET alone. */
async function attached(durable: Record<string, unknown>) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(healthResponse())
    .mockResolvedValueOnce(jsonResponse(durable));
  return remote(fetch).attachRun(JOB);
}

describe('engine main dates every frame (`JobEvent.at`)', () => {
  it('observes the measured healthy stream and keeps `at` untouched on the protocol frame', async () => {
    const run = await observed([QUEUED, STARTED, SETTLED]);
    const seen: { kind: string; raw: unknown; at: unknown }[] = [];
    for await (const event of run.events()) seen.push({ kind: event.kind, raw: event.raw.kind, at: event.raw.at });
    expect(seen).toEqual([
      { kind: 'engine.event', raw: 'execution.queued', at: '2026-09-18T13:50:20.033809Z' },
      { kind: 'run.started', raw: 'execution.started', at: '2026-09-18T13:50:20.066876Z' },
      { kind: 'run.settled', raw: 'execution.settled', at: '2026-09-18T13:50:20.436656Z' },
    ]);
    const result = await run.result();
    expect(result).toMatchObject({ status: 'succeeded', outputs: OUTPUTS, settlement: SETTLEMENT });
    // A healthy run reported no loss: nothing is inferred, the field is absent.
    expect(Object.hasOwn(result, 'evidence')).toBe(false);
  });

  it('accepts an offset timestamp and a whole-second one: RFC 3339, not one spelling of it', async () => {
    for (const at of ['2026-09-18T15:50:20+02:00', '2026-09-18T13:50:20Z']) {
      const run = await observed([{ ...SETTLED, sequence: 1, at }]);
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
    }
  });

  it.each([
    ['null', null],
    ['a number', 1789739420],
    ['an empty string', ''],
    ['prose', 'yesterday'],
    ['a date without a time', '2026-09-18'],
    ['a timestamp without a zone', '2026-09-18T13:50:20'],
    ['an impossible date', '2026-13-40T25:61:61Z'],
    ['an object', { iso: '2026-09-18T13:50:20Z' }],
  ])('refuses `at` that is %s', async (_name, at) => {
    const run = await observed([{ ...SETTLED, sequence: 1, at }]);
    const failure = await run.result().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message).toContain('data.at');
  });

  it('does not take `at` on the durable job: that projection never declared it', async () => {
    // The durable record is judged inside attachRun(): a refused record yields no run.
    await expect(attached({ ...DURABLE, at: SETTLED.at }))
      .rejects.toThrow('Durable job response contained unknown fields');
  });
});

describe('a run can succeed while its journal mirror is lost (`evidence`)', () => {
  it('settles succeeded from the stream and reports the loss on the result', async () => {
    const run = await observed([QUEUED, STARTED, { ...SETTLED, evidence: MIRROR_LOST }]);
    const frames = [];
    for await (const event of run.events()) frames.push(event);
    // The lifecycle projection is unchanged: the fact rides the protocol frame.
    expect(frames.at(-1)).toMatchObject({ kind: 'run.settled', status: 'succeeded' });
    expect(frames.at(-1)!.raw.evidence).toEqual(MIRROR_LOST);

    const result = await run.result();
    expect(result.evidence).toEqual(MIRROR_LOST);
    // Evidence is never a verdict: state, settlement and receipt are the engine's.
    expect(result.status).toBe('succeeded');
    expect(isNikaRunSucceeded(result)).toBe(true);
    expect(result.settlement).toEqual(SETTLEMENT);
    expect(result.receipt).toEqual(RECEIPT);
    expect(result.outputs).toEqual(OUTPUTS);
  });

  it('settles succeeded from the durable record on attach and reports the same loss', async () => {
    const run = await attached({ ...DURABLE, evidence: MIRROR_LOST });
    const result = await run.result();
    expect(result.evidence).toEqual(MIRROR_LOST);
    expect(result).toMatchObject({
      id: JOB,
      status: 'succeeded',
      execution_id: RECEIPT.execution_id,
      trace_id: RECEIPT.trace_id,
      settlement: SETTLEMENT,
      receipt: RECEIPT,
    });
    expect(isNikaRunSucceeded(result)).toBe(true);
  });

  it('settles from the durable record when the stream resets before its terminal frame', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/health') return healthResponse();
      if (pathname === '/v1/jobs') return jsonResponse({ id: JOB, status: 'queued' }, 202);
      if (pathname === `/v1/jobs/${JOB}/events`) return sseResponse([QUEUED, STARTED] as never);
      if (pathname === `/v1/jobs/${JOB}`) return jsonResponse({ ...DURABLE, evidence: MIRROR_LOST });
      throw new Error(`unexpected ${pathname}`);
    });
    const run = await remote(fetch as never).run('flow.nika.yaml', { idempotencyKey: 'engine-main' });
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', evidence: MIRROR_LOST });
  });

  it('accepts the contract\'s other reason word (never observed, contract only)', async () => {
    const refused: NikaJournalEvidence = { status: 'mirror_lost', reason: 'record_refused' };
    const run = await attached({ ...DURABLE, evidence: refused });
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', evidence: refused });
  });

  it('leaves a failed run failed: a lost mirror explains nothing about the execution', async () => {
    const failed = {
      id: JOB,
      status: 'failed',
      error: { code: 'NIKA-EXEC-001', message: 'command exited with status 1' },
      evidence: MIRROR_LOST,
    };
    const result = await (await attached(failed)).result();
    expect(result).toMatchObject({ status: 'failed', error: failed.error, evidence: MIRROR_LOST });
    expect(isNikaRunSucceeded(result)).toBe(false);
  });

  const MALFORMED: [string, unknown][] = [
    ['null', null],
    ['a string', 'mirror_lost'],
    ['an array', ['mirror_lost', 'write_failed']],
    ['an empty object', {}],
    ['a missing reason', { status: 'mirror_lost' }],
    ['a missing status', { reason: 'write_failed' }],
    ['an extra field', { status: 'mirror_lost', reason: 'write_failed', path: '/var/journal' }],
    ['an unknown status', { status: 'mirror_ok', reason: 'write_failed' }],
    ['an unknown reason', { status: 'mirror_lost', reason: 'disk_full' }],
    ['a status that is not a string', { status: 1, reason: 'write_failed' }],
    ['a reason that is not a string', { status: 'mirror_lost', reason: null }],
    ['empty words', { status: '', reason: '' }],
    ['words in another case', { status: 'MIRROR_LOST', reason: 'WRITE_FAILED' }],
  ];

  it.each(MALFORMED)('refuses evidence on a frame that is %s', async (_name, evidence) => {
    const run = await observed([{ ...SETTLED, sequence: 1, evidence }]);
    const failure = await run.result().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message).toContain('evidence');
  });

  it.each(MALFORMED)('refuses evidence on the durable job that is %s', async (_name, evidence) => {
    // Refused inside attachRun(): no run is handed out for a record it cannot read.
    const failure = await attached({ ...DURABLE, evidence }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message).toContain('evidence');
  });

  it('never quotes a malformed evidence value: it could carry a local path', async () => {
    const failure = await attached({
      ...DURABLE,
      evidence: { status: 'mirror_lost', reason: '/private/SENTINEL' },
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect(String(failure)).not.toContain('SENTINEL');
  });
});

describe('both projections stay closed around the two new fields', () => {
  it.each(['at_ms', 'evidence2', 'journal', 'path'])(
    'still refuses an unknown sibling `%s` on a frame',
    async (field) => {
      const run = await observed([{ ...SETTLED, sequence: 1, [field]: 'x' }]);
      await expect(run.result()).rejects.toThrow('SSE data contained fields outside the public projection');
    },
  );

  it.each(['at', 'evidence2', 'journal', 'path'])(
    'still refuses an unknown sibling `%s` on the durable job',
    async (field) => {
      await expect(attached({ ...DURABLE, [field]: 'x' }))
        .rejects.toThrow('Durable job response contained unknown fields');
    },
  );
});

describe('nothing is invented where the engine said nothing', () => {
  it('adds no evidence to a run of a resident that predates the field (the pinned wire)', async () => {
    const pinned = { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT };
    const result = await (await observed([pinned])).result();
    expect(result.status).toBe('succeeded');
    expect(Object.hasOwn(result, 'evidence')).toBe(false);
    const durable = await (await attached({ id: JOB, status: 'succeeded', receipt: RECEIPT })).result();
    expect(Object.hasOwn(durable, 'evidence')).toBe(false);
  });

  it('adds no evidence to a native run: a direct process reports no journal mirror', async () => {
    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-nika.mjs');
    const result: NikaRunResult = await (await new Nika({ bin: fixture }).run('ok.nika.yaml')).result();
    expect(result.status).toBe('succeeded');
    expect(Object.hasOwn(result, 'evidence')).toBe(false);
  });
});
