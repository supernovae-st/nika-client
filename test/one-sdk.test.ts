import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaEventBufferOverflowError,
  NikaRunOwnershipError,
} from '../src/index.js';
import type {
  NikaEvent,
  NikaLocalConfig,
  NikaRun,
  NikaRunOptions,
} from '../src/index.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);
const INCOMPATIBLE_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'incompatible-nika.mjs',
);
const posix = process.platform !== 'win32';

function native(overrides: Omit<NikaLocalConfig, 'bin'> = {}): Nika {
  return new Nika({ bin: FIXTURE, ...overrides });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(frames: NikaEvent[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(iterable: AsyncIterable<NikaEvent>): Promise<NikaEvent[]> {
  const events: NikaEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('one Nika surface', () => {
  it('keeps AbortSignal off the run options type', () => {
    expectTypeOf<'signal' extends keyof NikaRunOptions ? true : false>().toEqualTypeOf<false>();
  });

  it('defaults to the native-process transport', () => {
    expect(new Nika({ bin: FIXTURE }).transportKind).toBe('native-process');
  });

  it('requires an explicit secure remote configuration', () => {
    expect(() => new Nika({ url: 'http://127.0.0.1:8787', token: 'secret' }))
      .toThrow(/allowInsecureHttp/);
    expect(() => new Nika({ url: 'https://nika.example', token: '' }))
      .toThrow(NikaConfigurationError);
    expect(() => new Nika({ token: 'orphan' } as never))
      .toThrow(/require url/);
    expect(new Nika({
      url: 'http://127.0.0.1:8787/',
      token: 'secret',
      allowInsecureHttp: true,
    }).transportKind).toBe('http');
  });

  it('exposes only identity and done on a run handle', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'run-shape', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'settled', status: 'succeeded' },
      ]));
    const client = new Nika({
      url: 'https://nika.example',
      token: 'secret',
      fetch: fetch as typeof globalThis.fetch,
    });
    const run = await client.run('flow.nika.yaml');
    expect(Object.keys(run).sort()).toEqual(['done', 'id']);
    await expect(run.done).resolves.toMatchObject({ id: 'run-shape', status: 'succeeded' });
  });
});

