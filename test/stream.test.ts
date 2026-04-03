import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamEvents } from '../src/lib/streaming.js';
import { NikaAPIError } from '../src/errors.js';
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
  return new ApiClient(
    'http://localhost:3000',
    'test-token',
    30_000,
    2,
    fetchFn,
  );
}

describe('streamEvents', () => {
  it('parses SSE data lines into NikaEvent objects', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: {"type":"started","job_id":"j1"}\n\n',
        'event: task_start\ndata: {"type":"task_start","job_id":"j1","task_id":"step1","verb":"infer"}\n\n',
        'event: completed\ndata: {"type":"completed","job_id":"j1","output":"done"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('started');
    expect(events[0].job_id).toBe('j1');
    expect(events[1].type).toBe('task_start');
    if (events[1].type === 'task_start') {
      expect(events[1].task_id).toBe('step1');
      expect(events[1].verb).toBe('infer');
    }
    expect(events[2].type).toBe('completed');
    if (events[2].type === 'completed') {
      expect(events[2].output).toBe('done');
    }
  });

  it('stops on terminal event (completed)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: {"type":"started","job_id":"j1"}\n\n',
        'event: completed\ndata: {"type":"completed","job_id":"j1"}\n\n',
        'event: task_start\ndata: {"type":"task_start","job_id":"j1","task_id":"late"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('completed');
  });

  it('stops on terminal event (failed)', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: failed\ndata: {"type":"failed","job_id":"j1","error":"NIKA-010"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('failed');
    if (events[0].type === 'failed') {
      expect(events[0].error).toBe('NIKA-010');
    }
  });

  it('skips keep-alive pings', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: {"type":"started","job_id":"j1"}\n\n',
        ': ping\n\n',
        'event: completed\ndata: {"type":"completed","job_id":"j1"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it('handles chunked data across boundaries', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: {"type":"star',
        'ted","job_id":"j1"}\n\nevent: completed\ndata: {"type":"completed","job_id":"j1"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('started');
    expect(events[1].type).toBe('completed');
  });

  it('throws NikaAPIError on non-ok response', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = streamEvents(client, 'bad');
    await expect(async () => {
      for await (const _ of events) { /* drain */ }
    }).rejects.toThrow(NikaAPIError);
  });

  it('skips malformed JSON gracefully', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: not-json\n\n',
        'event: completed\ndata: {"type":"completed","job_id":"j1"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('completed');
  });

  it('passes auth headers to fetch', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(
      sseResponse([
        'event: completed\ndata: {"type":"completed","job_id":"j1"}\n\n',
      ]),
    );
    const client = makeApiClient(fetchFn as typeof fetch);

    const events = [];
    for await (const event of streamEvents(client, 'j1')) {
      events.push(event);
    }

    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['Accept']).toBe('text/event-stream');
  });
});
