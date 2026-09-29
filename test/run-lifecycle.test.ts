import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaEventBufferOverflowError,
  NikaObservationInterrupted,
  NikaOperationError,
  NikaRunOwnershipError,
  isNikaRunSucceeded,
} from '../src/index.js';
import type {
  NikaCancelResult,
  NikaEvent,
  NikaLocalConfig,
  NikaRun,
  NikaRunEvent,
  NikaRunEventKind,
  NikaRunId,
  NikaRunResult,
  NikaRunStatus,
} from '../src/index.js';
import { observe, runToReport } from './fixtures/lifecycle-app.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseResponse,
  sseText,
  sseFrame,
} from './helpers/http-depth-harness.js';

// Issues #120 and #117 · the Run owns its lifecycle, and one application reads
// the same lifecycle words over the native process and over `nika serve`:
//
//   const run = await nika.run(workflow)       // refused: rejects, no Run
//   for await (const event of run.events()) {} // semantic kind · event.raw
//   const result = await run.result()          // admitted failure is data
//   await run.cancel() · await run.status()
//   await nika.attachRun(id, { lastEventId })  // the one recovery door
//
// Native frames are measured bytes replayed by fake-nika.mjs (see
// fixtures/run-wire/README.md). HTTP frames are the resident's closed
// `JobEvent` projection; it streams no per-task frame, and none is expected.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const APP_SOURCE = readFileSync(path.join(HERE, 'fixtures', 'lifecycle-app.ts'), 'utf8');
const posix = process.platform !== 'win32';

const RECEIPT = {
  job_id: 'job-1',
  execution_id: 'exe-1',
  trace_id: 'trace-1',
  snapshot_digest: 'c'.repeat(64),
};

const stray: unknown[] = [];
const onStray = (reason: unknown) => {
  stray.push(reason);
};

function native(overrides: Omit<NikaLocalConfig, 'bin'> = {}): Nika {
  return new Nika({ bin: FIXTURE, ...overrides });
}

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ServeRequest {
  method: string;
  path: string;
  lastEventId: string | null;
}

/** A resident that answers by route and remembers every request it served. */
function serve(
  routes: Record<string, (request: ServeRequest) => Response | Promise<Response>>,
): { client: Nika; requests: ServeRequest[] } {
  const requests: ServeRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request: ServeRequest = {
      method: init?.method ?? 'GET',
      path: new URL(String(input)).pathname,
      lastEventId: new Headers(init?.headers).get('Last-Event-ID'),
    };
    requests.push(request);
    if (request.path === '/health') return healthResponse();
    const route = routes[`${request.method} ${request.path}`];
    if (!route) throw new Error(`unexpected ${request.method} ${request.path}`);
    return route(request);
  };
  const client = new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    bin: HTTP_DEPTH_FIXTURE,
    fetch: fetch as typeof globalThis.fetch,
  });
  return { client, requests };
}

/** One admitted by-name job whose observation streams `frames`. */
function served(frames: NikaEvent[], extra: Parameters<typeof serve>[0] = {}) {
  return serve({
    'POST /v1/jobs': () => jsonResponse({ id: 'job-1', status: 'queued' }, 202),
    'GET /v1/jobs/job-1/events': () => sseResponse(frames),
    ...extra,
  });
}

const HTTP_RUN = { idempotencyKey: 'lifecycle-admission' };