describe.skipIf(!posix)('native-process transport', () => {
  it('rejects an incompatible explicit engine before workflow effects', async () => {
    const sentinel = path.join(tmpdir(), `nika-sdk-effect-${randomUUID()}`);
    process.env.NIKA_EFFECT_SENTINEL = sentinel;
    try {
      const client = new Nika({ bin: INCOMPATIBLE_FIXTURE });
      await expect(client.run('must-not-run.nika.yaml'))
        .rejects.toMatchObject({
          name: 'NikaCompatibilityError',
          capability: 'engineIdentity',
        });
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      delete process.env.NIKA_EFFECT_SENTINEL;
      rmSync(sentinel, { force: true });
    }
  });

  it('returns the engine-owned check report without interpreting the workflow', async () => {
    const report = await native().check('dirty.nika.yaml', {
      model: 'mock/echo',
      nativeStrict: true,
    });
    expect(report).toMatchObject({
      report_version: 1,
      clean: false,
      exitCode: 2,
      engine_owned: { future: true },
    });
    expect(report.argv).toEqual([
      'check',
      'dirty.nika.yaml',
      '--json',
      '--model',
      'mock/echo',
      '--native-strict',
    ]);
  });

  it('eagerly drains a run even when the caller never iterates events', async () => {
    const client = native({ eventBufferSize: 4 });
    const run = await client.run('ok.nika.yaml', {
      vars: { locale: 'fr-FR' },
      model: 'mock/echo',
      maxCostUsd: 1,
    });
    const result = await run.done;
    expect(result).toMatchObject({
      id: run.id,
      status: 'succeeded',
      transport: 'native-process',
      exitCode: 0,
      outputs: { answer: 42 },
      receipt: { trace_path: 'fixture-trace.ndjson' },
    });
    expect(result).not.toHaveProperty('events');
    const retained = await collect(client.events(run));
    expect(retained.at(-1)?.kind).toBe('workflow_completed');
    expect(retained).toHaveLength(3);
  });

  it('bounds each slow subscriber without blocking done or other subscribers', async () => {
    const client = native({ eventBufferSize: 8 });
    const run = await client.run('burst.nika.yaml');
    const slow = client.events(run, { bufferSize: 1 })[Symbol.asyncIterator]();
    const fastPromise = collect(client.events(run, { bufferSize: 8 }));
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
    await expect(slow.next()).rejects.toBeInstanceOf(NikaEventBufferOverflowError);
    const fast = await fastPromise;
    expect(fast).toHaveLength(8);
    expect(fast.at(-1)?.kind).toBe('workflow_completed');
  });

  it('treats an event AbortSignal as subscriber cleanup, not run cancellation', async () => {
    const client = native();
    const run = await client.run('slow.nika.yaml');
    const controller = new AbortController();
    const view = client.events(run, { signal: controller.signal });
    controller.abort();
    await expect(collect(view)).resolves.toEqual([]);
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
  });

  it('cancels explicitly and idempotently', async () => {
    const client = native();
    const run = await client.run('cancel.nika.yaml');
    const first = client.cancel(run);
    expect(client.cancel(run)).toBe(first);
    await expect(first).resolves.toMatchObject({
      accepted: true,
      status: 'cancellation_requested',
      transport: 'native-process',
    });
    await expect(run.done).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('delegates trace verification using an engine-issued receipt', async () => {
    const client = native();
    await expect(client.traceVerify({ trace_path: 'fixture-trace.ndjson' }))
      .resolves.toMatchObject({ verified: true, exitCode: 0 });
    await expect(client.traceVerify({ trace_path: 'broken.ndjson' }))
      .resolves.toMatchObject({ verified: false, exitCode: 2 });
    await expect(client.traceVerify({ opaque: true }))
      .rejects.toBeInstanceOf(NikaCompatibilityError);
  });

  it('rejects HTTP-only run options and foreign run handles', async () => {
    const client = native();
    await expect(client.run('ok.nika.yaml', { idempotencyKey: 'remote-only' }))
      .rejects.toBeInstanceOf(NikaCompatibilityError);
    const foreign: NikaRun = {
      id: 'foreign',
      done: Promise.resolve({
        id: 'foreign',
        status: 'succeeded',
        transport: 'native-process',
      }),
    };
    expect(() => client.events(foreign)).toThrow(NikaRunOwnershipError);
    expect(() => client.cancel(foreign)).toThrow(NikaRunOwnershipError);
  });
});

describe('HTTP transport', () => {
  function remote(fetch: typeof globalThis.fetch): Nika {
    return new Nika({
      url: 'https://nika.example/',
      token: 'server-token',
      fetch,
    });
  }

  it('admits only { workflow }, drains SSE eagerly, and retains events', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'queued', status: 'queued' },
        { sequence: 2, kind: 'running', status: 'running' },
        { sequence: 3, kind: 'settled', status: 'succeeded' },
      ]));
    const client = remote(fetch as typeof globalThis.fetch);
    const run = await client.run('nested/flow.nika.yaml', { idempotencyKey: 'stable-key' });
    await expect(run.done).resolves.toEqual({
      id: 'remote-1',
      status: 'succeeded',
      transport: 'http',
    });
    expect(await collect(client.events(run))).toHaveLength(3);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://nika.example/v1/jobs');
    expect(JSON.parse(init.body as string)).toEqual({ workflow: 'nested/flow.nika.yaml' });
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer server-token');
    expect(headers.get('Idempotency-Key')).toBe('stable-key');
  });

  it('reconnects a cleanly closed event stream with Last-Event-ID', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-reconnect', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'queued', status: 'queued' },
      ]))
      .mockResolvedValueOnce(sseResponse([
        {
          sequence: 2,
          kind: 'settled',
          status: 'failed',
          code: 'NIKA-TEST-002',
          message: 'no',
        },
      ]));
    const client = remote(fetch as typeof globalThis.fetch);
    const run = await client.run('flow.nika.yaml');
    await expect(run.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'NIKA-TEST-002', message: 'no' },
    });
    const reconnectHeaders = new Headers(fetch.mock.calls[2]?.[1]?.headers);
    expect(reconnectHeaders.get('Last-Event-ID')).toBe('1');
  });

  it('refuses options and capabilities absent from live nika serve', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-gaps', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'settled', status: 'succeeded' },
      ]));
    const client = remote(fetch as typeof globalThis.fetch);
    await expect(client.check('flow.nika.yaml')).rejects.toMatchObject({
      capability: 'check',
      transport: 'http',
    });
    await expect(client.run('flow.nika.yaml', { vars: { x: 1 } }))
      .rejects.toMatchObject({ capability: 'runOptions' });
    const run = await client.run('flow.nika.yaml');
    await run.done;
    await expect(client.cancel(run)).rejects.toMatchObject({
      capability: 'cancel',
      transport: 'http',
    });
    await expect(client.traceVerify({ trace_path: 'x' })).rejects.toMatchObject({
      capability: 'traceVerify',
      transport: 'http',
    });
  });
});
