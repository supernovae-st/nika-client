import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaObservationInterrupted } from '../src/index.js';
import type { NikaEvent } from '../src/index.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);
const posix = process.platform !== 'win32';
const SERVER_TOKEN = 's'.repeat(32);

// Issue #68: an abort path must settle every internal promise — a stray
// rejection is a process-level event, so the suite listens for it directly.
const stray: unknown[] = [];
const onStray = (reason: unknown) => {
  stray.push(reason);
};

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function healthResponse(): Response {
  return new Response(JSON.stringify({
    status: 'ok',
    service: 'nika-serve',
    engineVersion: '0.114.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 1,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('abort settlement (issue #68)', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onStray);
  });
  afterEach(() => {
    process.off('unhandledRejection', onStray);
    expect(stray).toEqual([]);
  });

  describe.skipIf(!posix)('native-process transport', () => {
    it('settles every internal promise when an events AbortSignal fires mid-run', async () => {
      const client = new Nika({ bin: FIXTURE });
      const run = await client.run('cancel.nika.yaml');
      const controller = new AbortController();
      const view = client.events(run, { signal: controller.signal });
      let failure: unknown;
      const iteration = (async () => {
        try {
          for await (const event of view) void event;
        } catch (cause) {
          failure = cause;
        }
      })();
      setTimeout(() => controller.abort(), 50);
      await iteration;
      // The events signal is subscriber cleanup: the view ends gracefully.
      expect(failure).toBeUndefined();
      // run.done is deliberately never awaited — the webhook persona's shape.
      await settle(300);
    });

    it('settles every internal promise when the caller cancels mid-run', async () => {
      const client = new Nika({ bin: FIXTURE });
      const run = await client.run('cancel.nika.yaml');
      await expect(client.cancel(run)).resolves.toMatchObject({
        runId: run.id,
        accepted: true,
        status: 'cancellation_requested',
      });
      // run.done is deliberately never awaited.
      await settle(300);
    });

    it('settles every internal promise when a check AbortSignal fires mid-capture', async () => {
      const client = new Nika({ bin: FIXTURE });
      const controller = new AbortController();
      const pending = client.check('hang.nika.yaml', { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({
        name: 'NikaTransportError',
        message: expect.stringContaining('aborted'),
      });
      await settle(300);
    });
  });

  describe('HTTP transport', () => {
    it('settles every internal promise when an events AbortSignal fires mid-observation', async () => {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/health')) return healthResponse();
        if (url.endsWith('/v1/jobs/durable-job')) {
          return jsonResponse({ id: 'durable-job', status: 'running' });
        }
        if (url.endsWith('/v1/jobs/durable-job/events')) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(
                `id: 5\ndata: ${JSON.stringify({ sequence: 5, kind: 'running', status: 'running' })}\n\n`,
              ));
              // The stream never closes: the abort lands mid-observation.
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      });
      const client = new Nika({
        url: 'https://nika.example',
        token: SERVER_TOKEN,
        fetch: fetch as typeof globalThis.fetch,
      });
      const run = await client.attachRun('durable-job', { lastEventId: 4 });
      const controller = new AbortController();
      const collected: NikaEvent[] = [];
      let failure: unknown;
      const iteration = (async () => {
        try {
          for await (const event of client.events(run, { signal: controller.signal })) {
            collected.push(event);
          }
        } catch (cause) {
          failure = cause;
        }
      })();
      setTimeout(() => controller.abort(), 100);
      await iteration;
      expect(failure).toBeUndefined();
      expect(collected).toEqual([{ sequence: 5, kind: 'running', status: 'running' }]);
      // run.done is deliberately never awaited.
      await settle(300);
    });

    it('fails the terminal iterator error with runId and lastSequence for re-attach', async () => {
      // Every observation request resets: observation exhausts its retry
      // budget and the final durable read stays unreachable.
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/health')) return healthResponse();
        if (url.endsWith('/v1/jobs/durable-job')) {
          return jsonResponse({ id: 'durable-job', status: 'running' });
        }
        throw new TypeError('connection reset');
      });
      const client = new Nika({
        url: 'https://nika.example',
        token: SERVER_TOKEN,
        fetch: fetch as typeof globalThis.fetch,
      });
      const run = await client.attachRun('durable-job', { lastEventId: 4 });
      let failure: unknown;
      try {
        for await (const event of client.events(run)) void event;
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(NikaObservationInterrupted);
      expect(failure).toMatchObject({
        transport: 'http',
        runId: 'durable-job',
        lastSequence: 4,
      });
      // run.done is deliberately never awaited: its rejection is settled by
      // the session, never leaked to the process.
      await settle(300);
    }, 20_000);
  });
});
