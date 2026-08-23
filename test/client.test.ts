import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Nika } from '../src/index.js';
import {
  NikaError,
  NikaAPIError,
  NikaConnectionError,
  NikaTimeoutError,
  NikaJobError,
  NikaJobCancelledError,
  NikaUnavailableError,
} from '../src/errors.js';
import type { NikaJob } from '../src/types.js';

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 || status === 202 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const BASE = 'http://127.0.0.1:8787';
const TOKEN = 'test-token';

function makeClient(overrides?: Record<string, unknown>) {
  return new Nika({ url: BASE, token: TOKEN, ...overrides });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config', () => {
  it('strips trailing slash from URL', async () => {
    const client = new Nika({ url: 'http://nika:8787/', token: TOKEN });
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      status: 'ok',
      service: 'nika-serve',
      engine_version: '0.114.0',
    }));
    await client.health();
    expect(fetchSpy.mock.calls[0][0]).toBe('http://nika:8787/health');
  });

  it('exposes jobs and workflows namespaces', () => {
    const client = makeClient();
    expect(client.jobs).toBeDefined();
    expect(client.workflows).toBeDefined();
  });
});

describe('health()', () => {
  it('returns identity without auth header', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      status: 'ok',
      service: 'nika-serve',
      engine_version: '0.114.0',
      api_version: 'v1',
    }));

    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.service).toBe('nika-serve');
    expect(health.engine_version).toBe('0.114.0');

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });

  it('throws NikaAPIError on non-ok response', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(client.health()).rejects.toThrow(NikaAPIError);
  });
});

describe('jobs.submit()', () => {
  it('sends POST /v1/jobs with workflow and Idempotency-Key', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'abc123', status: 'queued' }, 202));

    const res = await client.jobs.submit('translate.nika.yaml');
    expect(res.id).toBe('abc123');
    expect(res.status).toBe('queued');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/jobs`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ workflow: 'translate.nika.yaml' });
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('uses a caller idempotency key', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'x', status: 'queued' }, 202));
    await client.jobs.submit('flow.nika.yaml', undefined, { idempotencyKey: 'same-key' });
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('same-key');
  });

  it('refuses inputs — live CreateJob deny_unknown_fields', async () => {
    const client = makeClient();
    await expect(
      client.jobs.submit('flow.nika.yaml', { locale: 'fr-FR' }),
    ).rejects.toThrow(/workflow } only/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('jobs.status()', () => {
  it('GET /v1/jobs/{id}', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'abc', status: 'running' }));
    const result = await client.jobs.status('abc');
    expect(result.id).toBe('abc');
    expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/v1/jobs/abc`);
  });

  it('GET /v1/jobs/{id}/status', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'paused' }));
    const result = await client.jobs.statusOnly('abc');
    expect(result.status).toBe('paused');
    expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/v1/jobs/abc/status`);
  });
});

describe('absent surfaces', () => {
  it('cancel throws without hitting the wire', async () => {
    const client = makeClient();
    await expect(client.jobs.cancel('abc')).rejects.toBeInstanceOf(NikaUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('artifacts throw without hitting the wire', async () => {
    const client = makeClient();
    await expect(client.jobs.artifacts('abc')).rejects.toBeInstanceOf(NikaUnavailableError);
    await expect(client.jobs.artifact('abc', 'x')).rejects.toBeInstanceOf(NikaUnavailableError);
    await expect(client.jobs.runAndCollect('flow.nika.yaml')).rejects.toBeInstanceOf(NikaUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('jobs.run()', () => {
  it('polls queued -> running -> succeeded', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 'j1', status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'j1', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'j1', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'j1', status: 'succeeded' }));

    const result = await client.jobs.run('test.nika.yaml');
    expect(result.status).toBe('succeeded');
    expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/v1/jobs`);
    expect(fetchSpy.mock.calls[1][0]).toBe(`${BASE}/v1/jobs/j1`);
  });

  it('throws NikaJobError on failed', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 'j2', status: 'queued' }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: 'j2', status: 'failed' }));
    await expect(client.jobs.run('bad.nika.yaml')).rejects.toThrow(NikaJobError);
  });

  it('NikaJobError names the NIKA code when the job carries error', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ id: 'j2', status: 'queued' }, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'j2',
          status: 'failed',
          error: { code: 'NIKA-ASSERT-001', message: 'task boom: expected true' },
        }),
      );
    await expect(client.jobs.run('bad.nika.yaml')).rejects.toThrow(
      /NIKA-ASSERT-001 · task boom: expected true/,
    );
  });

  it('throws NikaTimeoutError when polling exceeds timeout', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 50 });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'j4', status: 'queued' }, 202));
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({ id: 'j4', status: 'queued' })));
    await expect(client.jobs.run('slow.nika.yaml')).rejects.toThrow(NikaTimeoutError);
  });
});

