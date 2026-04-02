import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Nika } from '../src/client.js';
import { NikaError, NikaJobError, NikaTimeoutError } from '../src/errors.js';
import type { NikaJob } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, statusText: 'OK' });
}

const BASE = 'http://localhost:3000';
const TOKEN = 'test-token';

function makeClient(overrides?: Record<string, unknown>) {
  return new Nika({ url: BASE, token: TOKEN, ...overrides });
}

// ── Setup ───────────────────────────────────────────────────

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Config ──────────────────────────────────────────────────

describe('config', () => {
  it('strips trailing slash from URL', async () => {
    const client = new Nika({ url: 'http://nika:3000/', token: TOKEN });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'ok', version: '0.60.0', service: 'nika-serve' }));
    await client.health();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('http://nika:3000/health');
  });

  it('uses default config values', () => {
    const client = makeClient();
    // Verify defaults by testing that the client was created without error
    expect(client).toBeInstanceOf(Nika);
  });
});

// ── Health ──────────────────────────────────────────────────

describe('health()', () => {
  it('returns health without auth header', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ status: 'ok', version: '0.60.0', service: 'nika-serve' }),
    );

    const health = await client.health();

    expect(health.status).toBe('ok');
    expect(health.version).toBe('0.60.0');
    expect(health.service).toBe('nika-serve');

    // health() uses globalThis.fetch directly — no Authorization header
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.headers).toBeUndefined();
  });

  it('throws on non-ok response', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(client.health()).rejects.toThrow(NikaError);
  });
});

// ── Submit ──────────────────────────────────────────────────

describe('submit()', () => {
  it('sends POST /v1/run with correct body', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'abc123', status: 'pending' }),
    );

    const res = await client.submit('translate.nika.yaml', { locale: 'fr-FR' });

    expect(res.job_id).toBe('abc123');
    expect(res.status).toBe('pending');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/run`);
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init?.body as string);
    expect(body.workflow).toBe('translate.nika.yaml');
    expect(body.inputs).toEqual({ locale: 'fr-FR' });
  });

  it('sends resume_from when provided', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'def456', status: 'pending' }),
    );

    await client.submit('flow.nika.yaml', {}, 'prev-job-id');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.resume_from).toBe('prev-job-id');
  });

  it('includes Authorization header', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'x', status: 'pending' }),
    );

    await client.submit('flow.nika.yaml');

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});

// ── Status ──────────────────────────────────────────────────

describe('status()', () => {
  it('returns job status', async () => {
    const client = makeClient();
    const job: NikaJob = {
      job_id: 'abc',
      status: 'running',
      workflow: 'test.nika.yaml',
      created_at: '2026-04-02T10:00:00Z',
      started_at: '2026-04-02T10:00:01Z',
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(job));

    const result = await client.status('abc');
    expect(result.job_id).toBe('abc');
    expect(result.status).toBe('running');
    expect(result.workflow).toBe('test.nika.yaml');
  });
});

// ── Cancel ──────────────────────────────────────────────────

describe('cancel()', () => {
  it('sends POST and returns cancel response', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'abc', status: 'cancelled' }),
    );

    const res = await client.cancel('abc');
    expect(res.status).toBe('cancelled');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/cancel/abc`);
    expect(init?.method).toBe('POST');
  });
});

// ── Run (polling) ───────────────────────────────────────────

describe('run()', () => {
  it('polls pending -> running -> completed', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });
    const job = (status: string): NikaJob => ({
      job_id: 'j1',
      status: status as NikaJob['status'],
      workflow: 'test.nika.yaml',
      created_at: '2026-04-02T10:00:00Z',
    });

    // submit
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'j1', status: 'pending' }),
    );
    // poll 1: pending
    fetchSpy.mockResolvedValueOnce(jsonResponse(job('pending')));
    // poll 2: running
    fetchSpy.mockResolvedValueOnce(jsonResponse(job('running')));
    // poll 3: completed
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...job('completed'), completed_at: '2026-04-02T10:01:00Z', exit_code: 0 }),
    );

    const result = await client.run('test.nika.yaml');
    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
  });

  it('throws NikaJobError on failure', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'j2', status: 'pending' }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'j2',
        status: 'failed',
        workflow: 'bad.nika.yaml',
        created_at: '2026-04-02T10:00:00Z',
        output: 'NIKA-010: schema validation',
        exit_code: 1,
      }),
    );

    await expect(client.run('bad.nika.yaml')).rejects.toThrow(NikaJobError);
  });

  it('throws NikaTimeoutError when polling exceeds timeout', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 50 });

    // submit
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'j3', status: 'pending' }),
    );
    // Always return pending — fresh Response each call
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        job_id: 'j3',
        status: 'pending',
        workflow: 'slow.nika.yaml',
        created_at: '2026-04-02T10:00:00Z',
      })),
    );

    await expect(client.run('slow.nika.yaml')).rejects.toThrow(NikaTimeoutError);
  });
});

