import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaObservationInterrupted,
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import { NikaEngineUnavailable, resolveNikaEngine } from '../src/lib/binary/index.js';
import { HttpTransport } from '../src/lib/http-transport.js';
import { SseParseError, SseParser } from '../src/lib/sse/parser.js';
import type { NikaEvent } from '../src/types.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);
const SERVER_TOKEN = 's'.repeat(32);

function healthResponse(): Response {
  return jsonResponse({
    status: 'ok',
    service: 'nika-serve',
    engineVersion: '0.114.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 1,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
  });
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function byteStream(chunks: Uint8Array[], reset = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else if (reset) controller.error(new TypeError('connection reset'));
      else controller.close();
    },
  });
}

function sseBytes(chunks: Uint8Array[], reset = false): Response {
  return new Response(byteStream(chunks, reset), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

function sse(text: string, reset = false): Response {
  return sseBytes([new TextEncoder().encode(text)], reset);
}

function frame(event: NikaEvent, newline = '\n'): string {
  return `id: ${event.sequence}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
}

function transport(
  fetch: typeof globalThis.fetch,
  delays: number[] = [],
): HttpTransport {
  return new HttpTransport({
    url: 'https://nika.example',
    token: SERVER_TOKEN,
    fetch,
    requestTimeout: 1_000,
    machineBufferBytes: 64 * 1024,
    resolveEngine: () => resolveNikaEngine(FIXTURE),
    retryDelay: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
}

function admittedFetch(...observation: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetch = vi.fn()
    .mockResolvedValueOnce(healthResponse())
    .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202));
  for (const result of observation) {
    if (result instanceof Error) fetch.mockRejectedValueOnce(result);
    else fetch.mockResolvedValueOnce(result);
  }
  return fetch;
}

async function startObserved(fetch: ReturnType<typeof vi.fn>, delays: number[] = []) {
  const source = await transport(fetch as typeof globalThis.fetch, delays)
    .startRun('flow.nika.yaml', {});
  const events = collect(source.events);
  return { source, events };
}

async function collect(iterable: AsyncIterable<NikaEvent>): Promise<NikaEvent[]> {
  const events: NikaEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('bounded incremental SSE parser', () => {
  it('parses fragmented UTF-8 and field names without corrupting bytes', async () => {
    const text = frame({ sequence: 1, kind: 'café 🦋', status: 'succeeded' });
    const bytes = new TextEncoder().encode(text);
    const chunks = [...bytes].map((byte) => Uint8Array.of(byte));
    const fetch = admittedFetch(sseBytes(chunks));
    const { source, events } = await startObserved(fetch);
    await expect(events).resolves.toEqual([
      { sequence: 1, kind: 'café 🦋', status: 'succeeded' },
    ]);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('assembles a near-limit line from one-byte fragments without repeated copying', () => {
    const limit = 64 * 1024;
    const payload = 'x'.repeat(limit - 8);
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    const parser = new SseParser({
      maxLineBytes: limit,
      maxFrameBytes: limit,
      maxBufferBytes: limit,
    });
    const frames = [];
    for (const byte of bytes) frames.push(...parser.push(Uint8Array.of(byte)));
    expect(frames).toEqual([{ data: payload }]);
    expect(parser.finish()).toEqual([]);
  });

  it('accepts CRLF, multiline data, comments, retry and empty control fields', async () => {
    const body = [
      ': heartbeat\r\n',
      'retry: 0\r\n',
      'id:\r\n',
      '\r\n',
      'id: 1\r\n',
      'data: {"sequence":1,\r\n',
      'data: "kind":"settled","status":"succeeded"}\r\n',
      '\r\n',
    ].join('');
    const fetch = admittedFetch(sse(body));
    const { source, events } = await startObserved(fetch);
    await expect(events).resolves.toEqual([
      { sequence: 1, kind: 'settled', status: 'succeeded' },
    ]);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('enforces independent line, frame and pending-buffer ceilings', () => {
    const encoder = new TextEncoder();
    expect(() => new SseParser({
      maxLineBytes: 3,
      maxFrameBytes: 100,
      maxBufferBytes: 100,
    }).push(encoder.encode('data'))).toThrow(/line exceeded/);
    expect(() => new SseParser({
      maxLineBytes: 100,
      maxFrameBytes: 6,
      maxBufferBytes: 100,
    }).push(encoder.encode('id: 1\n\n'))).toThrow(/frame exceeded/);
    expect(() => new SseParser({
      maxLineBytes: 100,
      maxFrameBytes: 100,
      maxBufferBytes: 3,
    }).push(encoder.encode('data'))).toThrow(/buffer exceeded/);
  });

  it('rejects an incomplete data frame at EOF', () => {
    const parser = new SseParser({
      maxLineBytes: 100,
      maxFrameBytes: 100,
      maxBufferBytes: 100,
    });
    parser.push(new TextEncoder().encode('id: 1\ndata: {}'));
    expect(() => parser.finish()).toThrow(SseParseError);
  });
});

describe('HTTP observation state machine', () => {
  it('drops one exact replay and resumes at the required next sequence', async () => {
    const one = { sequence: 1, kind: 'running', status: 'running' } as const;
    const two = { sequence: 2, kind: 'settled', status: 'succeeded' } as const;
    const fetch = admittedFetch(
      sse(frame(one)),
      jsonResponse({ id: 'job-1', status: 'running' }),
      sse(frame(one) + frame(two)),
    );
    const { source, events } = await startObserved(fetch);
    await expect(events).resolves.toEqual([one, two]);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
    const reconnectHeaders = new Headers(fetch.mock.calls[4]?.[1]?.headers);
    expect(reconnectHeaders.get('Last-Event-ID')).toBe('1');
  });

  it('refuses sequence gaps and id/data mismatches permanently', async () => {
    for (const bad of [
      'id: 2\ndata: {"sequence":2,"status":"running"}\n\n',
      'id: 1\ndata: {"sequence":2,"status":"running"}\n\n',
    ]) {
      const fetch = admittedFetch(sse(bad));
      const { source, events } = await startObserved(fetch);
      await expect(events).rejects.toBeInstanceOf(NikaProtocolError);
      await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  });

  it('GETs durable state after a reset, then resumes with Last-Event-ID', async () => {
    const fetch = admittedFetch(
      sse(frame({ sequence: 1, kind: 'running', status: 'running' }), true),
      jsonResponse({ id: 'job-1', status: 'running', execution_id: 'exe-1' }),
      sse(frame({ sequence: 2, kind: 'settled', status: 'succeeded' })),
    );
    const { source, events } = await startObserved(fetch);
    await expect(events).resolves.toHaveLength(2);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(String(fetch.mock.calls[3]?.[0])).toBe('https://nika.example/v1/jobs/job-1');
    expect(new Headers(fetch.mock.calls[4]?.[1]?.headers).get('Last-Event-ID')).toBe('1');
  });

  it('settles eager done from terminal durable GET without emitting a synthetic event', async () => {
    const fetch = admittedFetch(
      sse(''),
      jsonResponse({
        id: 'job-1',
        status: 'failed',
        execution_id: 'exe-1',
        trace_id: 'trace-1',
        error: { code: 'NIKA-TEST-001', message: 'failed safely' },
      }),
    );
    const client = new Nika({
      url: 'https://nika.example',
      token: SERVER_TOKEN,
      bin: FIXTURE,
      fetch: fetch as typeof globalThis.fetch,
    });
    const run = await client.run('flow.nika.yaml');
    await expect(run.done).resolves.toMatchObject({
      id: 'job-1',
      status: 'failed',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
      error: { code: 'NIKA-TEST-001', message: 'failed safely' },
    });
    await expect(collect(client.events(run))).resolves.toEqual([]);
  });

  it('retries 429 and selected 5xx with bounded Retry-After delays', async () => {
    const delays: number[] = [];
    const fetch = admittedFetch(
      new Response(null, { status: 429, headers: { 'Retry-After': '0' } }),
      new Response(null, { status: 503, headers: { 'Retry-After': '0' } }),
      sse(frame({ sequence: 1, kind: 'settled', status: 'succeeded' })),
    );
    const { source, events } = await startObserved(fetch, delays);
    await expect(events).resolves.toHaveLength(1);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(delays).toEqual([25, 25]);
  });

  it('resets the consecutive retry budget after each newly accepted event', async () => {
    const delays: number[] = [];
    const observation: Response[] = [];
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      observation.push(sse(frame({ sequence, kind: 'running', status: 'running' })));
      observation.push(jsonResponse({ id: 'job-1', status: 'running' }));
    }
    observation.push(sse(frame({ sequence: 7, kind: 'settled', status: 'succeeded' })));
    const fetch = admittedFetch(...observation);
    const { source, events } = await startObserved(fetch, delays);
    await expect(events).resolves.toHaveLength(7);
    await expect(source.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(delays).toEqual(Array.from({ length: 6 }, () => 100));
  });

  it.each([401, 403])('treats HTTP %i as a permanent authorization failure', async (status) => {
    const fetch = admittedFetch(new Response('do not expose server-token', { status }));
    const { source, events } = await startObserved(fetch);
    await expect(events).rejects.toBeInstanceOf(NikaTransportError);
    await expect(source.done).rejects.not.toThrow(/server-token|do not expose/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('treats a 404 confirmed by durable GET as permanently stable', async () => {
    const fetch = admittedFetch(
      jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404),
      jsonResponse({ error: { code: 'not_found', message: 'missing' } }, 404),
    );
    const { source, events } = await startObserved(fetch);
    await expect(events).rejects.toThrow(/durably absent/);
    await expect(source.done).rejects.toBeInstanceOf(NikaTransportError);
    expect(String(fetch.mock.calls[3]?.[0])).toBe('https://nika.example/v1/jobs/job-1');
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('treats 204 and invalid event content-type as permanent protocol failures', async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      jsonResponse({ nope: true }),
    ]) {
      const fetch = admittedFetch(response);
      const { source, events } = await startObserved(fetch);
      await expect(events).rejects.toBeInstanceOf(NikaProtocolError);
      await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  });

  it('rejects malformed and oversized frames without retrying', async () => {
    for (const response of [
      sse('id: 1\ndata: not-json\n\n'),
      sse(`id: 1\ndata: ${'x'.repeat(70 * 1024)}\n\n`),
    ]) {
      const fetch = admittedFetch(response);
      const { source, events } = await startObserved(fetch);
      await expect(events).rejects.toBeInstanceOf(NikaProtocolError);
      await expect(source.done).rejects.toBeInstanceOf(NikaProtocolError);
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  });

  it('stops after the finite retry budget is exhausted', async () => {
    const delays: number[] = [];
    const fetch = admittedFetch(
      ...Array.from({ length: 6 }, () => new TypeError('reset server-token')),
      jsonResponse({ id: 'job-1', status: 'running' }),
    );
    const { source, events } = await startObserved(fetch, delays);
    await expect(events).rejects.toBeInstanceOf(NikaObservationInterrupted);
    await expect(source.done).rejects.toBeInstanceOf(NikaObservationInterrupted);
    await expect(source.done).rejects.not.toThrow(/server-token/);
    expect(delays).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it('settles done from a final durable read when observation exhausts', async () => {
    const fetch = admittedFetch(
      ...Array.from({ length: 6 }, () => new TypeError('connection reset')),
      jsonResponse({
        id: 'job-1',
        status: 'succeeded',
        execution_id: 'exe-1',
        trace_id: 'trace-1',
      }),
    );
    const { source, events } = await startObserved(fetch);
    await expect(events).resolves.toEqual([]);
    await expect(source.done).resolves.toMatchObject({
      id: 'job-1',
      status: 'succeeded',
      execution_id: 'exe-1',
      trace_id: 'trace-1',
    });
    expect(String(fetch.mock.calls[8]?.[0])).toBe('https://nika.example/v1/jobs/job-1');
  });

  it('interrupts with a resumable cursor when the final durable read stays non-terminal', async () => {
    const one = { sequence: 1, kind: 'running', status: 'running' } as const;
    const two = { sequence: 2, kind: 'settled', status: 'succeeded' } as const;
    const delays: number[] = [];
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sse(frame(one), true))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'running' }))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'running' }))
      .mockResolvedValueOnce(sse(frame(two)));
    const direct = transport(fetch as typeof globalThis.fetch, delays);
    const source = await direct.startRun('flow.nika.yaml', {});
    const events = collect(source.events);

    await expect(events).rejects.toBeInstanceOf(NikaObservationInterrupted);
    let failure: unknown;
    try {
      await source.done;
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(NikaObservationInterrupted);
    expect(failure).toBeInstanceOf(NikaTransportError);
    expect(failure).toMatchObject({
      name: 'NikaObservationInterrupted',
      transport: 'http',
      runId: 'job-1',
      lastSequence: 1,
      attempts: 5,
    });
    expect(delays).toHaveLength(5);

    const cursor = (failure as NikaObservationInterrupted).lastSequence;
    const resumed = await direct.attachRun('job-1', { lastEventId: cursor });
    const resumedEvents = collect(resumed.events);
    await expect(resumed.done).resolves.toMatchObject({
      id: 'job-1',
      status: 'succeeded',
    });
    await expect(resumedEvents).resolves.toEqual([two]);
    const resumeHeaders = new Headers(fetch.mock.calls[11]?.[1]?.headers);
    expect(resumeHeaders.get('Last-Event-ID')).toBe('1');
  });
});

describe('HTTP engine resolution boundary', () => {
  function lazyTransport(
    fetch: ReturnType<typeof vi.fn>,
    resolveEngine: () => ReturnType<typeof resolveNikaEngine>,
  ): HttpTransport {
    return new HttpTransport({
      url: 'https://nika.example',
      token: SERVER_TOKEN,
      fetch: fetch as typeof globalThis.fetch,
      requestTimeout: 1_000,
      machineBufferBytes: 64 * 1024,
      resolveEngine,
      retryDelay: async () => {},
    });
  }

  it('resolves the local engine only for caller-owned source capture', async () => {
    const resolveEngine = vi.fn(() => resolveNikaEngine(FIXTURE));
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ workflows: ['flow.nika.yaml'] }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'accepted',
        snapshot_digest: 'a'.repeat(64),
        root: 'fixture.nika.yaml',
        units: 1,
      }));
    const transport = lazyTransport(fetch, resolveEngine);
    await expect(transport.listWorkflows()).resolves.toEqual(['flow.nika.yaml']);
    expect(resolveEngine).not.toHaveBeenCalled();
    // A local path is caller-owned source: only that capture resolves the engine.
    await expect(transport.check('./flow.nika.yaml', {}))
      .resolves.toMatchObject({ clean: true });
    expect(resolveEngine).toHaveBeenCalledTimes(1);
  });

  it('defers the typed engine-unavailable refusal to capture time', async () => {
    const fetch = vi.fn();
    const transport = lazyTransport(fetch, () => {
      throw new NikaEngineUnavailable('darwin', 'arm64', '@supernovae-st/nika-darwin-arm64');
    });
    await expect(transport.check('./flow.nika.yaml', {}))
      .rejects.toBeInstanceOf(NikaEngineUnavailable);
    await expect(transport.startRun('./flow.nika.yaml', {}))
      .rejects.toBeInstanceOf(NikaEngineUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });
});
