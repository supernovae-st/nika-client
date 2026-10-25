import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError, isNikaRunSucceeded } from '../src/index.js';
import type { NikaRunEvent } from '../src/index.js';
import { DEFAULT_MACHINE_BUFFER_BYTES } from '../src/lib/machine-buffer.js';
import { TOKEN_A, healthResponse, sseText } from './helpers/http-depth-harness.js';

// NIK-267 · `machineBufferBytes` defaults to 16 MiB, the resident's job-store
// bound (engine 0.123.1 `MAX_JOB_SNAPSHOT_BYTES`): a server refuses, never
// truncates, a result that would outgrow it, so every result it settles fits.
// The old 64 KiB default refused any result above about 48 KB of image bytes
// (base64 widens them by a third) with « SSE buffer exceeded 65536 bytes »,
// though the job had succeeded. A frame past the bound is still refused, and
// the refusal names the option and the size to set: exactly enough, as each
// test proves by fitting the frame at that size and refusing it one byte lower.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const KIB_64 = 64 * 1024;
/** Above 64 KiB, as a 150 KB PNG is once base64 rides `outputs`. */
const BLOB = 200_000;

const RECEIPT = {
  job_id: 'job-1',
  execution_id: 'exe-01a174d0-0000-7000-8000-000000000001',
  trace_id: '01a174d0000070008000000000000001',
  snapshot_digest: 'c'.repeat(64),
  origin: { kind: 'manual' },
  chain_head: 'd'.repeat(64),
};
const SETTLEMENT = {
  cause: 'normal',
  elapsed_ms: 9,
  spend: { priced_calls: 0, qualifier: 'unpriced', unpriced_calls: 1 },
  status: 'succeeded',
  tasks: { cancelled: 0, failed: 0, never_started: 0, ok: 1, recovered: 0, skipped: 0, total: 1 },
};

/** The terminal frame of a job with inputs, as 0.123.1 streams it: the outputs whole. */
function settledFrame(blob: number, sequence = 3): string {
  return `id: ${sequence}\ndata: ${JSON.stringify({
    sequence,
    at: '2026-10-25T20:40:40.123456Z',
    kind: 'execution.settled',
    status: 'succeeded',
    outputs: { blob: 'x'.repeat(blob) },
    receipt: RECEIPT,
    settlement: SETTLEMENT,
  })}\n\n`;
}

/** The job's SSE stream, measured shape: a job with inputs opens with `execution.queued`. */
function jobStream(blob: number): string {
  return [
    'retry: 1000\n\n',
    'id: 1\ndata: {"sequence":1,"at":"2026-10-25T20:40:40.1Z","kind":"execution.queued","status":"queued"}\n\n',
    'id: 2\ndata: {"sequence":2,"at":"2026-10-25T20:40:40.2Z","kind":"execution.started","status":"running"}\n\n',
    settledFrame(blob),
  ].join('');
}

/** The job's durable record, with the `Content-Length` 0.123.1 sends, unless told not to. */
function jobRecord(blob: number, declare = true): Response {
  const text = JSON.stringify({
    id: 'job-1',
    status: 'succeeded',
    execution_id: RECEIPT.execution_id,
    trace_id: RECEIPT.trace_id,
    outputs: { blob: 'x'.repeat(blob) },
    receipt: RECEIPT,
    settlement: SETTLEMENT,
  });
  return new Response(text, {
    headers: {
      'Content-Type': 'application/json',
      ...(declare ? { 'Content-Length': String(Buffer.byteLength(text)) } : {}),
    },
  });
}