// ── Retry ───────────────────────────────────────────────────

describe('retry', () => {
  it('retries on 429 then succeeds', async () => {
    const client = makeClient({ retries: 2 });

    fetchSpy
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        jsonResponse({ job_id: 'r1', status: 'pending' }),
      );

    const res = await client.submit('flow.nika.yaml');
    expect(res.job_id).toBe('r1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 then succeeds', async () => {
    const client = makeClient({ retries: 2 });

    fetchSpy
      .mockResolvedValueOnce(new Response('internal error', { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({ job_id: 'r2', status: 'pending' }),
      );

    const res = await client.submit('flow.nika.yaml');
    expect(res.job_id).toBe('r2');
  });

  it('throws after max retries exhausted', async () => {
    const client = makeClient({ retries: 1 });

    fetchSpy
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('err', { status: 500 }));

    await expect(client.submit('flow.nika.yaml')).rejects.toThrow(NikaError);
  });

  it('does not retry on 4xx (non-429)', async () => {
    const client = makeClient({ retries: 2 });

    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404, statusText: 'Not Found' }));

    await expect(client.status('nonexistent')).rejects.toThrow(NikaError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Artifacts ───────────────────────────────────────────────

describe('artifacts()', () => {
  it('returns artifact list from wrapped response', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'a1',
        count: 2,
        artifacts: [
          { name: 'report.md', size: 1024, format: 'markdown', content_type: 'text/markdown' },
          { name: 'data.json', size: 256, format: 'json', content_type: 'application/json', checksum: 'abc123' },
        ],
      }),
    );

    const arts = await client.artifacts('a1');
    expect(arts).toHaveLength(2);
    expect(arts[0].name).toBe('report.md');
    expect(arts[1].checksum).toBe('abc123');
  });
});

describe('artifact()', () => {
  it('returns artifact content as text', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(textResponse('# My Report\n\nContent here.'));

    const text = await client.artifact('a1', 'report.md');
    expect(text).toContain('# My Report');
  });
});

describe('artifactJson()', () => {
  it('returns parsed JSON artifact', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ translations: { hello: 'bonjour' } }),
    );

    const data = await client.artifactJson<{ translations: Record<string, string> }>('a1', 'data.json');
    expect(data.translations.hello).toBe('bonjour');
  });

  it('encodes artifact name in URL', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));

    await client.artifactJson('a1', 'fr-FR/ui.json');

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('fr-FR%2Fui.json');
  });
});

// ── runAndCollect ───────────────────────────────────────────

describe('runAndCollect()', () => {
  it('runs workflow and collects all non-binary artifacts', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });

    // submit
    fetchSpy.mockResolvedValueOnce(jsonResponse({ job_id: 'c1', status: 'pending' }));
    // poll: completed immediately
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'c1',
        status: 'completed',
        workflow: 'full.nika.yaml',
        created_at: '2026-04-02T10:00:00Z',
        completed_at: '2026-04-02T10:01:00Z',
      }),
    );
    // artifacts list
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'c1',
        count: 3,
        artifacts: [
          { name: 'report.md', size: 100, format: 'markdown', content_type: 'text/markdown' },
          { name: 'data.json', size: 50, format: 'json', content_type: 'application/json' },
          { name: 'audio.mp3', size: 5000, format: 'binary', content_type: 'audio/mpeg' },
        ],
      }),
    );
    // download report.md (text — non-json)
    fetchSpy.mockResolvedValueOnce(textResponse('# Report'));
    // download data.json (json)
    fetchSpy.mockResolvedValueOnce(jsonResponse({ result: 42 }));
    // audio.mp3 is binary — should be skipped

    const result = await client.runAndCollect('full.nika.yaml');

    expect(result['data.json']).toEqual({ result: 42 });
    expect(result['report.md']).toBe('# Report');
    expect(result['audio.mp3']).toBeUndefined();
  });
});
