import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamEvents } from '../src/lib/streaming.js';
import { NikaAPIError, NikaConnectionError } from '../src/errors.js';
import { ApiClient } from '../src/lib/api-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function sseResponse(chunks: string[]): Response {
  let index = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeApiClient(fetchFn: typeof fetch): ApiClient {
  return new ApiClient('http://127.0.0.1:8787', 'test-token', 30_000, 2, fetchFn, 24);
}

const queued = 'id: 1\ndata: {"sequence":1,"kind":"queued","status":"queued"}\n\n';
const succeeded = 'id: 2\ndata: {"sequence":2,"kind":"succeeded","status":"succeeded"}\n\n';

describe('streamEvents', () => {
  it('parses allowlisted SSE payloads', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(sseResponse([queued, succeeded]));
    const client = makeApiClient(fetchFn as typeof fetch);
    const events = [];
    for await (const event of streamEvents(client, 'j1')) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].status).toBe('succeeded');
  });

  it('GET /v1/jobs/{id}/events', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(sseResponse([succeeded]));
    const client = makeApiClient(fetchFn as typeof fetch);
    for await (const _ of streamEvents(client, 'j1')) { /* drain */ }
    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:8787/v1/jobs/j1/events');
  });

  it('stops on succeeded and ignores later frames', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(sseResponse([
      queued,
      succeeded,
      'id: 3\ndata: {"sequence":3,"kind":"queued","status":"queued"}\n\n',
    ]));
    const client = makeApiClient(fetchFn as typeof fetch);
    const events = [];
    for await (const event of streamEvents(client, 'j1')) events.push(event);
    expect(events).toHaveLength(2);
  });

  it('stops on failed', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(sseResponse([
      'id: 1\ndata: {"sequence":1,"kind":"failed","status":"failed"}\n\n',
    ]));
    const client = makeApiClient(fetchFn as typeof fetch);
    const events = [];
    for await (const event of streamEvents(client, 'j1')) events.push(event);
    expect(events[0].status).toBe('failed');
  });

  it('skips keep-alive pings', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(sseResponse([queued, ': ping\n\n', succeeded]));
    const client = makeApiClient(fetchFn as typeof fetch);
    const events = [];
    for await (const event of streamEvents(client, 'j1')) events.push(event);
    expect(events).toHaveLength(2);
  });

  it('throws NikaAPIError on non-ok response', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    const client = makeApiClient(fetchFn as typeof fetch);
    await expect(async () => {
      for await (const _ of streamEvents(client, 'bad')) { /* drain */ }
    }).rejects.toThrow(NikaAPIError);
  });

  it('reconnects with Last-Event-ID on stream drop', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sseResponse([
        'id: 1\ndata: {"sequence":1,"kind":"queued","status":"queued"}\n\n',
      ]))
      .mockResolvedValueOnce(sseResponse([
        'id: 2\ndata: {"sequence":2,"kind":"succeeded","status":"succeeded"}\n\n',
      ]));
    const client = makeApiClient(fetchFn as typeof fetch);
    const events = [];
    for await (const event of streamEvents(client, 'j1', {
      maxReconnects: 3,
      reconnectDelay: 10,
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    const headers2 = fetchFn.mock.calls[1][1]?.headers as Record<string, string>;
    expect(headers2['Last-Event-ID']).toBe('1');
  });

  it('gives up after maxReconnects', async () => {
    const fetchFn = vi.fn().mockResolvedValue(sseResponse([queued]));
    const client = makeApiClient(fetchFn as typeof fetch);
    await expect(async () => {
      for await (const _ of streamEvents(client, 'j1', {
        maxReconnects: 2,
        reconnectDelay: 10,
      })) { /* drain */ }
    }).rejects.toThrow(NikaConnectionError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
