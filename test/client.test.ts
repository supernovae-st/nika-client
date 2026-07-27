import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Nika } from '../src/index.js';
import {
  NikaError,
  NikaAPIError,
  NikaConnectionError,
  NikaTimeoutError,
  NikaJobError,
  NikaJobCancelledError,
} from '../src/errors.js';
import type { NikaJob } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json', ...headers },
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
    fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'ok', version: '0.62.0', service: 'nika-serve' }));
    await client.health();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('http://nika:3000/health');
  });

  it('uses default config values', () => {
    const client = makeClient();
    expect(client).toBeInstanceOf(Nika);
  });

  it('exposes jobs and workflows namespaces', () => {
    const client = makeClient();
    expect(client.jobs).toBeDefined();
    expect(client.workflows).toBeDefined();
  });
});

// ── Health ──────────────────────────────────────────────────

describe('health()', () => {
  it('returns health without auth header', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ status: 'ok', version: '0.62.0', service: 'nika-serve' }),
    );

    const health = await client.health();

    expect(health.status).toBe('ok');
    expect(health.version).toBe('0.62.0');
    expect(health.service).toBe('nika-serve');

    // health() uses fetchHealth — no Authorization header
    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });

  it('throws NikaAPIError on non-ok response', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(client.health()).rejects.toThrow(NikaAPIError);
  });

  it('NikaAPIError is instanceof NikaError', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(client.health()).rejects.toThrow(NikaError);
  });
});

// ── Submit ──────────────────────────────────────────────────

describe('jobs.submit()', () => {
  it('sends POST /v1/run with correct body', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'abc123', status: 'pending' }),
    );

    const res = await client.jobs.submit('translate.nika.yaml', { locale: 'fr-FR' });

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

    await client.jobs.submit('flow.nika.yaml', {}, { resumeFrom: 'prev-job-id' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.resume_from).toBe('prev-job-id');
  });

  it('includes Authorization header', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'x', status: 'pending' }),
    );

    await client.jobs.submit('flow.nika.yaml');

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('omits inputs when undefined', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'x', status: 'pending' }),
    );

    await client.jobs.submit('flow.nika.yaml');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.inputs).toBeUndefined();
    expect(body.workflow).toBe('flow.nika.yaml');
  });
});

// ── Status ──────────────────────────────────────────────────

describe('jobs.status()', () => {
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

    const result = await client.jobs.status('abc');
    expect(result.job_id).toBe('abc');
    expect(result.status).toBe('running');
    expect(result.workflow).toBe('test.nika.yaml');
  });
});

// ── Cancel ──────────────────────────────────────────────────