describe('retry', () => {
  it('retries on 429 then succeeds', async () => {
    const client = makeClient({ retries: 2 });
    fetchSpy
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'r1', status: 'queued' }, 202));
    const res = await client.jobs.submit('flow.nika.yaml');
    expect(res.id).toBe('r1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx (non-429)', async () => {
    const client = makeClient({ retries: 2 });
    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404, statusText: 'Not Found' }));
    await expect(client.jobs.status('nonexistent')).rejects.toThrow(NikaAPIError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caps Retry-After so a hostile server cannot pin the client', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient({ retries: 1 });
      fetchSpy
        .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '999999' } }))
        .mockResolvedValueOnce(jsonResponse({ id: 'racap', status: 'queued' }, 202));
      const p = client.jobs.submit('flow.nika.yaml');
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toMatchObject({ id: 'racap' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('workflows', () => {
  it('lists contained names', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      workflows: ['translate.nika.yaml', 'seo/audit.nika.yaml'],
    }));
    const list = await client.workflows.list();
    expect(list).toEqual(['translate.nika.yaml', 'seo/audit.nika.yaml']);
  });

  it('metadata encodes the name', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ workflow: 'seo/audit.nika.yaml' }));
    const meta = await client.workflows.metadata('seo/audit.nika.yaml');
    expect(meta.workflow).toBe('seo/audit.nika.yaml');
    expect(fetchSpy.mock.calls[0][0]).toContain('seo%2Faudit.nika.yaml');
  });

  it('reload and source stay off the wire', async () => {
    const client = makeClient();
    await expect(client.workflows.reload()).rejects.toBeInstanceOf(NikaUnavailableError);
    await expect(client.workflows.source('x.nika.yaml')).rejects.toBeInstanceOf(NikaUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('constructor validation', () => {
  it('rejects non-http URL', () => {
    expect(() => new Nika({ url: 'ftp://bad', token: 'tok' })).toThrow(TypeError);
  });
  it('rejects empty token', () => {
    expect(() => new Nika({ url: 'http://127.0.0.1:8787', token: '' })).toThrow(TypeError);
  });
});

describe('error hierarchy', () => {
  it('NikaJobError extends NikaError', () => {
    const job: NikaJob = { id: 'j1', status: 'failed' };
    const err = new NikaJobError(job);
    expect(err).toBeInstanceOf(NikaError);
    expect(err.message).toContain('j1');
  });

  it('catch NikaError catches ALL SDK errors', () => {
    const job: NikaJob = { id: 'x', status: 'failed' };
    const errors = [
      new NikaAPIError('bad', 500, ''),
      new NikaTimeoutError('timeout'),
      new NikaConnectionError('conn'),
      new NikaJobError(job),
      new NikaJobCancelledError(job),
      new NikaUnavailableError('cancel'),
    ];
    for (const err of errors) expect(err).toBeInstanceOf(NikaError);
  });
});

describe('logger', () => {
  it('calls logger.debug on POST /v1/jobs', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new Nika({ url: BASE, token: TOKEN, logger });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'x', status: 'queued' }, 202));
    await client.jobs.submit('flow.nika.yaml');
    const calls = logger.debug.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((m: string) => m.includes('POST /v1/jobs'))).toBe(true);
  });
});

describe('concurrency', () => {
  it('limits concurrent requests via semaphore', async () => {
    const client = makeClient({ concurrency: 2 });
    let inflight = 0;
    let maxInflight = 0;
    fetchSpy.mockImplementation(() => {
      inflight++;
      if (inflight > maxInflight) maxInflight = inflight;
      return new Promise<Response>(resolve => {
        setTimeout(() => {
          inflight--;
          resolve(jsonResponse({ id: 'x', status: 'queued' }, 202));
        }, 20);
      });
    });
    await Promise.all(Array.from({ length: 5 }, () => client.jobs.submit('flow.nika.yaml')));
    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

describe('jobs.stream()', () => {
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

  it('GET /v1/jobs/{id}/events', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(sseResponse([
      'id: 1\ndata: {"sequence":1,"kind":"queued","status":"queued"}\n\n',
      'id: 2\ndata: {"sequence":2,"kind":"succeeded","status":"succeeded"}\n\n',
    ]));
    const events = [];
    for await (const event of client.jobs.stream('s1')) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[1].status).toBe('succeeded');
    expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/v1/jobs/s1/events`);
  });
});
