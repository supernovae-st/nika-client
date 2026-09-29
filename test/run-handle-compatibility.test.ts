import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaEventBufferOverflowError,
  NikaObservationInterrupted,
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
import { semanticRunEvent } from '../src/lib/run-events.js';
import { RunSession } from '../src/lib/run-session.js';
import type { TransportRun } from '../src/lib/transport.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseFrame,
  sseResponse,
  sseText,
} from './helpers/http-depth-harness.js';

// The run handle as @supernovae-st/nika 0.120.3 published it (SDK main line:
// 22e0c12 the Run owns its lifecycle, 3e43e39 replay after the result,
// e3c379c isNikaRunSucceeded), carried on this line as views of the one
// RunSession that already owned the eager pump and the bounded history:
//
//   run.events()   the lifecycle vocabulary over that same history
//   run.result()   the one terminal promise; `run.done` is that same promise
//   run.status()   the transport's durable status, or a typed refusal
//   run.cancel()   the one memoized request; `nika.cancel(run)` returns it too
//
// A view never admits, dispatches, streams or settles anything of its own.
// Most cases are ported from that line's run-lifecycle, run-events,
// run-replay-capacity and run-result tests. Its measured wire files and its
// `wide<N>` / `frames<K>` native modes are not fixtures of this line, so those
// laws run here over the resident's stream and over a synthetic transport run.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';
const HTTP_RUN = { idempotencyKey: 'compatibility-admission' };
const SYNTHETIC_ID = 'synthetic-run' as NikaRunId;

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

async function collect<Event>(events: AsyncIterable<Event>): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

interface ServeRequest {
  method: string;
  path: string;
  lastEventId: string | null;
}

type Routes = Record<string, (request: ServeRequest) => Response | Promise<Response>>;

/** A resident that answers by route and remembers every request it served. */
function serve(routes: Routes, eventBufferSize?: number): { client: Nika; requests: ServeRequest[] } {
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
    ...(eventBufferSize === undefined ? {} : { eventBufferSize }),
  });
  return { client, requests };
}

/** One admitted by-name job whose observation streams `frames`. */
function served(frames: NikaEvent[], extra: Routes = {}, eventBufferSize?: number) {
  return serve({
    'POST /v1/jobs': () => jsonResponse({ id: 'job-1', status: 'queued' }, 202),
    'GET /v1/jobs/job-1/events': () => sseResponse(frames),
    ...extra,
  }, eventBufferSize);
}

/** One admitted job whose stream is held until the test releases it. */
function held(frames: NikaEvent[], eventBufferSize?: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { client, requests } = serve({
    'POST /v1/jobs': () => jsonResponse({ id: 'job-1', status: 'queued' }, 202),
    'GET /v1/jobs/job-1/events': async () => {
      await gate;
      return sseResponse(frames);
    },
  }, eventBufferSize);
  return { client, requests, release };
}

/** `count` resident frames: running frames, then one succeeded settlement. */
function residentFrames(count: number): NikaEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    kind: index === count - 1 ? 'execution.settled' : 'execution.started',
    status: index === count - 1 ? 'succeeded' : 'running',
  } satisfies NikaEvent));
}

/** What `events()` threw when it refused to open a view. */
function refusal(open: () => unknown): NikaEventBufferOverflowError {
  try {
    open();
  } catch (cause) {
    expect(cause).toBeInstanceOf(NikaEventBufferOverflowError);
    return cause as NikaEventBufferOverflowError;
  }
  throw new Error('events() opened a view it should have refused');
}

/**
 * Over HTTP the result settles on the terminal frame just before the pump
 * hands that frame to the history, so a session may have observed one frame
 * fewer than the run wrote. Wait for the fact through a probe view that is
 * always refused (its bound stays two frames under the total), instead of
 * assuming it.
 */
async function observedAll(run: NikaRun, total: number, probe: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (refusal(() => run.events({ bufferSize: probe })).observed === total) return;
    await settle(5);
  }
  throw new Error(`the session never observed ${total} frames`);
}

