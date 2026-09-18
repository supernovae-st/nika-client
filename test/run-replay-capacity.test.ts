import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Nika, NikaEventBufferOverflowError, isNikaRunSucceeded } from '../src/index.js';
import type { NikaEvent, NikaLocalConfig, NikaRunEvent } from '../src/index.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseResponse,
} from './helpers/http-depth-harness.js';

// Issue #122 · a run that succeeded must stay observable after the fact.
//
// A clean native run writes 3 frames per task plus 3 for the workflow
// (`3N + 3`), measured on the released 0.118.7 payload: 90 mock/echo tasks are
// 273 frames. The old default retained 256, so `await run.result()` followed
// by `run.events()` refused on a green run.
//
// Two different bounds can be exceeded, and they must never read alike:
//
//   live_backpressure  a LIVE view fell more than its bound behind the stream
//   replay_truncated   a LATE view cannot be given everything it missed
//
// Neither is ever answered by silently skipping frames, and neither touches
// the run or its result. `wide<N>` reproduces the measured cardinality and
// order; `frames<K>` is a synthetic exact count for boundary tests.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';

/** The measured native cardinality of a clean run of `tasks` tasks. */
const nativeFrames = (tasks: number): number => 3 * tasks + 3;

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

function tally(kinds: (string | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of kinds) counts[String(kind)] = (counts[String(kind)] ?? 0) + 1;
  return counts;
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

describe.skipIf(!posix)('late replay capacity (issue #122)', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onStray);
  });
  afterEach(async () => {
    await settle(50);
    process.off('unhandledRejection', onStray);
    expect(stray).toEqual([]);
  });

  describe('the default client', () => {
    it('replays every frame of a 90-task run observed only after its result', async () => {
      const client = native();
      const run = await client.run('wide90.nika.yaml');
      const result = await run.result();
      expect(isNikaRunSucceeded(result)).toBe(true);

      const lifecycle: NikaRunEvent[] = await collect(run.events());
      const protocol: NikaEvent[] = await collect(client.events(run));

      // The count is derived from what the producer wrote, not assumed.
      expect(nativeFrames(90)).toBe(273);
      expect(protocol).toHaveLength(273);
      expect(lifecycle).toHaveLength(273);
      expect(tally(protocol.map((event) => event.kind))).toEqual({
        workflow_started: 1,
        task_scheduled: 90,
        task_started: 90,
        task_completed: 90,
        workflow_completed: 1,
        run_settled: 1,
      });
      expect(tally(lifecycle.map((event) => event.kind))).toEqual({
        'run.started': 1,
        'task.scheduled': 90,
        'task.started': 90,
        'task.completed': 90,
        'engine.event': 1,
        'run.settled': 1,
      });
      // Nothing omitted and nothing reordered: the late view is the history.
      lifecycle.forEach((event, index) => expect(event.raw).toBe(protocol[index]));
      expect(protocol.at(0)?.kind).toBe('workflow_started');
      expect(protocol.at(-1)?.kind).toBe('run_settled');
    });

    it('replays a run of hundreds of tasks after its result', async () => {
      const client = native();
      const run = await client.run('wide1000.nika.yaml');
      await run.result();

      const kinds = (await collect(client.events(run))).map((event) => event.kind);
      expect(kinds).toHaveLength(nativeFrames(1000));
      expect(tally(kinds)).toMatchObject({ task_scheduled: 1000, task_completed: 1000 });
    });

    it('leaves a 1-task run exactly as it was', async () => {
      const client = native();
      const run = await client.run('wide1.nika.yaml');
      await run.result();

      expect((await collect(client.events(run))).map((event) => event.kind)).toEqual([
        'workflow_started',
        'task_scheduled',
        'task_started',
        'task_completed',
        'workflow_completed',
        'run_settled',
      ]);
    });

    it('replays to the frame at its capacity and refuses one frame past it', async () => {
      const client = native();
      const atCapacity = await client.run('frames4096.nika.yaml');
      await atCapacity.result();
      const replayed = await collect(client.events(atCapacity));
      expect(replayed).toHaveLength(4096);
      expect(replayed.at(-1)?.kind).toBe('run_settled');

      const pastCapacity = await client.run('frames4097.nika.yaml');
      const result = await pastCapacity.result();
      const refused = refusal(() => client.events(pastCapacity));

      expect(refused).toMatchObject({
        reason: 'replay_truncated',
        runId: pastCapacity.id,
        limit: 4096,
        observed: 4097,
        retained: 4096,
      });
      // The bound is never Infinity, and the run is never the casualty.
      expect(isNikaRunSucceeded(result)).toBe(true);
      await expect(pastCapacity.result()).resolves.toBe(result);
    });
  });

  describe('an explicit eventBufferSize keeps its cap', () => {
    it('still refuses a 273-frame replay under an explicit 256, and says why', async () => {
      const client = native({ eventBufferSize: 256 });
      const run = await client.run('wide90.nika.yaml');
      const result = await run.result();

      const refused = refusal(() => run.events());
      expect(refused).toMatchObject({
        name: 'NikaEventBufferOverflowError',
        reason: 'replay_truncated',
        runId: run.id,
        limit: 256,
        observed: 273,
        retained: 256,
      });
      // It names the history, not a subscriber that never existed, and it
      // says the run is fine and how to see the frames next time.
      expect(refused.message).not.toMatch(/subscriber/i);
      expect(refused.message).toMatch(/273/);
      expect(refused.message).toMatch(/eventBufferSize/);
      // The deprecated wrapper refuses the same way.
      expect(refusal(() => client.events(run))).toMatchObject({
        reason: 'replay_truncated',
        limit: 256,
        observed: 273,
        retained: 256,
      });
      // A refused replay never poisons the result.
      expect(isNikaRunSucceeded(result)).toBe(true);
      await expect(run.result()).resolves.toBe(result);
      await expect(run.done).resolves.toBe(result);
    });

    it.each([
      [273, 'replays'],
      [272, 'refuses'],
    ] as const)('under an explicit %i a 273-frame run %s', async (eventBufferSize, outcome) => {
      const client = native({ eventBufferSize });
      const run = await client.run('wide90.nika.yaml');
      await run.result();

      if (outcome === 'replays') {
        expect(await collect(client.events(run))).toHaveLength(273);
        return;
      }
      expect(refusal(() => client.events(run))).toMatchObject({
        reason: 'replay_truncated',
        limit: 272,
        observed: 273,
        retained: 272,
      });
    });

    it('refuses a late view smaller than an intact history, and loses nothing by it', async () => {
      const client = native({ eventBufferSize: 300 });
      const run = await client.run('wide90.nika.yaml');
      await run.result();

      // The session kept all 273 frames; only this view's bound is too small.
      expect(refusal(() => client.events(run, { bufferSize: 100 }))).toMatchObject({
        reason: 'replay_truncated',
        limit: 100,
        observed: 273,
        retained: 273,
      });
      // `retained === observed` says a larger view can still have everything.
      expect(await collect(client.events(run, { bufferSize: 273 }))).toHaveLength(273);
      expect(() => client.events(run, { bufferSize: 301 })).toThrow(RangeError);
    });
  });

  describe('the same law over HTTP', () => {
    it('names a late refusal on a reattached job the same way', async () => {
      const replay = Array.from({ length: 5 }, (_, index) => ({
        sequence: index + 1,
        kind: index === 4 ? 'execution.settled' : 'execution.started',
        status: index === 4 ? 'succeeded' : 'running',
      } satisfies NikaEvent));
      const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const route = new URL(String(input)).pathname;
        if (route === '/health') return healthResponse();
        if (route === '/v1/jobs/job-1') return jsonResponse({ id: 'job-1', status: 'running' });
        if (route === '/v1/jobs/job-1/events') {
          // A resident replays what follows the cursor it is given.
          const cursor = Number(new Headers(init?.headers).get('Last-Event-ID') ?? 0);
          return sseResponse(replay.filter((event) => event.sequence > cursor));
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

      // `observed` is a snapshot taken when the view is opened. Over HTTP the
      // result settles on the terminal frame just before that frame reaches
      // the history, so wait for the fact instead of assuming it.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (refusal(() => run.events()).observed === 5) break;
        await settle(5);
      }

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
  });

  describe('live backpressure is a different refusal', () => {
    it('fails a bufferSize 1 view that fell behind, and nothing else', async () => {
      const client = native();
      const run = await client.run('wide90.nika.yaml');
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
      expect(await reading).toHaveLength(273);
      expect(isNikaRunSucceeded(result)).toBe(true);
    });

    it('still protects a default live view, at the default bound and to the frame', async () => {
      const client = native();
      // A view that never reads holds exactly its bound: 4096 frames fit.
      const fits = await client.run('frames4096.nika.yaml');
      const idle = fits.events();
      await fits.result();
      expect(await collect(idle)).toHaveLength(4096);

      // One frame more and the live view fails typed; it is never shortened.
      const overflows = await client.run('frames4097.nika.yaml');
      const stalled = overflows.events()[Symbol.asyncIterator]();
      const result = await overflows.result();
      const failure = await stalled.next().catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(NikaEventBufferOverflowError);
      expect(failure).toMatchObject({ reason: 'live_backpressure', limit: 4096 });
      expect(isNikaRunSucceeded(result)).toBe(true);
    });
  });
});