describe('jobs.cancel()', () => {
  it('sends POST and returns cancel response', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'abc', status: 'cancelled' }),
    );

    const res = await client.jobs.cancel('abc');
    expect(res.status).toBe('cancelled');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/cancel/abc`);
    expect(init?.method).toBe('POST');
  });
});

// ── Run (polling) ───────────────────────────────────────────

describe('jobs.run()', () => {
  it('polls pending -> running -> completed', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });
    const job = (status: string): NikaJob => ({
      job_id: 'j1',
      status: status as NikaJob['status'],
      workflow: 'test.nika.yaml',
      created_at: '2026-04-02T10:00:00Z',
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'j1', status: 'pending' }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse(job('pending')));
    fetchSpy.mockResolvedValueOnce(jsonResponse(job('running')));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ...job('completed'), completed_at: '2026-04-02T10:01:00Z', exit_code: 0 }),
    );

    const result = await client.jobs.run('test.nika.yaml');
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

    await expect(client.jobs.run('bad.nika.yaml')).rejects.toThrow(NikaJobError);
  });

  it('throws NikaJobCancelledError on cancelled', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'j3', status: 'pending' }),
    );
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'j3',
        status: 'cancelled',
        workflow: 'cancel.nika.yaml',
        created_at: '2026-04-02T10:00:00Z',
      }),
    );

    const err = await client.jobs.run('cancel.nika.yaml').catch(e => e);
    expect(err).toBeInstanceOf(NikaJobCancelledError);
    expect(err).toBeInstanceOf(NikaJobError);
    expect(err).toBeInstanceOf(NikaError);
  });

  it('throws NikaTimeoutError when polling exceeds timeout', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 50 });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'j4', status: 'pending' }),
    );
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({
        job_id: 'j4',
        status: 'pending',
        workflow: 'slow.nika.yaml',
        created_at: '2026-04-02T10:00:00Z',
      })),
    );

    await expect(client.jobs.run('slow.nika.yaml')).rejects.toThrow(NikaTimeoutError);
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

    const res = await client.jobs.submit('flow.nika.yaml');
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

    const res = await client.jobs.submit('flow.nika.yaml');
    expect(res.job_id).toBe('r2');
  });

  it('throws after max retries exhausted', async () => {
    const client = makeClient({ retries: 1 });

    fetchSpy
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(new Response('err', { status: 500 }));

    await expect(client.jobs.submit('flow.nika.yaml')).rejects.toThrow(NikaAPIError);
  });

  it('does not retry on 4xx (non-429)', async () => {
    const client = makeClient({ retries: 2 });

    fetchSpy.mockResolvedValueOnce(new Response('not found', { status: 404, statusText: 'Not Found' }));

    await expect(client.jobs.status('nonexistent')).rejects.toThrow(NikaAPIError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('respects Retry-After header on 429', async () => {
    const client = makeClient({ retries: 1 });

    const res429 = new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
    fetchSpy
      .mockResolvedValueOnce(res429)
      .mockResolvedValueOnce(jsonResponse({ job_id: 'ra1', status: 'pending' }));

    const start = Date.now();
    await client.jobs.submit('flow.nika.yaml');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('caps Retry-After so a hostile server cannot pin the client', async () => {
    // Retry-After is advisory: a huge value must be clamped to the 30s
    // ceiling, not honored literally. Fake timers prove the clamp without a
    // real wait — advancing 30s resolves the retry; an uncapped ~999999s
    // delay would leave the promise pending here.
    vi.useFakeTimers();
    try {
      const client = makeClient({ retries: 1 });
      fetchSpy
        .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '999999' } }))
        .mockResolvedValueOnce(jsonResponse({ job_id: 'racap', status: 'pending' }));

      const p = client.jobs.submit('flow.nika.yaml');
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toMatchObject({ job_id: 'racap' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Artifacts ───────────────────────────────────────────────

describe('jobs.artifacts()', () => {
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

    const arts = await client.jobs.artifacts('a1');
    expect(arts).toHaveLength(2);
    expect(arts[0].name).toBe('report.md');
    expect(arts[1].checksum).toBe('abc123');
  });
});

describe('jobs.artifact()', () => {
  it('returns artifact content as text', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(textResponse('# My Report\n\nContent here.'));

    const text = await client.jobs.artifact('a1', 'report.md');
    expect(text).toContain('# My Report');
  });
});

describe('jobs.artifactJson()', () => {
  it('returns parsed JSON artifact', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ translations: { hello: 'bonjour' } }),
    );

    const data = await client.jobs.artifactJson<{ translations: Record<string, string> }>('a1', 'data.json');
    expect(data.translations.hello).toBe('bonjour');
  });

  it('encodes artifact name in URL', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({}));

    await client.jobs.artifactJson('a1', 'fr-FR/ui.json');

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('fr-FR%2Fui.json');
  });
});

describe('jobs.artifactBinary()', () => {
  it('returns Uint8Array for binary artifacts', async () => {
    const client = makeClient();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG header
    fetchSpy.mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    const result = await client.jobs.artifactBinary('a1', 'photo.jpg');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(0xff);
    expect(result.length).toBe(4);
  });
});

// ── artifactStream ─────────────────────────────────────────

describe('jobs.artifactStream()', () => {
  it('returns a ReadableStream', async () => {
    const client = makeClient();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index]);
          index++;
        } else {
          controller.close();
        }
      },
    });
    fetchSpy.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const result = await client.jobs.artifactStream('a1', 'big.csv');
    expect(result).toBeInstanceOf(ReadableStream);

    // Read all chunks and verify content
    const reader = result.getReader();
    const collected: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(...value);
    }
    expect(collected).toEqual([1, 2, 3, 4]);
  });

  it('throws NikaError when body is null', async () => {
    const client = makeClient();
    // Response with null body
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(client.jobs.artifactStream('a1', 'file.bin')).rejects.toThrow('Artifact response has no body');
  });
});

// ── runAndCollect ───────────────────────────────────────────

describe('jobs.runAndCollect()', () => {
  it('runs workflow and collects all non-binary artifacts in parallel', async () => {
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
    // download report.md + data.json (parallel — order may vary)
    fetchSpy.mockResolvedValueOnce(textResponse('# Report'));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ result: 42 }));

    const result = await client.jobs.runAndCollect('full.nika.yaml');

    expect(result['data.json']).toEqual({ result: 42 });
    expect(result['report.md']).toBe('# Report');
    expect(result['audio.mp3']).toBeUndefined();
  });

  it('batches artifact downloads (max 6 per batch)', async () => {
    const client = makeClient({ pollInterval: 10, pollTimeout: 5000 });

    // submit
    fetchSpy.mockResolvedValueOnce(jsonResponse({ job_id: 'b1', status: 'pending' }));
    // poll: completed
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'b1',
        status: 'completed',
        workflow: 'big.nika.yaml',
        created_at: '2026-04-02T10:00:00Z',
        completed_at: '2026-04-02T10:01:00Z',
      }),
    );
    // artifacts list — 8 text artifacts
    const arts = Array.from({ length: 8 }, (_, i) => ({
      name: `file-${i}.txt`,
      size: 100,
      format: 'text',
      content_type: 'text/plain',
    }));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ job_id: 'b1', count: arts.length, artifacts: arts }),
    );
    // 8 download responses
    for (let i = 0; i < 8; i++) {
      fetchSpy.mockResolvedValueOnce(textResponse(`content-${i}`));
    }

    const result = await client.jobs.runAndCollect('big.nika.yaml');

    expect(Object.keys(result)).toHaveLength(8);
    expect(result['file-0.txt']).toBe('content-0');
    expect(result['file-7.txt']).toBe('content-7');
    // 1 submit + 1 poll + 1 artifacts + 8 downloads = 11
    expect(fetchSpy).toHaveBeenCalledTimes(11);
  });
});

// ── Workflows ───────────────────────────────────────────────

describe('workflows.list()', () => {
  it('returns workflow list (single page, no has_more)', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        workflows: [
          { name: 'translate.nika.yaml', size: 512 },
          { name: 'seo/audit.nika.yaml', size: 1024 },
        ],
        count: 2,
      }),
    );

    const list = await client.workflows.list();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('translate.nika.yaml');
    expect(list[1].size).toBe(1024);
  });

  it('auto-paginates across multiple pages', async () => {
    const client = makeClient();
    // Page 1: has_more=true
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        workflows: [
          { name: 'a.nika.yaml', size: 100 },
          { name: 'b.nika.yaml', size: 200 },
        ],
        count: 2,
        has_more: true,
      }),
    );
    // Page 2: has_more=false (last page)
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        workflows: [
          { name: 'c.nika.yaml', size: 300 },
        ],
        count: 1,
        has_more: false,
      }),
    );

    const list = await client.workflows.list();
    expect(list).toHaveLength(3);
    expect(list.map(w => w.name)).toEqual(['a.nika.yaml', 'b.nika.yaml', 'c.nika.yaml']);

    // Second call should have after=b.nika.yaml
    const url2 = fetchSpy.mock.calls[1][0] as string;
    expect(url2).toContain('after=b.nika.yaml');
    expect(url2).toContain('limit=200');
  });
});

describe('workflows.listPage()', () => {
  it('returns a single page with has_more', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        workflows: [{ name: 'a.nika.yaml', size: 100 }],
        count: 1,
        has_more: true,
      }),
    );

    const page = await client.workflows.listPage({ limit: 1 });
    expect(page.workflows).toHaveLength(1);
    expect(page.has_more).toBe(true);

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('limit=1');
  });

  it('passes after cursor', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ workflows: [], count: 0, has_more: false }),
    );

    await client.workflows.listPage({ limit: 10, after: 'z.nika.yaml' });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('after=z.nika.yaml');
  });

  it('works without options', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ workflows: [{ name: 'x.nika.yaml', size: 50 }], count: 1 }),
    );

    const page = await client.workflows.listPage();
    expect(page.count).toBe(1);

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe(`${BASE}/v1/workflows`);
  });
});

describe('workflows.reload()', () => {
  it('sends POST and returns refreshed list', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        workflows: [{ name: 'new.nika.yaml', size: 256 }],
        count: 1,
      }),
    );

    const list = await client.workflows.reload();
    expect(list).toHaveLength(1);

    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe('POST');
  });
});

// ── Workflow Source ─────────────────────────────────────────

describe('workflows.source()', () => {
  it('returns raw YAML as text', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(textResponse('nika: v1\nworkflow: test'));
    const yaml = await client.workflows.source('test.nika.yaml');
    expect(yaml).toContain('nika: v1');
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('/v1/workflows/test.nika.yaml/source');
  });

  it('encodes workflow name with slashes', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(textResponse('nika: v1'));
    await client.workflows.source('sub/dir/flow.nika.yaml');
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('sub%2Fdir%2Fflow.nika.yaml');
  });
});

// ── Constructor validation ──────────────────────────────────

describe('constructor validation', () => {
  it('rejects non-http URL', () => {
    expect(() => new Nika({ url: 'ftp://bad', token: 'tok' })).toThrow(TypeError);
  });

  it('rejects empty URL', () => {
    expect(() => new Nika({ url: '', token: 'tok' })).toThrow(TypeError);
  });

  it('rejects empty token', () => {
    expect(() => new Nika({ url: 'http://localhost:3000', token: '' })).toThrow(TypeError);
  });

  it('accepts http URL', () => {
    expect(new Nika({ url: 'http://localhost:3000', token: 'tok' })).toBeInstanceOf(Nika);
  });

  it('accepts https URL', () => {
    expect(new Nika({ url: 'https://nika.example.com', token: 'tok' })).toBeInstanceOf(Nika);
  });
});

// ── Error hierarchy ─────────────────────────────────────────

describe('error hierarchy', () => {
  it('NikaJobError extends NikaError', () => {
    const job: NikaJob = {
      job_id: 'j1',
      status: 'failed',
      workflow: 'bad.nika.yaml',
      created_at: '2026-04-02T10:00:00Z',
      exit_code: -1,
      output: 'segfault',
    };
    const err = new NikaJobError(job);
    expect(err).toBeInstanceOf(NikaJobError);
    expect(err).toBeInstanceOf(NikaError);
    expect(err.exitCode).toBe(-1);
    expect(err.job).toBe(job);
    expect(err.message).toContain('segfault');
  });

  it('NikaJobCancelledError extends NikaJobError extends NikaError', () => {
    const job: NikaJob = {
      job_id: 'j2',
      status: 'cancelled',
      workflow: 'cancel.nika.yaml',
      created_at: '2026-04-02T10:00:00Z',
    };
    const err = new NikaJobCancelledError(job);
    expect(err).toBeInstanceOf(NikaJobCancelledError);
    expect(err).toBeInstanceOf(NikaJobError);
    expect(err).toBeInstanceOf(NikaError);
    expect(err.name).toBe('NikaJobCancelledError');
  });

  it('NikaAPIError extends NikaError', () => {
    const err = new NikaAPIError('404 Not Found', 404, '{"error":"Not found"}', 'req-123');
    expect(err).toBeInstanceOf(NikaAPIError);
    expect(err).toBeInstanceOf(NikaError);
    expect(err.status).toBe(404);
    expect(err.body).toBe('{"error":"Not found"}');
    expect(err.requestId).toBe('req-123');
  });

  it('NikaTimeoutError extends NikaError', () => {
    const err = new NikaTimeoutError('timed out');
    expect(err).toBeInstanceOf(NikaTimeoutError);
    expect(err).toBeInstanceOf(NikaError);
  });

  it('NikaConnectionError extends NikaError', () => {
    const err = new NikaConnectionError('DNS failed');
    expect(err).toBeInstanceOf(NikaConnectionError);
    expect(err).toBeInstanceOf(NikaError);
  });

  it('catch NikaError catches ALL SDK errors', () => {
    const errors = [
      new NikaAPIError('bad', 500, ''),
      new NikaTimeoutError('timeout'),
      new NikaConnectionError('conn'),
      new NikaJobError({ job_id: 'x', status: 'failed', workflow: 'x', created_at: 'x' }),
      new NikaJobCancelledError({ job_id: 'x', status: 'cancelled', workflow: 'x', created_at: 'x' }),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(NikaError);
    }
  });
});

// ── Custom fetch ────────────────────────────────────────────

describe('custom fetch', () => {
  it('uses injected fetch function', async () => {
    const customFetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'ok', version: '0.62.0', service: 'nika-serve' }),
    );
    const client = new Nika({
      url: BASE,
      token: TOKEN,
      fetch: customFetch as unknown as typeof fetch,
    });

    await client.health();
    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Logger ──────────────────────────────────────────────────

describe('logger', () => {
  it('calls logger.debug on request/response', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new Nika({ url: BASE, token: TOKEN, logger });

    fetchSpy.mockResolvedValueOnce(jsonResponse({ job_id: 'x', status: 'pending' }));
    await client.jobs.submit('flow.nika.yaml');

    expect(logger.debug).toHaveBeenCalled();
    const calls = logger.debug.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((m: string) => m.includes('POST /v1/run'))).toBe(true);
  });
});

// ── Concurrency ────────────────────────────────────────────

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
          resolve(jsonResponse({ job_id: 'x', status: 'pending' }));
        }, 20);
      });
    });

    // Fire 5 requests in parallel
    await Promise.all(
      Array.from({ length: 5 }, () =>
        client.jobs.submit('flow.nika.yaml'),
      ),
    );

    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

// ── stream() integration ────────────────────────────────────

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

  it('passes auth header and streams events', async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: {"type":"started","job_id":"s1"}\n\n',
        'event: completed\ndata: {"type":"completed","job_id":"s1","output":null}\n\n',
      ]),
    );

    const events = [];
    for await (const event of client.jobs.stream('s1')) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('started');

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('passes AbortSignal to fetch', async () => {
    const client = makeClient();
    const controller = new AbortController();

    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'event: started\ndata: {"type":"started","job_id":"s2"}\n\n',
        'event: completed\ndata: {"type":"completed","job_id":"s2","output":null}\n\n',
      ]),
    );

    const events = [];
    for await (const event of client.jobs.stream('s2', { signal: controller.signal })) {
      events.push(event);
    }

    const init = fetchSpy.mock.calls[0][1];
    expect(init?.signal).toBe(controller.signal);
  });
});
