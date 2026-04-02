/**
 * E2E integration test for @supernovae-st/nika-client.
 *
 * Spins up a minimal HTTP server (Node built-in) that mimics the nika serve API,
 * then exercises the real Nika client class against it over the network.
 *
 * No mocks -- real HTTP, real SSE, real client code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Nika } from '../src/client.js';
import { NikaError, NikaJobError } from '../src/errors.js';

// ── Mock Server State ────────────────────────────────────────

interface MockState {
  /** Track Authorization headers received per path */
  authHeaders: Map<string, string | undefined>;
  /** How many times /v1/status/{id} has been called per id */
  statusCalls: Map<string, number>;
  /** How many times /v1/run has been called (for 429 test) */
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

    // Track auth headers for every request
    state.authHeaders.set(`${method} ${path}`, req.headers.authorization);

    // ── Health (no auth) ──────────────────────────────────
    if (path === '/health' && method === 'GET') {
      json(res, { status: 'ok', version: '0.61.0', service: 'nika-serve' });
      return;
    }

    // ── Auth gate for everything else ─────────────────────
    if (path !== '/health') {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${VALID_TOKEN}`) {
        json(res, { error: 'Unauthorized' }, 401);
        return;
      }
    }

    // ── POST /v1/run ──────────────────────────────────────
    if (path === '/v1/run' && method === 'POST') {
      collectBody(req).then((body) => {
        const parsed = JSON.parse(body);
        const workflow: string = parsed.workflow;

        // 429 scenario: first call returns 429, second succeeds
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

        // Failing workflow
        if (workflow === 'fail.nika.yaml') {
          json(res, { job_id: 'job-fail', status: 'pending' });
          return;
        }

        // Cancel workflow
        if (workflow === 'cancel-me.nika.yaml') {
          json(res, { job_id: 'job-cancel', status: 'pending' });
          return;
        }

        // SSE streaming workflow
        if (workflow === 'stream.nika.yaml') {
          json(res, { job_id: 'job-stream', status: 'pending' });
          return;
        }

        // runAndCollect workflow
        if (workflow === 'collect.nika.yaml') {
          json(res, { job_id: 'job-collect', status: 'pending' });
          return;
        }

        // Default: lifecycle workflow
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
        // Transition: pending (1) -> running (2) -> completed (3+)
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
        json(res, makeJob(jobId, 'running', 'cancel-me.nika.yaml', {
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
        { type: 'task_complete', job_id: jobId, task_id: 'research', verb: 'infer', duration_ms: 1200 },
        { type: 'task_start', job_id: jobId, task_id: 'summarize', verb: 'infer' },
        { type: 'task_complete', job_id: jobId, task_id: 'summarize', verb: 'infer', duration_ms: 800 },
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

      // Clean up if client disconnects
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

      json(res, { error: 'Artifact not found' }, 404);
      return;
    }

    // ── Fallback 404 ──────────────────────────────────────
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

describe('E2E: nika-client against mock server', () => {
  // ── 1. Full Lifecycle ────────────────────────────────────

  describe('1. Full lifecycle: submit -> poll -> artifacts -> download', () => {
    it('transitions through pending -> running -> completed, then lists and downloads artifacts', async () => {
      const client = makeClient();

      // Submit
      const run = await client.submit('lifecycle.nika.yaml', { topic: 'AI' });
      expect(run.job_id).toBe('job-lifecycle');
      expect(run.status).toBe('pending');

      // Poll until done (mock transitions: pending -> running -> completed)
      const job = await client.run('lifecycle.nika.yaml', { topic: 'AI' });
      expect(job.status).toBe('completed');
      expect(job.job_id).toMatch(/^job-lifecycle/);
      expect(job.exit_code).toBe(0);
      expect(job.output).toBe('All 3 tasks completed');
      expect(job.workflow).toBe('lifecycle.nika.yaml');
      expect(job.started_at).toBeDefined();
      expect(job.completed_at).toBeDefined();

      // List artifacts
      const artifacts = await client.artifacts(job.job_id);
      expect(artifacts).toHaveLength(3);
      expect(artifacts[0].name).toBe('report.md');
      expect(artifacts[0].format).toBe('markdown');
      expect(artifacts[0].size).toBe(512);
      expect(artifacts[1].name).toBe('data.json');
      expect(artifacts[1].checksum).toBe('blake3-abc123');
      expect(artifacts[2].name).toBe('audio.mp3');
      expect(artifacts[2].format).toBe('binary');

      // Download text artifact
      const markdown = await client.artifact(job.job_id, 'report.md');
      expect(markdown).toContain('# Research Report');
      expect(markdown).toContain('AI workflow engines');

      // Download JSON artifact
      const data = await client.artifactJson<{ topics: string[]; score: number }>(
        job.job_id,
        'data.json',
      );
      expect(data.topics).toEqual(['nika', 'langchain', 'dspy']);
      expect(data.score).toBe(0.95);
    });
  });

  // ── 2. SSE Streaming ────────────────────────────────────

  describe('2. SSE streaming: receive all events in order', () => {
    it('streams started -> task_start -> task_complete -> ... -> completed', async () => {
      const client = makeClient();

      // Submit to get the job
      const run = await client.submit('stream.nika.yaml');
      expect(run.job_id).toBe('job-stream');

      // Stream events
      const events = [];
      for await (const event of client.stream(run.job_id)) {
        events.push(event);
      }

      // Verify all 6 events received in correct order
      expect(events).toHaveLength(6);
      expect(events[0].type).toBe('started');
      expect(events[0].job_id).toBe('job-stream');

      expect(events[1].type).toBe('task_start');
      expect(events[1].task_id).toBe('research');
      expect(events[1].verb).toBe('infer');

      expect(events[2].type).toBe('task_complete');
      expect(events[2].task_id).toBe('research');
      expect(events[2].duration_ms).toBe(1200);

      expect(events[3].type).toBe('task_start');
      expect(events[3].task_id).toBe('summarize');

      expect(events[4].type).toBe('task_complete');
      expect(events[4].task_id).toBe('summarize');
      expect(events[4].duration_ms).toBe(800);

      expect(events[5].type).toBe('completed');
      expect(events[5].output).toBe('All tasks done');

      // Verify types follow the expected lifecycle pattern
      const types = events.map((e) => e.type);
      expect(types[0]).toBe('started');
      expect(types[types.length - 1]).toBe('completed');
    });
  });

  // ── 3. Error Handling ───────────────────────────────────

  describe('3. Error handling: failed workflow produces NikaJobError', () => {
    it('polls a failing job and throws NikaJobError with correct details', async () => {
      const client = makeClient();

      try {
        await client.run('fail.nika.yaml');
        expect.unreachable('Should have thrown NikaJobError');
      } catch (err) {
        expect(err).toBeInstanceOf(NikaJobError);
        const jobErr = err as NikaJobError;
        expect(jobErr.job.job_id).toBe('job-fail');
        expect(jobErr.job.status).toBe('failed');
        expect(jobErr.job.output).toContain('NIKA-010');
        expect(jobErr.job.output).toContain('schema validation error');
        expect(jobErr.job.exit_code).toBe(1);
        expect(jobErr.message).toContain('job-fail');
        expect(jobErr.message).toContain('NIKA-010');
      }
    });
  });

  // ── 4. Cancel ───────────────────────────────────────────

  describe('4. Cancel: submit then cancel a running job', () => {
    it('submits a workflow and cancels it successfully', async () => {
      const client = makeClient();

      // Submit
      const run = await client.submit('cancel-me.nika.yaml');
      expect(run.job_id).toBe('job-cancel');

      // Verify it is running
      const status = await client.status(run.job_id);
      expect(status.status).toBe('running');

      // Cancel
      const cancel = await client.cancel(run.job_id);
      expect(cancel.job_id).toBe('job-cancel');
      expect(cancel.status).toBe('cancelled');
      expect(cancel.message).toBe('Job cancelled by user');
    });
  });

  // ── 5. Retry on 429 ────────────────────────────────────

  describe('5. Retry on 429: server returns 429 once then 200', () => {
    it('retries automatically and succeeds on second attempt', async () => {
      const client = makeClient({ retries: 2 });

      // Reset the counter for this test
      state.runCallCount = 0;

      const run = await client.submit('retry-429.nika.yaml');
      expect(run.job_id).toBe('job-retry-429');
      expect(run.status).toBe('pending');

      // Verify the server saw 2 requests (429 + 200)
      expect(state.runCallCount).toBe(2);
    });
  });

  // ── 6. runAndCollect ────────────────────────────────────

  describe('6. runAndCollect: full flow including artifact collection', () => {
    it('runs, waits, and collects all non-binary artifacts into a map', async () => {
      const client = makeClient();

      const result = await client.runAndCollect('collect.nika.yaml');

      // JSON artifact parsed as object
      expect(result['data.json']).toEqual({
        topics: ['nika', 'langchain', 'dspy'],
        score: 0.95,
      });

      // Markdown artifact as string
      expect(result['report.md']).toContain('# Research Report');
      expect(typeof result['report.md']).toBe('string');

      // Binary artifact skipped
      expect(result['audio.mp3']).toBeUndefined();

      // Only 2 non-binary artifacts collected
      expect(Object.keys(result)).toHaveLength(2);
    });
  });

  // ── 7. Auth Verification ────────────────────────────────

  describe('7. Auth verification: all requests include Bearer token', () => {
    it('sends Authorization header on submit, status, cancel, artifacts, artifact download', async () => {
      const client = makeClient();

      // Make several authenticated requests
      await client.submit('lifecycle.nika.yaml');
      await client.status('job-lifecycle');
      await client.cancel('job-lifecycle');
      await client.artifacts('job-lifecycle');
      await client.artifact('job-lifecycle', 'report.md');

      // Check auth header was present for each
      const expected = `Bearer ${VALID_TOKEN}`;
      expect(state.authHeaders.get('POST /v1/run')).toBe(expected);
      expect(state.authHeaders.get('GET /v1/status/job-lifecycle')).toBe(expected);
      expect(state.authHeaders.get('POST /v1/cancel/job-lifecycle')).toBe(expected);
      expect(state.authHeaders.get('GET /v1/jobs/job-lifecycle/artifacts')).toBe(expected);
      expect(state.authHeaders.get('GET /v1/jobs/job-lifecycle/artifacts/report.md')).toBe(expected);
    });

    it('rejects requests with wrong token', async () => {
      const badClient = new Nika({
        url: baseUrl,
        token: 'wrong-token',
        retries: 0,
        timeout: 5_000,
      });

      await expect(badClient.submit('lifecycle.nika.yaml')).rejects.toThrow(NikaError);
      try {
        await badClient.submit('lifecycle.nika.yaml');
      } catch (err) {
        expect((err as NikaError).status).toBe(401);
      }
    });
  });

  // ── 8. Health Check ─────────────────────────────────────

  describe('8. Health check: works without authentication', () => {
    it('returns health status from /health without Authorization header', async () => {
      const client = makeClient();

      const health = await client.health();

      expect(health.status).toBe('ok');
      expect(health.version).toBe('0.61.0');
      expect(health.service).toBe('nika-serve');

      // Verify no auth header was sent for health
      // health() uses globalThis.fetch directly without auth headers
      const authForHealth = state.authHeaders.get('GET /health');
      expect(authForHealth).toBeUndefined();
    });
  });
});
