/**
 * E2E against a fixture of the LIVE nika serve HTTP surface
 * (POST /v1/jobs, GET /v1/jobs/{id}, GET /v1/jobs/{id}/events).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Nika } from '../src/index.js';
import { NikaAPIError, NikaJobError, NikaUnavailableError } from '../src/errors.js';

interface MockState {
  authHeaders: Map<string, string | undefined>;
  statusCalls: Map<string, number>;
  runCallCount: number;
}

function freshState(): MockState {
  return { authHeaders: new Map(), statusCalls: new Map(), runCallCount: 0 };
}

const VALID_TOKEN = 'nika-e2e-test-token-2026';

function createMockServer(state: MockState) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    state.authHeaders.set(`${method} ${path}`, req.headers.authorization);

    if (path === '/health' && method === 'GET') {
      json(res, {
        status: 'ok',
        service: 'nika-serve',
        engine_version: '0.114.0',
        api_version: 'v1',
      });
      return;
    }

    if (path !== '/health') {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${VALID_TOKEN}`) {
        json(res, { error: { code: 'unauthorized', message: 'Bearer required' } }, 401);
        return;
      }
    }

    if (path === '/v1/workflows' && method === 'GET') {
      json(res, { workflows: ['translate.nika.yaml', 'seo/audit.nika.yaml'] });
      return;
    }

    const metaMatch = path.match(/^\/v1\/workflows\/(.+)$/);
    if (metaMatch && method === 'GET') {
      json(res, { workflow: decodeURIComponent(metaMatch[1]) });
      return;
    }

    if (path === '/v1/jobs' && method === 'POST') {
      const key = req.headers['idempotency-key'];
      if (!key) {
        json(res, { error: { code: 'missing_idempotency_key', message: 'Idempotency-Key required' } }, 400);
        return;
      }
      collectBody(req).then((body) => {
        const parsed = JSON.parse(body) as { workflow?: string };
        const workflow = parsed.workflow ?? '';
        if (parsed && Object.keys(parsed).some((k) => k !== 'workflow')) {
          json(res, { error: { code: 'invalid_json', message: 'deny_unknown_fields' } }, 400);
          return;
        }
        if (workflow === 'retry-429.nika.yaml') {
          state.runCallCount++;
          if (state.runCallCount === 1) {
            res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '0' });
            res.end('rate limited');
            return;
          }
          json(res, { id: 'job-retry-429', status: 'queued' }, 202);
          return;
        }
        if (workflow === 'fail.nika.yaml') {
          json(res, { id: 'job-fail', status: 'queued' }, 202);
          return;
        }
        if (workflow === 'stream.nika.yaml') {
          json(res, { id: 'job-stream', status: 'queued' }, 202);
          return;
        }
        json(res, { id: 'job-lifecycle', status: 'queued' }, 202);
      });
      return;
    }

    const eventsMatch = path.match(/^\/v1\/jobs\/(.+)\/events$/);
    if (eventsMatch && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const frames = [
        { sequence: 1, kind: 'queued', status: 'queued' },
        { sequence: 2, kind: 'running', status: 'running' },
        { sequence: 3, kind: 'succeeded', status: 'succeeded' },
      ];
      let idx = 0;
      const timer = setInterval(() => {
        if (idx >= frames.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        const event = frames[idx];
        res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        idx++;
      }, 10);
      req.on('close', () => clearInterval(timer));
      return;
    }

    const statusOnly = path.match(/^\/v1\/jobs\/(.+)\/status$/);
    if (statusOnly && method === 'GET') {
      json(res, { status: 'running' });
      return;
    }

    const jobMatch = path.match(/^\/v1\/jobs\/(.+)$/);
    if (jobMatch && method === 'GET') {
      const jobId = jobMatch[1];
      const calls = (state.statusCalls.get(jobId) ?? 0) + 1;
      state.statusCalls.set(jobId, calls);
      if (jobId === 'job-lifecycle') {
        if (calls === 1) json(res, { id: jobId, status: 'queued' });
        else if (calls === 2) json(res, { id: jobId, status: 'running' });
        else json(res, { id: jobId, status: 'succeeded' });
        return;
      }
      if (jobId === 'job-fail') {
        json(res, { id: jobId, status: calls === 1 ? 'running' : 'failed' });
        return;
      }
      json(res, { error: { code: 'not_found', message: 'route not found' } }, 404);
      return;
    }

    json(res, { error: { code: 'not_found', message: `Not found: ${method} ${path}` } }, 404);
  });
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

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

describe('E2E: live nika serve HTTP', () => {
  it('submit -> poll queued/running/succeeded', async () => {
    const client = makeClient();
    const run = await client.jobs.submit('lifecycle.nika.yaml');
    expect(run.id).toBe('job-lifecycle');
    expect(run.status).toBe('queued');
    const job = await client.jobs.run('lifecycle.nika.yaml');
    expect(job.status).toBe('succeeded');
  });

  it('streams allowlisted SSE events', async () => {
    const client = makeClient();
    const run = await client.jobs.submit('stream.nika.yaml');
    const events = [];
    for await (const event of client.jobs.stream(run.id)) events.push(event);
    expect(events.map((e) => e.status)).toEqual(['queued', 'running', 'succeeded']);
  });

  it('throws NikaJobError on failed', async () => {
    const client = makeClient();
    await expect(client.jobs.run('fail.nika.yaml')).rejects.toBeInstanceOf(NikaJobError);
  });

  it('retries 429', async () => {
    const client = makeClient({ retries: 2 });
    const run = await client.jobs.submit('retry-429.nika.yaml');
    expect(run.id).toBe('job-retry-429');
    expect(state.runCallCount).toBe(2);
  });

  it('Bearer on jobs, none on health', async () => {
    const client = makeClient();
    await client.jobs.submit('lifecycle.nika.yaml');
    await client.jobs.status('job-lifecycle');
    const health = await client.health();
    expect(health.service).toBe('nika-serve');
    expect(health.engine_version).toBe('0.114.0');
    expect(state.authHeaders.get('POST /v1/jobs')).toBe(`Bearer ${VALID_TOKEN}`);
    expect(state.authHeaders.get('GET /v1/jobs/job-lifecycle')).toBe(`Bearer ${VALID_TOKEN}`);
    expect(state.authHeaders.get('GET /health')).toBeUndefined();
  });

  it('rejects wrong token', async () => {
    const bad = new Nika({ url: baseUrl, token: 'wrong-token', retries: 0, timeout: 5_000 });
    try {
      await bad.jobs.submit('lifecycle.nika.yaml');
      expect.unreachable('should 401');
    } catch (err) {
      expect(err).toBeInstanceOf(NikaAPIError);
      expect((err as NikaAPIError).status).toBe(401);
    }
  });

  it('lists workflows as names', async () => {
    const client = makeClient();
    const list = await client.workflows.list();
    expect(list).toEqual(['translate.nika.yaml', 'seo/audit.nika.yaml']);
  });

  it('cancel and artifacts stay unavailable (no HTTP)', async () => {
    const client = makeClient();
    await expect(client.jobs.cancel('job-lifecycle')).rejects.toBeInstanceOf(NikaUnavailableError);
    await expect(client.jobs.artifacts('job-lifecycle')).rejects.toBeInstanceOf(NikaUnavailableError);
    expect(state.authHeaders.size).toBe(0);
  });

  it('requires Idempotency-Key', async () => {
    const client = makeClient();
    await client.jobs.submit('lifecycle.nika.yaml');
    expect(state.authHeaders.get('POST /v1/jobs')).toBe(`Bearer ${VALID_TOKEN}`);
  });
});
