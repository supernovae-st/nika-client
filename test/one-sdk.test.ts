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
  NikaOperationError,
  NikaRunOwnershipError,
} from '../src/index.js';
import type {
  NikaEvent,
  NikaLocalConfig,
  NikaRun,
  NikaRunOptions,
  NikaScheduleOptions,
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
const SNAPSHOT_BYTES = '{"format_version":1,"root":"fixture.nika.yaml","digest":"fixture-digest","units":[{"path":"fixture.nika.yaml","kind":0,"digest":"unit-digest","bytes_hex":"00"}]}';

function healthResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    status: 'ok',
    service: 'nika-serve',
    engineVersion: '0.114.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 1,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
    ...overrides,
  });
}

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
        controller.enqueue(encoder.encode(
          `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
        ));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function scheduleProjection(overrides: Record<string, unknown> = {}) {
  return {
    definition: {
      id: 'daily',
      workflow: 'flow.nika.yaml',
      when: { kind: 'cadence', expression: 'daily at 09:00 Europe/Paris' },
      maxCostUsd: 0.25,
      missed: 'catch-up-once',
      maxLatenessSeconds: 3600,
      overlap: 'skip',
      afterSkip: 'next_slot',
      jitter: null,
      tolerance: null,
      active: true,
      pauseReason: null,
      pauseUntil: null,
    },
    origin: 'api',
    revision: `sha256:${'a'.repeat(64)}`,
    active: true,
    pause: null,
    due: { kind: 'not_due' },
    next: [{
      slotId: 'slot-1',
      scheduledFor: '2026-08-31T07:00:00Z',
      requestedCivil: '2026-08-31T09:00:00',
      shift: 'exact',
    }],
    earliestWakeHint: '2026-08-31T07:00:00Z',
    lastDecision: null,
    ...overrides,
  };
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
      bin: FIXTURE,
    }).transportKind).toBe('http');
  });

  it('exposes only identity and done on a run handle', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'run-shape', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'settled', status: 'succeeded' },
      ]));
    const client = new Nika({
      url: 'https://nika.example',
      token: 'secret',
      bin: FIXTURE,
      fetch: fetch as typeof globalThis.fetch,
    });
    const run = await client.run('flow.nika.yaml');
    expect(Object.keys(run).sort()).toEqual(['done', 'id']);
    await expect(run.done).resolves.toMatchObject({ id: 'run-shape', status: 'succeeded' });
  });
});

describe.skipIf(!posix)('native-process transport', () => {
  it('refuses schedule operations without starting a direct local process', async () => {
    const client = native();
    await expect(client.schedule('flow.nika.yaml', {
      id: 'daily',
      when: { kind: 'once', at: '2026-09-01T07:00:00Z' },
      maxCostUsd: 0.25,
      missed: 'skip',
    })).rejects.toMatchObject({
      name: 'NikaCompatibilityError',
      capability: 'schedule',
      transport: 'native-process',
    });
    await expect(client.scheduleStatus('daily')).rejects.toMatchObject({
      capability: 'schedule',
      transport: 'native-process',
    });
  });

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
    const receipt = Object.freeze({
      receipt_format: 1,
      execution_id: 'exe-fixture',
      trace_id: 'trace-fixture',
      snapshot_digest: 'snapshot-fixture',
      trace_path: 'fixture-trace.ndjson',
      chain_head: 'fixture-head',
      chain_len: 7,
      sealed: true,
    });
    await expect(client.traceVerify(receipt))
      .resolves.toMatchObject({ verified: true, exitCode: 0 });
    await expect(client.traceVerify({ ...receipt, trace_path: 'broken.ndjson' }))
      .resolves.toMatchObject({ verified: false, exitCode: 2 });
    await expect(client.traceVerify({ ...receipt, chain_head: 'forged' }))
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
      bin: FIXTURE,
      fetch,
    });
  }

  const scheduleOptions: NikaScheduleOptions = {
    id: 'daily',
    when: { kind: 'cadence', expression: 'daily at 09:00 Europe/Paris' },
    maxCostUsd: 0.25,
    missed: 'catch-up-once',
    maxLatenessSeconds: 3600,
    overlap: 'skip',
    afterSkip: 'next_slot',
  };

  it('uses only the advertised resident schedule authority and projects its machine facts', async () => {
    const status = scheduleProjection();
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({
        supportedCapabilities: [
          'check',
          'executionSnapshot',
          'eventStream',
          'schedule',
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ applied: true, changed: true, status }))
      .mockResolvedValueOnce(jsonResponse(status));
    const client = remote(fetch as typeof globalThis.fetch);

    await expect(client.schedule('flow.nika.yaml', scheduleOptions)).resolves.toEqual({
      applied: true,
      changed: true,
      status,
    });
    await expect(client.scheduleStatus('daily')).resolves.toEqual(status);

    const [applyUrl, applyInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(applyUrl).toBe('https://nika.example/v1/schedules/daily');
    expect(applyInit.method).toBe('PUT');
    const applyHeaders = new Headers(applyInit.headers);
    expect(applyHeaders.get('If-None-Match')).toBe('*');
    expect(applyHeaders.has('If-Match')).toBe(false);
    expect(JSON.parse(String(applyInit.body))).toEqual({
      workflow: 'flow.nika.yaml',
      when: scheduleOptions.when,
      maxCostUsd: 0.25,
      missed: 'catch-up-once',
      maxLatenessSeconds: 3600,
      overlap: 'skip',
      afterSkip: 'next_slot',
    });
    expect(String(fetch.mock.calls[2]?.[0])).toBe(
      'https://nika.example/v1/schedules/daily',
    );
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/health'))).toHaveLength(1);
  });

  it('requires the remote schedule capability before calling its route', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    await expect(remote(fetch as typeof globalThis.fetch).schedule(
      'flow.nika.yaml',
      scheduleOptions,
    )).rejects.toMatchObject({
      name: 'NikaCompatibilityError',
      capability: 'schedule',
      transport: 'http',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://nika.example/health');
  });

  it('uses exact revisions and normalizes HTTP 412 into one operation error taxonomy', async () => {
    const revision = `sha256:${'b'.repeat(64)}`;
    const currentRevision = `sha256:${'c'.repeat(64)}`;
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({
        supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'schedule'],
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: {
          code: 'schedule_precondition_failed',
          message: 'create requires If-None-Match: *; update requires the exact current ETag',
          currentRevision,
        },
      }, 412));
    const client = remote(fetch as typeof globalThis.fetch);
    let failure: unknown;
    try {
      await client.schedule('flow.nika.yaml', { ...scheduleOptions, revision });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(NikaOperationError);
    expect(failure).toMatchObject({
      operation: 'schedule',
      code: 'schedule_conflict',
      machineCode: 'schedule_precondition_failed',
      currentRevision,
      status: 412,
      transport: 'http',
    });
    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(headers.get('If-Match')).toBe(`"${revision}"`);
    expect(headers.has('If-None-Match')).toBe(false);
  });

  it('preserves engine findings without interpreting cadence or jitter', async () => {
    const findings = [{
      code: 'schedule.jitter',
      detail: 'hash jitter has no canonical offset law',
      future: { engineOwned: true },
    }];
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({
        supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'schedule'],
      }))
      .mockResolvedValueOnce(jsonResponse({ findings }, 422));
    await expect(remote(fetch as typeof globalThis.fetch).schedule(
      'flow.nika.yaml',
      { ...scheduleOptions, jitter: 'hash' },
    )).rejects.toMatchObject({
      name: 'NikaOperationError',
      operation: 'schedule',
      code: 'schedule_refused',
      status: 422,
      findings,
    });
  });

  it('returns planner findings as status data rather than calculating a replacement', async () => {
    const finding = {
      code: 'schedule.cadence',
      detail: 'canonical cadence cannot be planned by this engine',
      future: true,
    };
    const status = scheduleProjection({
      due: undefined,
      finding,
      next: [],
      earliestWakeHint: null,
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({
        supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'schedule'],
      }))
      .mockResolvedValueOnce(jsonResponse(status));
    await expect(remote(fetch as typeof globalThis.fetch).scheduleStatus('daily'))
      .resolves.toMatchObject({ finding, next: [], earliestWakeHint: null });
  });

  it('posts the exact opaque snapshot bytes with no legacy workflow envelope', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
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

    const [url, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://nika.example/v1/jobs');
    expect(init.body).toBe(SNAPSHOT_BYTES);
    expect(init.body).not.toContain('nested/flow.nika.yaml');
    expect(init.body).not.toContain('workflow');
    const headers = new Headers(init.headers);
    const healthHeaders = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(healthHeaders.has('Authorization')).toBe(false);
    expect(headers.get('Authorization')).toBe('Bearer server-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Idempotency-Key')).toBe('stable-key');
  });

  it('reconnects a cleanly closed event stream with Last-Event-ID', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-reconnect', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'queued', status: 'queued' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-reconnect', status: 'running' }))
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
    expect(String(fetch.mock.calls[3]?.[0])).toBe(
      'https://nika.example/v1/jobs/remote-reconnect',
    );
    const reconnectHeaders = new Headers(fetch.mock.calls[4]?.[1]?.headers);
    expect(reconnectHeaders.get('Last-Event-ID')).toBe('1');
  });

  it('returns the complete local check report only after remote acknowledgement', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        status: 'accepted',
        snapshot_digest: 'fixture-digest',
        root: 'fixture.nika.yaml',
        units: 1,
      }));
    const client = remote(fetch as typeof globalThis.fetch);
    const report = await client.check('/local/only/flow.nika.yaml');
    expect(report).toMatchObject({
      clean: true,
      report_version: 1,
      engine_owned: { future: true },
      exitCode: 0,
    });
    expect(report).not.toHaveProperty('execution_snapshot');
    expect(report.argv).toEqual([
      'check',
      '/local/only/flow.nika.yaml',
      '--json',
      '--sdk-snapshot',
    ]);
    const [url, init] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://nika.example/v1/check');
    expect(init.body).toBe(SNAPSHOT_BYTES);
    expect(init.body).not.toContain('/local/only/flow.nika.yaml');
  });

  it('caches compatible identities and refuses incompatible remote protocol', async () => {
    const compatibleFetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        status: 'accepted',
        snapshot_digest: 'fixture-digest',
        root: 'fixture.nika.yaml',
        units: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'cached', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'settled', status: 'succeeded' },
      ]));
    const compatible = remote(compatibleFetch as typeof globalThis.fetch);
    await compatible.check('one.nika.yaml');
    const run = await compatible.run('two.nika.yaml');
    await run.done;
    expect(compatibleFetch.mock.calls.filter(([url]) => String(url).endsWith('/health')))
      .toHaveLength(1);

    const incompatibleFetch = vi.fn().mockResolvedValueOnce(healthResponse({
      machineProtocolVersion: 99,
    }));
    await expect(remote(incompatibleFetch as typeof globalThis.fetch).run('never.nika.yaml'))
      .rejects.toMatchObject({ capability: 'engineIdentity', transport: 'http' });
    expect(incompatibleFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses dirty or tampered local capture before network admission', async () => {
    for (const workflow of ['dirty.nika.yaml', 'tampered.nika.yaml']) {
      const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
      await expect(remote(fetch as typeof globalThis.fetch).run(workflow))
        .rejects.toBeInstanceOf(NikaCompatibilityError);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toBe('https://nika.example/health');
    }
  });

  it('returns a parse-fatal remote check report without misclassifying identity', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    const report = await remote(fetch as typeof globalThis.fetch).check('parse-fatal.nika.yaml');
    expect(report).toMatchObject({
      clean: false,
      parse_fatal: true,
      exitCode: 2,
      findings: [{ code: 'NIKA-PARSE-001' }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('projects the server trace authority typed unavailable verdict', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({
        verdict: 'unavailable',
        reason: 'trace_journal_unavailable',
        trace_id: 'trace-remote',
      }));
    const verdict = await remote(fetch as typeof globalThis.fetch).traceVerify({
      job_id: '00000000-0000-4000-8000-000000000001',
      trace_id: 'trace-remote',
    });
    expect(verdict).toMatchObject({
      verified: false,
      verdict: 'unavailable',
      reason: 'trace_journal_unavailable',
    });
    expectTypeOf(verdict.verdict).toEqualTypeOf<
      'verified' | 'invalid' | 'unavailable' | (string & {}) | undefined
    >();
    expectTypeOf(verdict.reason).toEqualTypeOf<
      | 'trace_invalid'
      | 'receipt_mismatch'
      | 'run_not_terminal'
      | 'trace_journal_unavailable'
      | (string & {})
      | undefined
    >();
  });

  it('refuses absent options, cancels through the live route, and keeps trace refusal typed', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-gaps', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseResponse([
        { sequence: 1, kind: 'settled', status: 'succeeded' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ id: 'remote-gaps', status: 'succeeded' }));
    const client = remote(fetch as typeof globalThis.fetch);
    await expect(client.check('flow.nika.yaml', { model: 'mock/echo' }))
      .rejects.toMatchObject({ capability: 'checkOptions', transport: 'http' });
    for (const options of [
      { vars: { x: 1 } },
      { model: 'mock/echo' },
      { maxCostUsd: 1 },
    ]) {
      await expect(client.run('flow.nika.yaml', options))
        .rejects.toMatchObject({ capability: 'runOptions', transport: 'http' });
    }
    expect(fetch).not.toHaveBeenCalled();
    const run = await client.run('flow.nika.yaml');
    await run.done;
    await expect(client.cancel(run)).resolves.toMatchObject({
      accepted: false,
      status: 'already_settled',
      transport: 'http',
    });
    await expect(client.traceVerify({ trace_path: 'x' })).rejects.toMatchObject({
      capability: 'traceVerify',
      transport: 'http',
    });
  });

  it('redacts the bearer token from HTTP failures', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(
      'reflected server-token',
      { status: 500 },
    ));
    const client = remote(fetch as typeof globalThis.fetch);
    let failure: unknown;
    try {
      await client.run('flow.nika.yaml');
    } catch (cause) {
      failure = cause;
    }
    expect(String(failure)).toContain('[REDACTED]');
    expect(String(failure)).not.toContain('server-token');
  });
});