/** A resident serving one job, `job-1`, whose result carries `blob` characters. */
function resident(blob: number, options: { declare?: boolean } = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const route = new URL(String(input)).pathname;
    if (route === '/health') {
      return healthResponse({ supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs'] });
    }
    if (route === '/v1/jobs') {
      return new Response('{"id":"job-1","status":"queued"}', {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (route === '/v1/jobs/job-1') return jobRecord(blob, options.declare);
    if (route === '/v1/jobs/job-1/events') return sseText(jobStream(blob));
    throw new Error(`unexpected route ${route}`);
  });
}

function remote(fetch: ReturnType<typeof vi.fn>, machineBufferBytes?: number): Nika {
  return new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    fetch: fetch as typeof globalThis.fetch,
    ...(machineBufferBytes === undefined ? {} : { machineBufferBytes }),
  });
}

function local(machineBufferBytes?: number): Nika {
  return new Nika({ bin: ENGINE, ...(machineBufferBytes === undefined ? {} : { machineBufferBytes }) });
}

async function collect(events: AsyncIterable<NikaRunEvent>): Promise<NikaRunEvent[]> {
  const seen: NikaRunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a refusal');
}

const LEAVE_UNSET = ', or leave it unset: its 16 MiB default holds any result nika serve settles';

describe('the default machineBufferBytes', () => {
  it('is 16 MiB, the bound of a nika serve job store', () => {
    expect(DEFAULT_MACHINE_BUFFER_BYTES).toBe(16 * 1024 * 1024);
  });

  it('settles a server result above 64 KiB through run.result() and attachRun()', async () => {
    const fetch = resident(BLOB);
    const nika = remote(fetch);
    const run = await nika.run('big-echo.nika', { idempotencyKey: 'k-big', inputs: { blob: 'x' } });
    const events = await collect(run.events());
    // A job with inputs opens with `execution.queued`, an `engine.event`.
    expect(events.map((event) => [event.kind, event.sequence])).toEqual([
      ['engine.event', 1], ['run.started', 2], ['run.settled', 3],
    ]);
    expect(events[0]?.raw).toMatchObject({ kind: 'execution.queued', status: 'queued' });
    const result = await run.result();
    expect(isNikaRunSucceeded(result)).toBe(true);
    expect((result.outputs?.blob as string).length).toBe(BLOB);

    const attached = await nika.attachRun('job-1');
    const recovered = await attached.result();
    expect(recovered).toMatchObject({ status: 'succeeded', settlement: SETTLEMENT });
    expect((recovered.outputs?.blob as string).length).toBe(BLOB);
  });

  it('settles a local result above 64 KiB, which rides run_settled whole', async () => {
    const run = await local().run(`big-settled-${BLOB}.nika`);
    const result = await run.result();
    expect(result).toMatchObject({ status: 'succeeded', exitCode: 0, settlement: { cause: 'normal' } });
    expect((result.outputs?.blob as string).length).toBe(BLOB);
  });

  it('fits a server frame of exactly 16 MiB and refuses one byte more, naming the size', async () => {
    const overhead = Buffer.byteLength(settledFrame(0, 1));
    const fits = settledFrame(DEFAULT_MACHINE_BUFFER_BYTES - overhead, 1);
    expect(Buffer.byteLength(fits)).toBe(DEFAULT_MACHINE_BUFFER_BYTES);
    const run = async (blob: number) => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(healthResponse())
        .mockResolvedValueOnce(new Response('{"id":"job-1","status":"queued"}', {
          status: 202, headers: { 'Content-Type': 'application/json' },
        }))
        .mockResolvedValueOnce(sseText(settledFrame(blob, 1)));
      return (await remote(fetch).run('big.nika', { idempotencyKey: 'k' })).result();
    };
    await expect(run(DEFAULT_MACHINE_BUFFER_BYTES - overhead)).resolves.toMatchObject({ status: 'succeeded' });
    const refusal = await failure(run(DEFAULT_MACHINE_BUFFER_BYTES - overhead + 1));
    // At the default itself there is no smaller bound to undo: no « leave it unset ».
    expect(refusal.message).toBe(
      `SSE event frame of job job-1 exceeded ${DEFAULT_MACHINE_BUFFER_BYTES} bytes (machineBufferBytes): `
      + `it is ${DEFAULT_MACHINE_BUFFER_BYTES + 1} bytes. Set machineBufferBytes to at least `
      + `${DEFAULT_MACHINE_BUFFER_BYTES + 1}. The job itself is unaffected: attachRun('job-1') reads it again`,
    );
  });
});

