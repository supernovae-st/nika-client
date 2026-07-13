/**
 * E2E integration test for @supernovae-st/nika-client v2.
 *
 * Spins up a minimal HTTP server mimicking nika serve API,
 * then exercises the real Nika client against it over the network.
 *
 * No mocks -- real HTTP, real SSE, real client code.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Nika } from '../src/index.js';
import { NikaError, NikaAPIError, NikaJobError, NikaJobCancelledError } from '../src/errors.js';

// ── Mock Server State ────────────────────────────────────────

interface MockState {
  authHeaders: Map<string, string | undefined>;
  statusCalls: Map<string, number>;
  runCallCount: number;
}

function freshState(): MockState {
  return {
    authHeaders: new Map(),
    statusCalls: new Map(),
    runCallCount: 0,
  };
}

// ── Mock Server ──────────────────────────────────────────────

const VALID_TOKEN = 'nika-e2e-test-token-2026';

function createMockServer(state: MockState) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    state.authHeaders.set(`${method} ${path}`, req.headers.authorization);

    // ── Health (no auth) ──────────────────────────────────
    if (path === '/health' && method === 'GET') {
      json(res, { status: 'ok', version: '0.62.0', service: 'nika-serve' });
      return;
    }

    // ── Auth gate ─────────────────────────────────────────
    if (path !== '/health') {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${VALID_TOKEN}`) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }
    }

    // ── GET /v1/workflows ─────────────────────────────────
    if (path === '/v1/workflows' && method === 'GET') {
      json(res, {
        workflows: [
          { name: 'translate.nika.yaml', size: 512 },
          { name: 'seo/audit.nika.yaml', size: 1024 },
        ],
        count: 2,
      });
      return;
    }

    // ── POST /v1/reload ───────────────────────────────────
    if (path === '/v1/reload' && method === 'POST') {
      json(res, {
        workflows: [
          { name: 'translate.nika.yaml', size: 512 },
          { name: 'seo/audit.nika.yaml', size: 1024 },
          { name: 'new.nika.yaml', size: 256 },
        ],
        count: 3,
      });
      return;
    }

    // ── GET /v1/workflows/{name}/source ─────────────────
    const sourceMatch = path.match(/^\/v1\/workflows\/(.+)\/source$/);
    if (sourceMatch && method === 'GET') {
      const name = decodeURIComponent(sourceMatch[1]);
      if (name === 'translate.nika.yaml') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('schema: "nika/workflow@0.12"\nworkflow:\n  id: translate\n  description: "Translate files"');
        return;
      }
      json(res, { error: `Workflow not found: ${name}` }, 404);
      return;
    }

    // ── POST /v1/run ──────────────────────────────────────
    if (path === '/v1/run' && method === 'POST') {
      collectBody(req).then((body) => {
        const parsed = JSON.parse(body);
        const workflow: string = parsed.workflow;

        if (workflow === 'retry-429.nika.yaml') {
          state.runCallCount++;
          if (state.runCallCount === 1) {
            res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '0' });
            res.end('rate limited');
            return;
          }
          json(res, { job_id: 'job-retry-429', status: 'pending' });
          return;
        }

        if (workflow === 'fail.nika.yaml') {
          json(res, { job_id: 'job-fail', status: 'pending' });
          return;
        }

        if (workflow === 'cancel-me.nika.yaml') {
          json(res, { job_id: 'job-cancel', status: 'pending' });
          return;
        }

        if (workflow === 'stream.nika.yaml') {
          json(res, { job_id: 'job-stream', status: 'pending' });
          return;
        }

        if (workflow === 'collect.nika.yaml') {
          json(res, { job_id: 'job-collect', status: 'pending' });
          return;
        }

        json(res, { job_id: 'job-lifecycle', status: 'pending' });
      });
      return;
    }

    // ── GET /v1/status/{id} ───────────────────────────────
    const statusMatch = path.match(/^\/v1\/status\/(.+)$/);
    if (statusMatch && method === 'GET') {
      const jobId = statusMatch[1];
      const calls = (state.statusCalls.get(jobId) ?? 0) + 1;
      state.statusCalls.set(jobId, calls);

      if (jobId === 'job-lifecycle') {
        if (calls === 1) {
          json(res, makeJob(jobId, 'pending', 'lifecycle.nika.yaml'));
        } else if (calls === 2) {
          json(res, makeJob(jobId, 'running', 'lifecycle.nika.yaml', {
            started_at: '2026-04-02T10:00:01Z',
          }));
        } else {
          json(res, makeJob(jobId, 'completed', 'lifecycle.nika.yaml', {
            started_at: '2026-04-02T10:00:01Z',
            completed_at: '2026-04-02T10:01:00Z',
            exit_code: 0,
            output: 'All 3 tasks completed',
          }));
        }
        return;
      }

      if (jobId === 'job-fail') {
        if (calls === 1) {
          json(res, makeJob(jobId, 'running', 'fail.nika.yaml', {
            started_at: '2026-04-02T10:00:01Z',
          }));
        } else {
          json(res, makeJob(jobId, 'failed', 'fail.nika.yaml', {
            started_at: '2026-04-02T10:00:01Z',
            completed_at: '2026-04-02T10:00:05Z',
            exit_code: 1,
            output: 'NIKA-010: schema validation error in task "parse"',
          }));
        }
        return;
      }

      if (jobId === 'job-cancel') {
        json(res, makeJob(jobId, 'cancelled', 'cancel-me.nika.yaml', {
          started_at: '2026-04-02T10:00:01Z',
        }));
        return;
      }

      if (jobId === 'job-collect') {
        if (calls === 1) {
          json(res, makeJob(jobId, 'running', 'collect.nika.yaml', {
            started_at: '2026-04-02T10:00:01Z',
          }));
        } else {
          json(res, makeJob(jobId, 'completed', 'collect.nika.yaml', {
            started_at: '2026-04-02T10:00:01Z',
            completed_at: '2026-04-02T10:01:00Z',
            exit_code: 0,
          }));
        }
        return;
      }

      json(res, { error: 'Job not found' }, 404);
      return;
    }

    // ── POST /v1/cancel/{id} ──────────────────────────────
    const cancelMatch = path.match(/^\/v1\/cancel\/(.+)$/);
    if (cancelMatch && method === 'POST') {
      const jobId = cancelMatch[1];
      json(res, { job_id: jobId, status: 'cancelled', message: 'Job cancelled by user' });
      return;
    }

    // ── GET /v1/events/{id} (SSE) ─────────────────────────
    const eventsMatch = path.match(/^\/v1\/events\/(.+)$/);
    if (eventsMatch && method === 'GET') {
      const jobId = eventsMatch[1];

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const events = [
        { type: 'started', job_id: jobId },
        { type: 'task_start', job_id: jobId, task_id: 'research', verb: 'infer' },
        { type: 'task_complete', job_id: jobId, task_id: 'research', duration_ms: 1200 },
        { type: 'task_start', job_id: jobId, task_id: 'summarize', verb: 'infer' },
        { type: 'task_complete', job_id: jobId, task_id: 'summarize', duration_ms: 800 },
        { type: 'completed', job_id: jobId, output: 'All tasks done' },
      ];

      let idx = 0;
      const timer = setInterval(() => {
        if (idx >= events.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        const event = events[idx];
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        idx++;
      }, 10);

      req.on('close', () => clearInterval(timer));
      return;
    }

    // ── GET /v1/jobs/{id}/artifacts ───────────────────────
    const artifactsListMatch = path.match(/^\/v1\/jobs\/(.+)\/artifacts$/);
    if (artifactsListMatch && method === 'GET') {
      const jobId = artifactsListMatch[1];
      json(res, {
        job_id: jobId,
        count: 3,
        artifacts: [
          { name: 'report.md', size: 512, format: 'markdown', content_type: 'text/markdown' },
          { name: 'data.json', size: 128, format: 'json', content_type: 'application/json', checksum: 'blake3-abc123' },
          { name: 'audio.mp3', size: 48000, format: 'binary', content_type: 'audio/mpeg' },
        ],
      });
      return;
    }

    // ── GET /v1/jobs/{id}/artifacts/{name} ────────────────
    const artifactMatch = path.match(/^\/v1\/jobs\/(.+?)\/artifacts\/(.+)$/);
    if (artifactMatch && method === 'GET') {
      const name = decodeURIComponent(artifactMatch[2]);

      if (name === 'report.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        res.end('# Research Report\n\nFindings about AI workflow engines.\n');
        return;
      }

      if (name === 'data.json') {
        json(res, { topics: ['nika', 'langchain', 'dspy'], score: 0.95 });
        return;
      }

      if (name === 'audio.mp3') {
        const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // MP3 header
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(bytes.length),
        });
        res.end(bytes);
        return;
      }

      json(res, { error: 'Artifact not found' }, 404);
      return;
    }

    json(res, { error: `Not found: ${method} ${path}` }, 404);
  });
}

// ── Helpers ──────────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function makeJob(
  jobId: string,
  status: string,
  workflow: string,
  extra?: Record<string, unknown>,
) {
  return {
    job_id: jobId,
    status,
    workflow,
    created_at: '2026-04-02T10:00:00Z',
    ...extra,
  };
}

// ── Test Setup ───────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let state: MockState;

beforeAll(async () => {
  state = freshState();
  server = createMockServer(state);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

// Reset shared state between tests to prevent order-dependence
beforeEach(() => {
  state.authHeaders.clear();
  state.statusCalls.clear();
  state.runCallCount = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function makeClient(overrides?: Record<string, unknown>) {
  return new Nika({
    url: baseUrl,
    token: VALID_TOKEN,
    pollInterval: 20,
    pollTimeout: 10_000,
    pollBackoff: 1.0,
    retries: 2,
    timeout: 5_000,
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────

describe('E2E: nika-client v2 against mock server', () => {

  // ── 1. Full Lifecycle ────────────────────────────────────

  describe('1. Full lifecycle: submit -> poll -> artifacts -> download', () => {
    it('transitions through pending -> running -> completed', async () => {
      const client = makeClient();

      const run = await client.jobs.submit('lifecycle.nika.yaml', { topic: 'AI' });
      expect(run.job_id).toBe('job-lifecycle');
      expect(run.status).toBe('pending');

      const job = await client.jobs.run('lifecycle.nika.yaml', { topic: 'AI' });
      expect(job.status).toBe('completed');
      expect(job.exit_code).toBe(0);
      expect(job.output).toBe('All 3 tasks completed');

      const artifacts = await client.jobs.artifacts(job.job_id);
      expect(artifacts).toHaveLength(3);
      expect(artifacts[0].name).toBe('report.md');
      expect(artifacts[1].checksum).toBe('blake3-abc123');

      const markdown = await client.jobs.artifact(job.job_id, 'report.md');
      expect(markdown).toContain('# Research Report');

      const data = await client.jobs.artifactJson<{ topics: string[]; score: number }>(
        job.job_id,
        'data.json',
      );
      expect(data.topics).toEqual(['nika', 'langchain', 'dspy']);
      expect(data.score).toBe(0.95);
    });
  });

  // ── 2. SSE Streaming ────────────────────────────────────

  describe('2. SSE streaming', () => {
    it('streams all events in order', async () => {
      const client = makeClient();

      const run = await client.jobs.submit('stream.nika.yaml');
      expect(run.job_id).toBe('job-stream');

      const events = [];
      for await (const event of client.jobs.stream(run.job_id)) {
        events.push(event);
      }

      expect(events).toHaveLength(6);
      expect(events[0].type).toBe('started');
      expect(events[1].type).toBe('task_start');
      if (events[1].type === 'task_start') expect(events[1].verb).toBe('infer');
      expect(events[2].type).toBe('task_complete');
      if (events[2].type === 'task_complete') expect(events[2].duration_ms).toBe(1200);
      expect(events[5].type).toBe('completed');
    });
  });

  // ── 3. Error Handling ───────────────────────────────────

  describe('3. Error handling', () => {
    it('throws NikaJobError on failed workflow', async () => {
      const client = makeClient();

      try {
        await client.jobs.run('fail.nika.yaml');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NikaJobError);
        expect(err).toBeInstanceOf(NikaError);
        const jobErr = err as NikaJobError;
        expect(jobErr.job.status).toBe('failed');
        expect(jobErr.job.output).toContain('NIKA-010');
        expect(jobErr.job.exit_code).toBe(1);
      }
    });

    it('throws NikaJobCancelledError on cancelled workflow', async () => {
      const client = makeClient();

      const run = await client.jobs.submit('cancel-me.nika.yaml');
      try {
        // Poll will see cancelled status immediately
        await client.jobs.run('cancel-me.nika.yaml');
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NikaJobCancelledError);
        expect(err).toBeInstanceOf(NikaJobError);
        expect(err).toBeInstanceOf(NikaError);
      }
    });
  });

  // ── 4. Cancel ───────────────────────────────────────────

  describe('4. Cancel', () => {
    it('cancels a running job', async () => {
      const client = makeClient();

      const run = await client.jobs.submit('cancel-me.nika.yaml');
      expect(run.job_id).toBe('job-cancel');

      const cancel = await client.jobs.cancel(run.job_id);
      expect(cancel.job_id).toBe('job-cancel');
      expect(cancel.status).toBe('cancelled');
      expect(cancel.message).toBe('Job cancelled by user');
    });
  });

  // ── 5. Retry on 429 ────────────────────────────────────

  describe('5. Retry on 429', () => {
    it('retries automatically', async () => {
      const client = makeClient({ retries: 2 });

      const run = await client.jobs.submit('retry-429.nika.yaml');
      expect(run.job_id).toBe('job-retry-429');
      expect(state.runCallCount).toBe(2);
    });
  });

  // ── 6. runAndCollect ────────────────────────────────────

  describe('6. runAndCollect', () => {
    it('collects all non-binary artifacts', async () => {
      const client = makeClient();

      const result = await client.jobs.runAndCollect('collect.nika.yaml');

      expect(result['data.json']).toEqual({ topics: ['nika', 'langchain', 'dspy'], score: 0.95 });
      expect(result['report.md']).toContain('# Research Report');
      expect(result['audio.mp3']).toBeUndefined();
      expect(Object.keys(result)).toHaveLength(2);
    });
  });

  // ── 7. Auth Verification ────────────────────────────────

  describe('7. Auth verification', () => {
    it('all requests include Bearer token', async () => {
      const client = makeClient();

      await client.jobs.submit('lifecycle.nika.yaml');
      await client.jobs.status('job-lifecycle');
      await client.jobs.cancel('job-lifecycle');
      await client.jobs.artifacts('job-lifecycle');
      await client.jobs.artifact('job-lifecycle', 'report.md');

      const expected = `Bearer ${VALID_TOKEN}`;
      expect(state.authHeaders.get('POST /v1/run')).toBe(expected);
      expect(state.authHeaders.get('GET /v1/status/job-lifecycle')).toBe(expected);
      expect(state.authHeaders.get('POST /v1/cancel/job-lifecycle')).toBe(expected);
      expect(state.authHeaders.get('GET /v1/jobs/job-lifecycle/artifacts')).toBe(expected);
      expect(state.authHeaders.get('GET /v1/jobs/job-lifecycle/artifacts/report.md')).toBe(expected);
    });

    it('rejects wrong token', async () => {
      const badClient = new Nika({
        url: baseUrl,
        token: 'wrong-token',
        retries: 0,
        timeout: 5_000,
      });

      await expect(badClient.jobs.submit('lifecycle.nika.yaml')).rejects.toThrow(NikaAPIError);
      try {
        await badClient.jobs.submit('lifecycle.nika.yaml');
      } catch (err) {
        expect((err as NikaAPIError).status).toBe(401);
      }
    });
  });

  // ── 8. Health Check ─────────────────────────────────────

  describe('8. Health check', () => {
    it('works without authentication', async () => {
      const client = makeClient();

      const health = await client.health();

      expect(health.status).toBe('ok');
      expect(health.version).toBe('0.62.0');
      expect(health.service).toBe('nika-serve');

      const authForHealth = state.authHeaders.get('GET /health');
      expect(authForHealth).toBeUndefined();
    });
  });

  // ── 9. Workflows ────────────────────────────────────────

  describe('9. Workflows', () => {
    it('lists workflows', async () => {
      const client = makeClient();

      const list = await client.workflows.list();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('translate.nika.yaml');
      expect(list[1].size).toBe(1024);
    });

    it('reloads workflows', async () => {
      const client = makeClient();

      const list = await client.workflows.reload();
      expect(list).toHaveLength(3);
      expect(list[2].name).toBe('new.nika.yaml');
    });
  });

  // ── 10. Workflow source ──────────────────────────────────

  describe('10. Workflow source', () => {
    it('returns raw YAML content', async () => {
      const client = makeClient();

      const yaml = await client.workflows.source('translate.nika.yaml');
      expect(yaml).toContain('nika/workflow@0.12');
      expect(yaml).toContain('  id: translate');
    });
  });

  // ── 11. Binary artifact download ────────────────────────

  describe('11. Binary artifact download', () => {
    it('downloads binary artifact as Uint8Array', async () => {
      const client = makeClient();

      const binary = await client.jobs.artifactBinary('job-lifecycle', 'audio.mp3');
      expect(binary).toBeInstanceOf(Uint8Array);
      expect(binary[0]).toBe(0xff);
      expect(binary[1]).toBe(0xfb);
    });
  });
});