async function collect<Event>(events: AsyncIterable<Event>): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe.skipIf(!posix)('one application, two transports (issues #117 and #120)', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onStray);
  });
  afterEach(async () => {
    await settle(50);
    process.off('unhandledRejection', onStray);
    expect(stray).toEqual([]);
  });

  describe('the strict application', () => {
    it('never mentions a protocol word, the raw frame, or a client-level lifecycle call', () => {
      // Comments may teach; the code may not depend on the protocol.
      const code = APP_SOURCE.split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')
          && !line.trim().startsWith('/*'))
        .join('\n');
      for (const forbidden of [
        /workflow_/, /execution\./, /run_settled/, /run_sealed/,
        /task_(scheduled|started|completed|failed)/,
        /\.raw\b/, /\.done\b/, /\bas any\b/,
        /nika\.(events|cancel|status)\(/,
      ]) {
        expect(code).not.toMatch(forbidden);
      }
      expect(code).toContain('run.events()');
      expect(code).toContain('run.result()');
    });

    it('reads a native run in lifecycle words, per-task facts included', async () => {
      const report = await runToReport(native(), 'wire-0119-hello.nika');

      expect(report).toMatchObject({
        facts: [
          'run.started',
          'task.scheduled',
          'task.started',
          'task.completed',
          'engine.event',
          'run.settled',
        ],
        tasks: ['task.scheduled:greet', 'task.started:greet', 'task.completed:greet'],
        outcome: 'succeeded',
        outputs: { greeting: 'mock(echo) · hello' },
      });
      // A native process has no durable replay, so the app saw no cursor.
      expect(report).not.toHaveProperty('cursor');
    });

    it('reads an HTTP run in the same words, with fewer facts and none invented', async () => {
      const { client } = served([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        {
          sequence: 2,
          kind: 'execution.settled',
          status: 'succeeded',
          outputs: { greeting: 'served' },
          receipt: RECEIPT,
        },
      ]);

      const report = await runToReport(client, 'flow.nika', HTTP_RUN);

      expect(report).toEqual({
        runId: 'job-1',
        facts: ['run.started', 'run.settled'],
        // The resident streams no per-task frame, so the app was told of none.
        tasks: [],
        cursor: 2,
        outcome: 'succeeded',
        outputs: { greeting: 'served' },
      });
    });

    it('receives an admitted failure as result data on both transports', async () => {
      const local = await runToReport(native(), 'wire-0119-admitted-failure.nika');
      expect(local).toMatchObject({
        outcome: 'failed',
        failure: { code: 'NIKA-BUILTIN-ASSERT-001', task: 'fail' },
        tasks: ['task.scheduled:fail', 'task.started:fail', 'task.failed:fail'],
      });
      expect(local.facts.at(-1)).toBe('run.settled');

      const failed = {
        status: 'failed',
        cause: 'task_failed',
        error: { code: 'NIKA-EXEC-001', message: 'command exited with status 1', task: 'build' },
      };
      const { client } = served([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind: 'execution.settled', status: 'failed', settlement: failed },
      ]);
      const remote = await runToReport(client, 'flow.nika', HTTP_RUN);
      expect(remote).toMatchObject({
        facts: ['run.started', 'run.settled'],
        outcome: 'failed',
        failure: { code: 'NIKA-EXEC-001', task: 'build' },
      });
    });

    it('holds a human gate as waiting on both transports: never failed, never completed', async () => {
      const local = await runToReport(native(), 'wire-0118-human-gate.nika');
      expect(local).toMatchObject({
        facts: ['run.started', 'task.scheduled', 'engine.event', 'run.waiting'],
        outcome: 'waiting',
      });
      expect(local).not.toHaveProperty('failure');
      expect(local.facts).not.toContain('run.settled');

      const paused = { status: 'paused', cause: 'human_gate' };
      const { client } = served([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind: 'execution.settled', status: 'paused', settlement: paused },
      ]);
      const remote = await runToReport(client, 'flow.nika', HTTP_RUN);
      expect(remote).toMatchObject({
        facts: ['run.started', 'run.waiting'],
        outcome: 'waiting',
        cursor: 2,
      });
      expect(remote).not.toHaveProperty('failure');
      expect(remote.facts).not.toContain('run.settled');
    });

    it('reads an operator cancellation as the engine wrote it, not as its exit code', async () => {
      // Released 0.118.7, SIGTERM mid-run: the engine settled `cancelled` and
      // only then exited 130. The state word it wrote outranks the exit class.
      const report = await runToReport(native(), 'wire-0118-sigterm-cancel.nika');

      expect(report).toMatchObject({
        facts: [
          'run.started',
          'task.scheduled',
          'task.started',
          'engine.event',
          'task.completed',
          'engine.event',
          'run.settled',
        ],
        outcome: 'cancelled',
      });
      expect(report).not.toHaveProperty('failure');
    });

    it('is never handed a run the engine refused before admission', async () => {
      const refused = await runToReport(native(), 'wire-pr1679-sec004.nika')
        .catch((cause: unknown) => cause);
      expect(refused).toBeInstanceOf(NikaOperationError);
      expect(refused).toMatchObject({
        operation: 'run',
        code: 'NIKA-SEC-004',
        transport: 'native-process',
      });

      const { client, requests } = serve({
        'POST /v1/jobs': () => jsonResponse({
          error: { code: 'workflow_refused', message: 'the capture refused this workflow' },
        }, 422),
      });
      const remote = await runToReport(client, 'flow.nika', HTTP_RUN)
        .catch((cause: unknown) => cause);
      expect(remote).toBeInstanceOf(NikaOperationError);
      expect(remote).toMatchObject({ operation: 'run', code: 'workflow_refused', status: 422 });
      // No Run existed, so nothing ever observed one.
      expect(requests.some((request) => request.path.endsWith('/events'))).toBe(false);
    });
  });

  describe('a semantic event keeps its protocol frame', () => {
    it('shows the native word on raw, the very frame the engine wrote', async () => {
      const client = native();
      const run = await client.run('wire-0119-hello.nika');
      const events = await collect(run.events());
      await run.result();

      expect(events.map((event) => [event.kind, event.raw.kind])).toEqual([
        ['run.started', 'workflow_started'],
        ['task.scheduled', 'task_scheduled'],
        ['task.started', 'task_started'],
        ['task.completed', 'task_completed'],
        ['engine.event', 'workflow_completed'],
        ['run.settled', 'run_settled'],
      ]);
      const recorded = readFileSync(
        path.join(HERE, 'fixtures', 'run-wire', '0.119.0-hello.ndjson.stdout'),
        'utf8',
      ).split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown);
      expect(events.map((event) => event.raw)).toEqual(recorded);
    });

    it('shows the resident word on raw, with its replay cursor lifted', async () => {
      const frames: NikaEvent[] = [
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind: 'execution.settled', status: 'succeeded' },
      ];
      const { client } = served(frames);
      const run = await client.run('flow.nika', HTTP_RUN);
      const events = await collect(run.events());

      expect(events.map((event) => [event.kind, event.raw.kind, event.sequence])).toEqual([
        ['run.started', 'execution.started', 1],
        ['run.settled', 'execution.settled', 2],
      ]);
      expect(events.map((event) => event.raw)).toEqual(frames);
    });
  });

  describe('the Run owns its lifecycle', () => {
    it('exposes identity, the four lifecycle methods, and the done alias, frozen', async () => {
      const run = await native().run('ok.nika');

      expect(Object.keys(run).sort()).toEqual([
        'cancel', 'done', 'events', 'id', 'result', 'status',
      ]);
      expect(Object.isFrozen(run)).toBe(true);
      // Authoring, proof, catalog and listing stay on the client.
      for (const absent of ['list', 'search', 'render', 'explain', 'compile', 'verify', 'attach']) {
        expect(run).not.toHaveProperty(absent);
      }
      await run.result();
    });

    it('settles result() and the done alias with the one same result', async () => {
      const run = await native().run<{ answer: number }>('ok.nika');

      const result = await run.result();
      expect(result).toMatchObject({ id: run.id, status: 'succeeded', outputs: { answer: 42 } });
      expect(await run.done).toBe(result);
      expect(await run.result()).toBe(result);
      expect(isNikaRunSucceeded(result)).toBe(true);
    });

    it('keeps working when its methods are extracted from the handle', async () => {
      const { events, result, status, cancel } = await native().run('wire-0119-hello.nika');

      const kinds = (await collect(events())).map((event) => event.kind);
      expect(kinds.at(0)).toBe('run.started');
      expect(kinds.at(-1)).toBe('run.settled');
      await expect(result()).resolves.toMatchObject({ status: 'succeeded' });
      await expect(status()).rejects.toBeInstanceOf(NikaCompatibilityError);
      await expect(cancel()).resolves.toMatchObject({ status: 'already_settled' });
    });

    it('refuses a native status instead of inventing a durable one', async () => {
      const run = await native().run('ok.nika');

      await expect(run.status()).rejects.toMatchObject({
        name: 'NikaCompatibilityError',
        capability: 'runStatus',
        transport: 'native-process',
      });
      await run.result();
    });

    it('reads the durable status from the resident', async () => {
      const { client } = served(
        [{ sequence: 1, kind: 'execution.settled', status: 'succeeded' }],
        { 'GET /v1/jobs/job-1/status': () => jsonResponse({ status: 'running' }) },
      );
      const run = await client.run('flow.nika', HTTP_RUN);

      await expect(run.status()).resolves.toBe('running');
      await run.result();
    });

    it('cancels a native run idempotently and lets the engine name the result', async () => {
      const client = native();
      const run = await client.run('cancel.nika');

      const first = run.cancel();
      expect(run.cancel()).toBe(first);
      await expect(first).resolves.toMatchObject({
        runId: run.id,
        accepted: true,
        status: 'cancellation_requested',
        transport: 'native-process',
      });
      // Acceptance is not a result: the engine's own terminal is.
      await expect(run.result()).resolves.toMatchObject({ status: 'interrupted' });
      expect(run.cancel()).toBe(first);
    });

    it('cancels an HTTP run idempotently with one request', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { client, requests } = serve({
        'POST /v1/jobs': () => jsonResponse({ id: 'job-1', status: 'queued' }, 202),
        'GET /v1/jobs/job-1/events': async () => {
          await held;
          return sseResponse([
            { sequence: 1, kind: 'execution.cancelled', status: 'cancelled' },
          ]);
        },
        'POST /v1/jobs/job-1/cancel': () => jsonResponse({ id: 'job-1', status: 'running' }, 202),
      });
      const run = await client.run('flow.nika', HTTP_RUN);

      const first = run.cancel();
      expect(run.cancel()).toBe(first);
      await expect(first).resolves.toMatchObject({
        accepted: true,
        status: 'cancellation_requested',
        transport: 'http',
      });
      release();
      const kinds = (await collect(run.events())).map((event) => event.kind);
      expect(kinds).toEqual(['run.settled']);
      await expect(run.result()).resolves.toMatchObject({ status: 'cancelled' });
      expect(requests.filter((request) => request.path.endsWith('/cancel'))).toHaveLength(1);
    });

    it('bounds a semantic view like any other view of the one session', async () => {
      const client = native({ eventBufferSize: 8 });
      const run = await client.run('burst.nika');
      const slow = run.events({ bufferSize: 1 })[Symbol.asyncIterator]();
      const fast = collect(run.events({ bufferSize: 8 }));

      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
      await expect(slow.next()).rejects.toBeInstanceOf(NikaEventBufferOverflowError);
      expect(await fast).toHaveLength(8);
      expect(() => run.events({ bufferSize: 9 })).toThrow(RangeError);
    });

    it('treats an events signal as the end of that view, never of the run', async () => {
      const run = await native().run('slow.nika');
      const controller = new AbortController();
      const view = run.events({ signal: controller.signal });
      controller.abort();

      await expect(collect(view)).resolves.toEqual([]);
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
    });
  });

  describe('observation interrupted is a transport error with a cursor', () => {
    it('throws the cursor, keeps the run unfailed, and recovers through attachRun', async () => {
      let resident: 'unreachable' | 'back' = 'unreachable';
      let streams = 0;
      const { client, requests } = serve({
        'POST /v1/jobs': () => jsonResponse({ id: 'job-1', status: 'queued' }, 202),
        'GET /v1/jobs/job-1': () => jsonResponse({ id: 'job-1', status: 'running' }),
        'GET /v1/jobs/job-1/events': () => {
          if (resident === 'back') {
            return sseResponse([
              { sequence: 2, kind: 'execution.settled', status: 'succeeded', outputs: { n: 1 } },
            ]);
          }
          streams += 1;
          if (streams > 1) throw new TypeError('connection reset');
          // One frame arrives, then the body resets mid-stream.
          return sseText(
            sseFrame({ sequence: 1, kind: 'execution.started', status: 'running' }),
            true,
          );
        },
      });
      const run = await client.run('flow.nika', HTTP_RUN);

      const seen: NikaRunEvent[] = [];
      let failure: unknown;
      try {
        for await (const event of run.events()) seen.push(event);
      } catch (cause) {
        failure = cause;
      }

      expect(seen.map((event) => [event.kind, event.sequence])).toEqual([['run.started', 1]]);
      expect(failure).toBeInstanceOf(NikaObservationInterrupted);
      expect(failure).toMatchObject({ transport: 'http', runId: 'job-1', lastSequence: 1 });
      // The observation failed; the run did not. No result claims otherwise.
      const settlement = await run.result().catch((cause: unknown) => cause);
      expect(settlement).toBe(failure);
      expect(settlement).not.toHaveProperty('status', 'failed');

      // A later process holds only the id and the cursor: the one recovery door.
      resident = 'back';
      const recovered = await client.attachRun('job-1', {
        lastEventId: (failure as NikaObservationInterrupted).lastSequence,
      });
      const report = await observe(recovered);

      expect(report).toEqual({
        runId: 'job-1',
        facts: ['run.settled'],
        tasks: [],
        cursor: 2,
        outcome: 'succeeded',
        outputs: { n: 1 },
      });
      expect(requests.at(-1)).toMatchObject({
        path: '/v1/jobs/job-1/events',
        lastEventId: '1',
      });
    }, 20_000);

    it('keeps the engine interrupted evidence apart: a fact and a result, never a throw', async () => {
      // The resident lost the execution and said so. That is the engine's own
      // report about the run, so it is observed and returned as data; only a
      // broken observation (above) throws, and that says nothing of the run.
      const { client } = served([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind: 'execution.interrupted', status: 'interrupted' },
      ]);

      const report = await runToReport(client, 'flow.nika', HTTP_RUN);

      expect(report).toEqual({
        runId: 'job-1',
        facts: ['run.started', 'run.interrupted'],
        tasks: [],
        cursor: 2,
        outcome: 'interrupted',
      });
      // Its settlement is unknown, so nothing called it settled or failed.
      expect(report.facts).not.toContain('run.settled');
    });

    it.each([
      ['execution.cancelled', 'failed'],
      ['execution.cancelled', 'succeeded'],
      ['execution.refused', 'succeeded'],
      ['execution.refused', 'cancelled'],
    ] as const)('leaves a self-contradicting %s carrying %s unnamed', async (kind, status) => {
      // The pair is none a producer defines, so the application is told no
      // lifecycle fact for it. The result is the transport's and still reads
      // the state word the engine wrote; the two never disagree on a name.
      const { client } = served([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind, status },
      ]);

      const run = await client.run('flow.nika', HTTP_RUN);
      const events = await collect(run.events());

      expect(events.map((event) => [event.kind, event.raw.kind, event.sequence])).toEqual([
        ['run.started', 'execution.started', 1],
        ['engine.event', kind, 2],
      ]);
      expect(events[1]).not.toHaveProperty('status');
      await expect(run.result()).resolves.toMatchObject({ status });
    });

    it('hands back a full Run from attachRun, and refuses the door natively', async () => {
      const { client } = serve({
        'GET /v1/jobs/job-1': () => jsonResponse({ id: 'job-1', status: 'running' }),
        'GET /v1/jobs/job-1/events': () => sseResponse([
          { sequence: 5, kind: 'execution.settled', status: 'succeeded' },
        ]),
      });
      const recovered = await client.attachRun('job-1', { lastEventId: 4 });

      expect(Object.keys(recovered).sort()).toEqual([
        'cancel', 'done', 'events', 'id', 'result', 'status',
      ]);
      await expect(recovered.result()).resolves.toMatchObject({ id: 'job-1', status: 'succeeded' });

      // A native process is process-bound: no fake local durability.
      await expect(native().attachRun('job-1')).rejects.toMatchObject({
        name: 'NikaCompatibilityError',
        capability: 'attachRun',
      });
    });
  });

  describe('the deprecated client wrappers, kept for one train', () => {
    it('still streams the protocol vocabulary, frame for frame', async () => {
      const client = native();
      const run = await client.run('wire-0119-hello.nika');

      const legacy = await collect(client.events(run));
      const semantic = await collect(run.events());

      expect(legacy.map((event) => event.kind)).toEqual([
        'workflow_started',
        'task_scheduled',
        'task_started',
        'task_completed',
        'workflow_completed',
        'run_settled',
      ]);
      // One session, one history: the semantic view wraps these very frames.
      expect(semantic.map((event) => event.raw)).toEqual(legacy);
      semantic.forEach((event, index) => expect(event.raw).toBe(legacy[index]));
    });

    it('shares the one memoized cancellation with the handle', async () => {
      const client = native();
      const run = await client.run('cancel.nika');

      const first = run.cancel();
      expect(client.cancel(run)).toBe(first);
      await first;
      await run.result();
    });

    it('delegates status to the same session', async () => {
      const { client } = served(
        [{ sequence: 1, kind: 'execution.settled', status: 'succeeded' }],
        { 'GET /v1/jobs/job-1/status': () => jsonResponse({ status: 'queued' }) },
      );
      const run = await client.run('flow.nika', HTTP_RUN);

      await expect(client.status(run)).resolves.toBe('queued');
      await run.result();
    });
  });

  describe('ownership is unchanged: no silent global registry', () => {
    it('refuses a foreign, a reconstructed, and a serialized handle', async () => {
      const client = native();
      const run = await client.run('ok.nika');
      await run.result();

      const foreign = {
        id: run.id,
        done: run.done,
      } as unknown as NikaRun;
      const reconstructed = { ...run } as NikaRun;
      const serialized = JSON.parse(JSON.stringify(run)) as NikaRun;

      for (const handle of [foreign, reconstructed, serialized]) {
        expect(() => client.events(handle)).toThrow(NikaRunOwnershipError);
        expect(() => client.cancel(handle)).toThrow(NikaRunOwnershipError);
        expect(() => client.status(handle)).toThrow(NikaRunOwnershipError);
      }
      // Only the id survives serialization; the id alone is no handle.
      expect(serialized).toEqual({ id: run.id, done: {} });
    });

    it('refuses a run another client owns', async () => {
      const owner = native();
      const stranger = native();
      const run = await owner.run('ok.nika');

      expect(() => stranger.events(run)).toThrow(NikaRunOwnershipError);
      expect(() => stranger.cancel(run)).toThrow(NikaRunOwnershipError);
      expect(() => stranger.status(run)).toThrow(NikaRunOwnershipError);
      // The owner's handle is unaffected.
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
    });
  });

  describe('types', () => {
    it('types the handle, the semantic event, and the raw frame it keeps', () => {
      type Outputs = { answer: number };
      expectTypeOf<NikaRun<Outputs>['events']>().returns
        .toEqualTypeOf<AsyncIterable<NikaRunEvent<Outputs>>>();
      expectTypeOf<NikaRun<Outputs>['result']>().returns
        .toEqualTypeOf<Promise<NikaRunResult<Outputs>>>();
      expectTypeOf<NikaRun['status']>().returns.toEqualTypeOf<Promise<NikaRunStatus>>();
      expectTypeOf<NikaRun['cancel']>().returns.toEqualTypeOf<Promise<NikaCancelResult>>();
      expectTypeOf<NikaRun['id']>().toEqualTypeOf<NikaRunId>();
      expectTypeOf<NikaRunEvent<Outputs>['raw']>().toEqualTypeOf<NikaEvent<Outputs>>();
      expectTypeOf<'workflow_started'>().not.toMatchTypeOf<NikaRunEventKind>();
      expectTypeOf<'execution.started'>().not.toMatchTypeOf<NikaRunEventKind>();
      expectTypeOf<'run.waiting'>().toMatchTypeOf<NikaRunEventKind>();
    });
  });
});