/**
 * A transport run whose frames, settlement and actions the test controls and
 * counts. `release` starts the stream; with `holdAfter`, it pauses after that
 * many frames until `resume`, and settles only then.
 */
function synthetic(frames: NikaEvent[], options: { failure?: Error; holdAfter?: number } = {}) {
  const { failure, holdAfter } = options;
  const calls = { streams: 0, cancel: 0, status: 0, cleanup: 0 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const result: NikaRunResult = { id: SYNTHETIC_ID, status: 'succeeded', transport: 'http' };
  const done = gate
    .then(() => (holdAfter === undefined ? undefined : resumed))
    .then(() => {
      if (failure) throw failure;
      return result;
    });
  done.catch(() => {});
  const source: TransportRun = {
    id: SYNTHETIC_ID,
    events: {
      [Symbol.asyncIterator]: async function* stream() {
        calls.streams += 1;
        await gate;
        for (const [index, frame] of frames.entries()) {
          if (index === holdAfter) await resumed;
          yield frame;
        }
        if (failure) throw failure;
      },
    },
    done,
    status: async () => {
      calls.status += 1;
      return 'running';
    },
    cancel: async () => {
      calls.cancel += 1;
      return {
        runId: SYNTHETIC_ID,
        accepted: true,
        status: 'cancellation_requested',
        transport: 'http',
      } satisfies NikaCancelResult;
    },
    cleanup: async () => {
      calls.cleanup += 1;
    },
  };
  return { source, calls, release, resume, result };
}

describe.skipIf(!posix)('the published run handle over the one session', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onStray);
  });
  afterEach(async () => {
    await settle(50);
    process.off('unhandledRejection', onStray);
    expect(stray).toEqual([]);
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

      expect(run.result()).toBe(run.done);
      const result = await run.result();
      expect(result).toMatchObject({ id: run.id, status: 'succeeded', outputs: { answer: 42 } });
      expect(await run.done).toBe(result);
      expect(await run.result()).toBe(result);
      expect(isNikaRunSucceeded(result)).toBe(true);
    });

    it('keeps working when its methods are extracted from the handle', async () => {
      const { events, result, status, cancel } = await native().run('settled.nika');

      const kinds = (await collect(events())).map((event) => event.kind);
      expect(kinds).toEqual(['run.started', 'task.completed', 'engine.event', 'run.settled']);
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
      const run = await native().run('cancel.nika');

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
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { client, requests } = serve({
        'POST /v1/jobs': () => jsonResponse({ id: 'job-1', status: 'queued' }, 202),
        'GET /v1/jobs/job-1/events': async () => {
          await hold;
          return sseResponse([
            { sequence: 1, kind: 'execution.cancelled', status: 'cancelled' },
          ]);
        },
        'POST /v1/jobs/job-1/cancel': () => jsonResponse({ id: 'job-1', status: 'running' }, 202),
      });
      const run = await client.run('flow.nika', HTTP_RUN);

      const first = run.cancel();
      expect(run.cancel()).toBe(first);
      expect(client.cancel(run)).toBe(first);
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

    it('ends only the aborted view; its sibling, the run and the result are untouched', async () => {
      const { client, requests, release } = held(residentFrames(5));
      const run = await client.run('flow.nika', HTTP_RUN);
      const controller = new AbortController();
      const aborted = collect(run.events({ signal: controller.signal }));
      const sibling = collect(run.events());

      controller.abort();
      release();
      await expect(aborted).resolves.toEqual([]);
      expect((await sibling).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
      // An observer's signal is never a cancellation, and never a second stream.
      expect(requests.filter((request) => request.path.endsWith('/cancel'))).toEqual([]);
      expect(requests.filter((request) => request.path.endsWith('/events'))).toHaveLength(1);
    });

    it('stops an aborted view after the frames it already held; the sibling reads on', async () => {
      const { source, calls, release, resume } = synthetic(residentFrames(4), { holdAfter: 2 });
      const run = new RunSession(source, 8, 'http').run;
      const controller = new AbortController();
      const aborted = run.events({ signal: controller.signal })[Symbol.asyncIterator]();
      const sibling = run.events()[Symbol.asyncIterator]();
      const read = async (view: AsyncIterator<NikaRunEvent>) => (await view.next()).value?.sequence;

      release();
      expect(await read(aborted)).toBe(1);
      expect(await read(sibling)).toBe(1);
      // Once the sibling holds frame 2, the one pump handed it to both views.
      expect(await read(sibling)).toBe(2);
      controller.abort();
      // A frame the view already held when it was aborted is still its own;
      // nothing that arrives after the abort reaches it.
      expect(await read(aborted)).toBe(2);
      await expect(aborted.next()).resolves.toEqual({ value: undefined, done: true });
      resume();
      expect(await read(sibling)).toBe(3);
      expect(await read(sibling)).toBe(4);
      await expect(sibling.next()).resolves.toEqual({ value: undefined, done: true });
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
      expect(calls).toMatchObject({ streams: 1, cancel: 0 });
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

  describe('the compatibility doors are views: never a second run, dispatch or stream', () => {
    it('streams the protocol frames through the deprecated door, the very frames run.events() wraps', async () => {
      const client = native();
      const run = await client.run('settled.nika');

      const legacy = await collect(client.events(run));
      const semantic = await collect(run.events());

      expect(legacy.map((event) => event.kind)).toEqual([
        'workflow_started',
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

    it('admits once and streams once over HTTP, whatever mix of views and doors reads it', async () => {
      const { client, requests } = served(
        [
          { sequence: 1, kind: 'execution.started', status: 'running' },
          { sequence: 2, kind: 'execution.settled', status: 'succeeded', outputs: { total: 70 } },
        ],
        { 'POST /v1/jobs/job-1/cancel': () => jsonResponse({ id: 'job-1', status: 'succeeded' }) },
      );
      const run = await client.run<{ total: number }>('flow.nika', HTTP_RUN);

      const lifecycle = await collect(run.events());
      const protocol = await collect(client.events(run));
      const replay = await collect(run.events());
      const result = await run.result();
      const cancellation = run.cancel();
      expect(client.cancel(run)).toBe(cancellation);
      await expect(cancellation).resolves.toMatchObject({ status: 'already_settled' });

      expect(lifecycle.map((event) => [event.kind, event.sequence])).toEqual([
        ['run.started', 1],
        ['run.settled', 2],
      ]);
      expect(replay.map((event) => event.raw)).toEqual(protocol);
      lifecycle.forEach((event, index) => expect(event.raw).toBe(protocol[index]));
      expect(result).toMatchObject({ id: 'job-1', status: 'succeeded', outputs: { total: 70 } });
      expect(await run.done).toBe(result);
      const count = (method: string, route: string) => requests
        .filter((request) => request.method === method && request.path === route).length;
      expect(count('POST', '/v1/jobs')).toBe(1);
      expect(count('GET', '/v1/jobs/job-1/events')).toBe(1);
      expect(count('POST', '/v1/jobs/job-1/cancel')).toBe(1);
    });

    it('pumps a transport run exactly once for every view of both vocabularies', async () => {
      const frames: NikaEvent[] = [
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind: 'execution.settled', status: 'succeeded' },
      ];
      const { source, calls, release, result } = synthetic(frames);
      const session = new RunSession(source, 8, 'http');
      const run = session.run;

      const lifecycle = collect(run.events());
      const protocol = collect(session.events());
      release();
      const [named, raw] = await Promise.all([lifecycle, protocol]);
      const late = await collect(run.events());

      expect(calls.streams).toBe(1);
      expect(raw).toEqual(frames);
      named.forEach((event, index) => expect(event.raw).toBe(frames[index]));
      expect(late.map((event) => event.raw)).toEqual(frames);
      await expect(run.result()).resolves.toBe(result);
      expect(run.result()).toBe(run.done);

      const first = run.cancel();
      expect(session.cancel()).toBe(first);
      await first;
      expect(calls.cancel).toBe(1);
      await expect(run.status()).resolves.toBe('running');
      await expect(session.status()).resolves.toBe('running');
      // Status is the transport's durable read, asked each time; nothing is invented.
      expect(calls.status).toBe(2);
      expect(calls.streams).toBe(1);
    });
  });

  describe('ownership is unchanged: no silent global registry', () => {
    it('refuses a foreign, a reconstructed, and a serialized handle', async () => {
      const client = native();
      const run = await client.run('ok.nika');
      await run.result();

      const foreign = { id: run.id, done: run.done } as unknown as NikaRun;
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

  describe('a failed settlement is data; a failed observation is an error', () => {
    it('resolves an admitted native failure as result data and names the failed task', async () => {
      const run = await native().run<{ boom: null }>('fields-failure.nika');

      const events = await collect(run.events());
      const result = await run.result();

      expect(events.map((event) => event.kind)).toEqual([
        'run.started', 'task.completed', 'task.failed', 'engine.event', 'run.settled',
      ]);
      expect(events[2]).toMatchObject({
        kind: 'task.failed',
        task: 'boom',
        error: { code: 'NIKA-EXEC-001', task: 'boom' },
      });
      expect(events[4]).toMatchObject({ kind: 'run.settled', status: 'failed' });
      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'NIKA-EXEC-001', task: 'boom' },
        outputs: { boom: null },
      });
      expect(isNikaRunSucceeded(result)).toBe(false);
      await expect(run.done).resolves.toBe(result);
    });

    it.each(['succeeded', 'failed', 'paused'] as const)(
      'resolves an HTTP %s settlement without treating partial output as success',
      async (status) => {
        const error = status === 'failed'
          ? { code: 'NIKA-TEST-001', message: 'task failed', task: 'work' } : undefined;
        const { client } = serve({
          'GET /v1/jobs/known-job': () => jsonResponse({ id: 'known-job', status: 'running' }),
          'GET /v1/jobs/known-job/events': () => sseResponse([{
            sequence: 1,
            kind: 'execution.settled',
            status,
            outputs: { answer: 42 },
            settlement: { status, error, cause: status === 'paused' ? 'human_gate' : undefined },
          }]),
        });
        const run = await client.attachRun<{ answer: number }>('known-job');
        const [event] = await collect(run.events());
        const result = await run.result();

        expect(event?.kind).toBe(status === 'paused' ? 'run.waiting' : 'run.settled');
        expect(result.status).toBe(status);
        expect(result.outputs).toEqual({ answer: 42 });
        expect(isNikaRunSucceeded(result)).toBe(status === 'succeeded');
        if (error) expect(result.error).toEqual(error);
      },
    );

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
      await expect(run.done).rejects.toBe(failure);
      expect(settlement).not.toHaveProperty('status', 'failed');

      // A later process holds only the id and the cursor: the one recovery door.
      resident = 'back';
      const recovered = await client.attachRun<{ n: number }>('job-1', {
        lastEventId: (failure as NikaObservationInterrupted).lastSequence,
      });
      const facts = await collect(recovered.events());
      expect(facts.map((event) => [event.kind, event.sequence])).toEqual([['run.settled', 2]]);
      await expect(recovered.result()).resolves.toMatchObject({
        id: 'job-1',
        status: 'succeeded',
        outputs: { n: 1 },
      });
      expect(requests.at(-1)).toMatchObject({
        path: '/v1/jobs/job-1/events',
        lastEventId: '1',
      });
    }, 20_000);

    it('rejects run() itself for a native refusal before the run starts: no handle exists', async () => {
      // The admission boundary the published line states: a refused workflow
      // never yields a handle, so no result() or done could carry it.
      const failure = await native().run('refuse-1709.nika').catch((cause: unknown) => cause);

      expect(failure).toMatchObject({
        name: 'NikaOperationError',
        operation: 'run',
        code: 'NIKA-1709',
        transport: 'native-process',
        status: 2,
      });
    });

    it('fails every view, result() and done with the one transport error', async () => {
      const failure = new Error('transport lost');
      const { source, calls, release } = synthetic(
        [{ sequence: 1, kind: 'execution.started', status: 'running' }],
        { failure },
      );
      const run = new RunSession(source, 8, 'http').run;
      const lifecycle = collect(run.events()).catch((cause: unknown) => cause);
      const second = collect(run.events()).catch((cause: unknown) => cause);

      release();
      expect(await lifecycle).toBe(failure);
      expect(await second).toBe(failure);
      await expect(run.result()).rejects.toBe(failure);
      await expect(run.done).rejects.toBe(failure);
      expect(calls.streams).toBe(1);
      await settle(0);
      expect(calls.cleanup).toBe(1);
    });

    it('keeps the engine interrupted evidence apart: a fact and a result, never a throw', async () => {
      const { client } = served([
        { sequence: 1, kind: 'execution.started', status: 'running' },
        { sequence: 2, kind: 'execution.interrupted', status: 'interrupted' },
      ]);
      const run = await client.run('flow.nika', HTTP_RUN);

      const facts = await collect(run.events());
      expect(facts.map((event) => [event.kind, event.sequence])).toEqual([
        ['run.started', 1],
        ['run.interrupted', 2],
      ]);
      await expect(run.result()).resolves.toMatchObject({ status: 'interrupted' });
    });
  });

  describe('two bounds, two typed refusals, never a silent loss', () => {
    it('replays every frame of a run past the old 256 bound after its result', async () => {
      const { client } = served(residentFrames(273));
      const run = await client.run('flow.nika', HTTP_RUN);
      const result = await run.result();
      await observedAll(run, 273, 271);

      const replayed = await collect(run.events());
      expect(replayed).toHaveLength(273);
      expect(replayed.at(-1)).toMatchObject({ kind: 'run.settled', sequence: 273 });
      expect(await collect(client.events(run))).toHaveLength(273);
      expect(isNikaRunSucceeded(result)).toBe(true);
    });

    it('replays to the frame at the default capacity and refuses one frame past it', async () => {
      const atCapacity = served(residentFrames(4096));
      const full = await atCapacity.client.run('flow.nika', HTTP_RUN);
      await full.result();
      await observedAll(full, 4096, 4094);
      const replayed = await collect(atCapacity.client.events(full));
      expect(replayed).toHaveLength(4096);
      expect(replayed.at(-1)?.kind).toBe('execution.settled');

      const pastCapacity = served(residentFrames(4097));
      const run = await pastCapacity.client.run('flow.nika', HTTP_RUN);
      const result = await run.result();
      await observedAll(run, 4097, 4095);

      expect(refusal(() => run.events())).toMatchObject({
        name: 'NikaEventBufferOverflowError',
        reason: 'replay_truncated',
        runId: 'job-1',
        limit: 4096,
        observed: 4097,
        retained: 4096,
      });
      // The deprecated door refuses the same way; the run is never the casualty.
      expect(refusal(() => pastCapacity.client.events(run))).toMatchObject({
        reason: 'replay_truncated',
        observed: 4097,
        retained: 4096,
      });
      expect(isNikaRunSucceeded(result)).toBe(true);
      await expect(run.result()).resolves.toBe(result);
    });

    it('still refuses a 273-frame replay under an explicit 256, and says why', async () => {
      const { client } = served(residentFrames(273), {}, 256);
      const run = await client.run('flow.nika', HTTP_RUN);
      const result = await run.result();
      await observedAll(run, 273, 256);

      const refused = refusal(() => run.events());
      expect(refused).toMatchObject({
        reason: 'replay_truncated',
        limit: 256,
        observed: 273,
        retained: 256,
      });
      // It names the history, not a subscriber that never existed, and it
      // says the run is fine and how to see the frames next time.
      expect(refused.message).not.toMatch(/subscriber/i);
      expect(refused.message).toMatch(/273/);
      expect(refused.message).toMatch(/eventBufferSize/);
      await expect(run.done).resolves.toBe(result);
    });

    it('refuses a late view smaller than an intact history, and loses nothing by it', async () => {
      const { client } = served(residentFrames(273), {}, 300);
      const run = await client.run('flow.nika', HTTP_RUN);
      await run.result();
      await observedAll(run, 273, 100);

      // The session kept all 273 frames; only this view's bound is too small.
      expect(refusal(() => client.events(run, { bufferSize: 100 }))).toMatchObject({
        reason: 'replay_truncated',
        limit: 100,
        observed: 273,
        retained: 273,
      });
      // `retained === observed` says a larger view can still have everything.
      expect(await collect(run.events({ bufferSize: 273 }))).toHaveLength(273);
      expect(() => run.events({ bufferSize: 301 })).toThrow(RangeError);
    });

    it('names a late refusal on a reattached job the same way', async () => {
      const replay = residentFrames(5);
      const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const route = new URL(String(input)).pathname;
        if (route === '/health') return healthResponse();
        if (route === '/v1/jobs/job-1') return jsonResponse({ id: 'job-1', status: 'running' });
        if (route === '/v1/jobs/job-1/events') {
          // A resident replays what follows the cursor it is given.
          const cursor = Number(new Headers(init?.headers).get('Last-Event-ID') ?? 0);
          return sseResponse(replay.filter((event) => Number(event.sequence) > cursor));
        }
        throw new Error(`unexpected ${route}`);
      };
      const client = new Nika({
        url: 'https://nika.example',
        token: TOKEN_A,
        bin: HTTP_DEPTH_FIXTURE,
        fetch: fetch as typeof globalThis.fetch,
        eventBufferSize: 2,
      });
      const run = await client.attachRun('job-1');
      const result = await run.result();
      await observedAll(run, 5, 2);

      expect(refusal(() => run.events())).toMatchObject({
        reason: 'replay_truncated',
        runId: 'job-1',
        limit: 2,
        observed: 5,
        retained: 2,
      });
      expect(result).toMatchObject({ status: 'succeeded' });
      // The resident still holds the job: recovery is attachRun, not this view.
      const again = await client.attachRun('job-1', { lastEventId: 3 });
      expect((await collect(again.events())).map((event) => event.sequence)).toEqual([4, 5]);
    });

    it('fails a live bufferSize 1 view that fell behind, and nothing else', async () => {
      const client = native();
      const run = await client.run('burst.nika');
      const slow = run.events({ bufferSize: 1 })[Symbol.asyncIterator]();
      const reading = collect(client.events(run));

      const result = await run.result();
      const failure = await slow.next().then(() => slow.next()).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(NikaEventBufferOverflowError);
      expect(failure).toMatchObject({
        reason: 'live_backpressure',
        runId: run.id,
        limit: 1,
      });
      // A live view was never promised a replay: it names no history.
      expect(failure).not.toHaveProperty('observed');
      expect(failure).not.toHaveProperty('retained');
      expect((failure as Error).message).toMatch(/subscriber/i);
      // The view that kept reading, and the result, are untouched.
      expect(await reading).toHaveLength(8);
      expect(isNikaRunSucceeded(result)).toBe(true);
    });

    it('still protects a default live view, at the default bound and to the frame', async () => {
      // A view that never reads holds exactly its bound: 4096 frames fit.
      const fits = held(residentFrames(4096));
      const full = await fits.client.run('flow.nika', HTTP_RUN);
      const idle = full.events();
      fits.release();
      await full.result();
      expect(await collect(idle)).toHaveLength(4096);

      // One frame more and the live view fails typed; it is never shortened.
      const overflows = held(residentFrames(4097));
      const run = await overflows.client.run('flow.nika', HTTP_RUN);
      const stalled = run.events()[Symbol.asyncIterator]();
      overflows.release();
      const result = await run.result();
      await observedAll(run, 4097, 4095);
      const failure = await stalled.next().catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(NikaEventBufferOverflowError);
      expect(failure).toMatchObject({ reason: 'live_backpressure', limit: 4096 });
      expect(isNikaRunSucceeded(result)).toBe(true);
    });
  });
});

describe('the lifecycle projection (ported from the published run-events test)', () => {
  it.each([
    [{ sequence: 1, kind: 'execution.started', status: 'running' }, 'run.started', 'running'],
    [{ sequence: 2, kind: 'execution.settled', status: 'succeeded' }, 'run.settled', 'succeeded'],
    [{ sequence: 2, kind: 'execution.settled', status: 'failed' }, 'run.settled', 'failed'],
    [{ sequence: 2, kind: 'execution.settled', status: 'cancelled' }, 'run.settled', 'cancelled'],
    [{ sequence: 2, kind: 'execution.cancelled', status: 'cancelled' }, 'run.settled', 'cancelled'],
    [{ sequence: 2, kind: 'execution.refused', status: 'failed' }, 'run.settled', 'failed'],
    [{ sequence: 2, kind: 'execution.settled', status: 'paused' }, 'run.waiting', 'paused'],
    [{ sequence: 2, kind: 'execution.interrupted', status: 'interrupted' }, 'run.interrupted', 'interrupted'],
    [{ sequence: 2, kind: 'interrupted', status: 'interrupted' }, 'run.interrupted', 'interrupted'],
  ] as const)('%j is %s', (raw, kind, status) => {
    const event = semanticRunEvent(raw, 'http');

    expect(event).toMatchObject({ kind, status, transport: 'http', sequence: raw.sequence });
    expect(event.raw).toBe(raw);
  });

  it.each([
    [{ kind: 'workflow_started' }, 'run.started'],
    [{ kind: 'task_scheduled', fields: [{ key: 'task', value: 'a' }] }, 'task.scheduled'],
    [{ kind: 'task_started', fields: [{ key: 'task', value: 'a' }] }, 'task.started'],
    [{ kind: 'task_completed', fields: [{ key: 'task', value: 'a' }] }, 'task.completed'],
    [{ kind: 'run_settled', status: 'paused' }, 'run.waiting'],
    [{ kind: 'workflow_interrupted', status: 'interrupted' }, 'run.interrupted'],
    [{ kind: 'run_sealed' }, 'run.sealed'],
  ] as unknown as [NikaEvent, NikaRunEventKind][])('native %j is %s', (raw, kind) => {
    const event = semanticRunEvent(raw, 'native-process');

    expect(event.kind).toBe(kind);
    expect(event.raw).toBe(raw);
    expect(event).not.toHaveProperty('sequence');
    if (kind.startsWith('task.')) expect(event.task).toBe('a');
  });

  it.each([
    ['execution.refused', 'succeeded'],
    ['execution.refused', 'cancelled'],
    ['execution.cancelled', 'succeeded'],
    ['execution.cancelled', 'failed'],
  ])('%s with %s contradicts its own kind and is not settled', (kind, status) => {
    const raw = {
      sequence: 3,
      kind,
      status,
      code: 'NIKA-X',
      message: 'words, not a verdict',
    } as NikaEvent;
    const event = semanticRunEvent(raw, 'http');

    expect(event.kind).toBe('engine.event');
    expect(event.raw).toBe(raw);
    expect(Object.keys(event).sort()).toEqual(['kind', 'raw', 'sequence', 'transport']);
  });

  it.each([
    ['an absent status', {}],
    ['a null status', { status: null }],
    ['a future status', { status: 'archived' }],
    ['a running status', { status: 'running' }],
    ['an interrupted status', { status: 'interrupted' }],
  ] as const)('a settlement frame with %s is not settled', (_label, state) => {
    for (const kind of ['run_settled', 'execution.settled']) {
      const raw = { kind, sequence: 3, ...state } as unknown as NikaEvent;
      const event = semanticRunEvent(raw, 'http');

      expect(event.kind).toBe('engine.event');
      expect(event).not.toHaveProperty('error');
    }
  });

  it('carries the failure the resident named, and none on a settlement that did not fail', () => {
    expect(semanticRunEvent({
      sequence: 2,
      kind: 'execution.settled',
      status: 'failed',
      settlement: {
        status: 'failed',
        cause: 'task_failed',
        error: { code: 'NIKA-EXEC-001', message: 'exited 1', task: 'build' },
      },
    }, 'http')).toMatchObject({
      kind: 'run.settled',
      status: 'failed',
      error: { code: 'NIKA-EXEC-001', task: 'build' },
    });
    expect(semanticRunEvent({
      kind: 'execution.settled',
      status: 'cancelled',
      code: 'operator',
      message: 'cancelled by the operator',
    } as NikaEvent, 'http')).not.toHaveProperty('error');
  });

  it('keeps hostile and unknown kinds as unnamed engine events with the cursor intact', () => {
    for (const raw of [
      { kind: 'permit_checked' },
      { kind: 'constructor' },
      { kind: '__proto__' },
      { kind: 'hasOwnProperty', status: 'paused' },
      {},
    ] as unknown as NikaEvent[]) {
      const event = semanticRunEvent(raw, 'http');
      expect(event.kind).toBe('engine.event');
      expect(event.raw).toBe(raw);
      expect(Object.isFrozen(event)).toBe(true);
    }
    expect(semanticRunEvent({ sequence: 7, kind: 'execution.custom', status: null }, 'http'))
      .toEqual({
        kind: 'engine.event',
        transport: 'http',
        sequence: 7,
        raw: { sequence: 7, kind: 'execution.custom', status: null },
      });
  });
});

describe('the success guard (ported from the published run-result test)', () => {
  const id = 'result-fixture' as NikaRunId;

  it.each(['failed', 'paused', 'cancelled', 'interrupted', 'running', 'queued', 'future-status'])(
    'does not mistake %s with partial outputs for success', (status) => {
      const result: NikaRunResult<{ answer: number }> = {
        id, status, transport: 'http', outputs: { answer: 42 },
      };
      const before = structuredClone(result);
      expect(isNikaRunSucceeded(result)).toBe(false);
      expect(result).toEqual(before);
    },
  );

  it('accepts a successful run without inventing outputs', () => {
    const result: NikaRunResult = { id, status: 'succeeded', transport: 'native-process' };
    expect(isNikaRunSucceeded(result)).toBe(true);
    expect(result).not.toHaveProperty('outputs');
  });
});

describe('types', () => {
  it('types the handle, the semantic event, the raw frame it keeps, and the alias', () => {
    type Outputs = { answer: number };
    expectTypeOf<NikaRun<Outputs>['events']>().returns
      .toEqualTypeOf<AsyncIterable<NikaRunEvent<Outputs>>>();
    expectTypeOf<NikaRun<Outputs>['result']>().returns
      .toEqualTypeOf<Promise<NikaRunResult<Outputs>>>();
    expectTypeOf<NikaRun<Outputs>['done']>().toEqualTypeOf<Promise<NikaRunResult<Outputs>>>();
    expectTypeOf<NikaRun['status']>().returns.toEqualTypeOf<Promise<NikaRunStatus>>();
    expectTypeOf<NikaRun['cancel']>().returns.toEqualTypeOf<Promise<NikaCancelResult>>();
    expectTypeOf<NikaRun['id']>().toEqualTypeOf<NikaRunId>();
    expectTypeOf<NikaRunEvent<Outputs>['raw']>().toEqualTypeOf<NikaEvent<Outputs>>();
    expectTypeOf<'workflow_started'>().not.toMatchTypeOf<NikaRunEventKind>();
    expectTypeOf<'execution.started'>().not.toMatchTypeOf<NikaRunEventKind>();
    expectTypeOf<'run.waiting'>().toMatchTypeOf<NikaRunEventKind>();
    expectTypeOf<NikaEventBufferOverflowError['reason']>()
      .toEqualTypeOf<'live_backpressure' | 'replay_truncated'>();
  });
});