describe('a frame past machineBufferBytes names the option and the size to set', () => {
  it('over SSE: the whole frame, measured to its blank line', async () => {
    const needed = Buffer.byteLength(settledFrame(BLOB));
    const run = await remote(resident(BLOB), KIB_64).run('big-echo.nika', { idempotencyKey: 'k' });
    const refusal = await failure(run.result());
    expect(refusal).toBeInstanceOf(NikaProtocolError);
    expect(refusal).toMatchObject({ transport: 'http' });
    expect(refusal.message).toBe(
      `SSE event frame of job job-1 exceeded 65536 bytes (machineBufferBytes): it is ${needed} bytes. `
      + `Set machineBufferBytes to at least ${needed}${LEAVE_UNSET}. `
      + "The job itself is unaffected: attachRun('job-1') reads it again",
    );
    // The frames before it were delivered: a view opened now replays them.
    const replayed = (await collect(run.events())).map((event) => event.kind);
    expect(replayed).toEqual(['engine.event', 'run.started']);
  });

  it('over SSE: the size it names is exactly enough', async () => {
    const needed = Buffer.byteLength(settledFrame(BLOB, 1));
    const stream = (bound: number) => {
      const fetch = vi.fn()
        .mockResolvedValueOnce(healthResponse())
        .mockResolvedValueOnce(new Response('{"id":"job-1","status":"queued"}', {
          status: 202, headers: { 'Content-Type': 'application/json' },
        }))
        .mockResolvedValueOnce(sseText(settledFrame(BLOB, 1)));
      return remote(fetch, bound).run('big.nika', { idempotencyKey: 'k' }).then((run) => run.result());
    };
    await expect(stream(needed)).resolves.toMatchObject({ status: 'succeeded' });
    await expect(stream(needed - 1)).rejects.toThrow(`it is ${needed} bytes`);
  });

  it('a job record whose Content-Length is past the bound: exact, refused before its body is read', async () => {
    const declared = Number(jobRecord(BLOB).headers.get('Content-Length'));
    // Reading this body would fail the read itself, as a reset: the refusal
    // below is the bound's, so nothing was read.
    const unread = new Response(new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('the body must not be read'));
      },
    }), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(declared) } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(unread);
    const refusal = await failure(remote(fetch, KIB_64).attachRun('job-1'));
    expect(refusal).toBeInstanceOf(NikaProtocolError);
    expect(refusal.message).toBe(
      `HTTP /v1/jobs/job-1 JSON exceeded 65536 bytes (machineBufferBytes): it is ${declared} bytes. `
      + `Set machineBufferBytes to at least ${declared}${LEAVE_UNSET}`,
    );
  });

  it('a job record with no declared length: the count where the bound broke, as a floor', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jobRecord(BLOB, false));
    const refusal = await failure(remote(fetch, KIB_64).attachRun('job-1'));
    expect(refusal.message).toMatch(
      /^HTTP \/v1\/jobs\/job-1 JSON exceeded 65536 bytes \(machineBufferBytes\): it is at least (\d+) bytes\. Set machineBufferBytes above \1, or leave it unset: its 16 MiB default holds any result nika serve settles$/,
    );
  });

  it('a local machine line: the whole line, measured to its line feed, exactly enough', async () => {
    const needed = Buffer.byteLength(JSON.stringify({
      kind: 'run_settled', status: 'succeeded', cause: 'normal', outputs: { blob: 'b'.repeat(BLOB) },
    }));
    const run = await local(KIB_64).run(`big-settled-${BLOB}.nika`);
    const refusal = await failure(run.result());
    expect(refusal).toBeInstanceOf(NikaProtocolError);
    expect(refusal).toMatchObject({ transport: 'native-process' });
    // A local engine bounds no frame: the default is no promise here.
    expect(refusal.message).toBe(
      `Native machine line exceeded 65536 bytes (machineBufferBytes): it is ${needed} bytes. `
      + `Set machineBufferBytes to at least ${needed}`,
    );
    await expect((await local(needed).run(`big-settled-${BLOB}.nika`)).result())
      .resolves.toMatchObject({ status: 'succeeded' });
    await expect((await local(needed - 1).run(`big-settled-${BLOB}.nika`)).result())
      .rejects.toThrow(`it is ${needed} bytes`);
  });

  it('a local check report: refused whole with its size, never cut to its tail', async () => {
    // 70,000 bytes of report and its line feed.
    const refusal = await failure(local(KIB_64).check('big-report-70000.nika'));
    expect(refusal).toBeInstanceOf(NikaProtocolError);
    expect(refusal.message).toBe(
      '`nika check` output exceeded 65536 bytes (machineBufferBytes): it is 70001 bytes. '
      + 'Set machineBufferBytes to at least 70001',
    );
    const report = await local().check('big-report-70000.nika');
    expect(report).toMatchObject({ clean: true, exitCode: 0 });
    expect(String(report.pad).length).toBe(70_000 - '{"report_version":1,"clean":true,"pad":"'.length - 2);
  });
});
