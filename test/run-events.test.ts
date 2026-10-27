import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { semanticRunEvent } from '../src/lib/run-events.js';
import type { NikaEvent, NikaRunEventKind } from '../src/index.js';

// Issue #117 · one lifecycle vocabulary over two protocols. The adapter is a
// pure projection of one protocol frame: it names the fact the engine wrote,
// keeps the frame itself on `raw`, and never writes a fact of its own.
//
// Native frames below are measured bytes (fixtures/run-wire/README.md). The
// HTTP frames are the resident's closed `JobEvent` projection as the release
// evidence measured it: `execution.*` kinds, no per-task frames.

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SEMANTIC_KINDS: ReadonlySet<NikaRunEventKind> = new Set([
  'run.started',
  'task.scheduled',
  'task.started',
  'task.completed',
  'task.failed',
  'task.skipped',
  'task.cancelled',
  'task.cache_hit',
  'run.waiting',
  'run.settled',
  'run.interrupted',
  'run.sealed',
  'engine.event',
]);

function wire(name: string): NikaEvent[] {
  return readFileSync(path.join(HERE, 'fixtures', 'run-wire', name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as NikaEvent);
}

function native(frames: NikaEvent[]) {
  return frames.map((frame) => semanticRunEvent(frame, 'native-process'));
}

describe('semantic run events over measured native frames', () => {
  it('names every frame of the released hello run', () => {
    const events = native(wire('0.119.0-hello.ndjson.stdout'));

    expect(events.map((event) => event.kind)).toEqual([
      'run.started',
      'task.scheduled',
      'task.started',
      'task.completed',
      'engine.event',
      'run.settled',
    ]);
    expect(events.map((event) => event.raw.kind)).toEqual([
      'workflow_started',
      'task_scheduled',
      'task_started',
      'task_completed',
      'workflow_completed',
      'run_settled',
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'run.settled', status: 'succeeded' });
    expect(events.every((event) => event.transport === 'native-process')).toBe(true);
  });

  it('lifts the task and the engine error a failed task named in its field rows', () => {
    const events = native(wire('0.119.0-admitted-failure.ndjson.stdout'));

    expect(events.map((event) => event.kind)).toEqual([
      'run.started',
      'task.scheduled',
      'task.started',
      'engine.event',
      'task.failed',
      'engine.event',
      'run.settled',
    ]);
    const failedTask = events.find((event) => event.kind === 'task.failed');
    expect(failedTask).toMatchObject({
      task: 'fail',
      error: { code: 'NIKA-BUILTIN-ASSERT-001', task: 'fail' },
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'run.settled',
      status: 'failed',
      error: { code: 'NIKA-BUILTIN-ASSERT-001', task: 'fail' },
    });
  });

  it('names a skipped and a cancelled task over measured 0.123.2 frames', () => {
    // One task skipped by `on_error: { skip: true }`, one recovered by
    // `on_error: { recover: … }`, one cancelled because its `after:` edge
    // never admitted. Each of the three tasks ends on one named word.
    const events = native(wire('0.123.2-skipped-cancelled.ndjson.stdout'));

    expect(events.map((event) => [event.kind, event.raw.kind, event.task])).toEqual([
      ['run.started', 'workflow_started', undefined],
      ['task.scheduled', 'task_scheduled', 'skipped_one'],
      ['task.scheduled', 'task_scheduled', 'recovered_one'],
      ['task.scheduled', 'task_scheduled', 'cancelled_one'],
      ['task.started', 'task_started', 'skipped_one'],
      ['engine.event', 'permit_checked', undefined],
      ['task.skipped', 'task_skipped', 'skipped_one'],
      ['task.started', 'task_started', 'recovered_one'],
      ['engine.event', 'permit_checked', undefined],
      // The recovery is a journal fact; the task's ending is its completion.
      ['engine.event', 'task_recovered', undefined],
      ['task.completed', 'task_completed', 'recovered_one'],
      ['task.cancelled', 'task_cancelled', 'cancelled_one'],
      ['engine.event', 'workflow_completed', undefined],
      ['run.settled', 'run_settled', undefined],
    ]);

    const TERMINAL = new Set<NikaRunEventKind>([
      'task.completed',
      'task.failed',
      'task.skipped',
      'task.cancelled',
    ]);
    const endings = events.filter((event) => TERMINAL.has(event.kind));
    expect(endings.map((event) => [event.task, event.kind])).toEqual([
      ['skipped_one', 'task.skipped'],
      ['recovered_one', 'task.completed'],
      ['cancelled_one', 'task.cancelled'],
    ]);

    for (const kind of ['task.skipped', 'task.cancelled'] as const) {
      const event = events.find((candidate) => candidate.kind === kind)!;
      // A skip or a cancellation names its task, never a failure or a state:
      // `event.error` belongs to a failed task or a failed settlement only.
      expect(Object.keys(event).sort()).toEqual(['kind', 'raw', 'task', 'transport']);
      expect(typeof event.task).toBe('string');
      expect(event.error).toBeUndefined();
      expect(event.status).toBeUndefined();
    }

    // A skip under `on_error: { skip: true }` keeps the error that made it
    // skip: the engine leaves it on `raw`, in the frame's `outcome` row.
    const skipped = events.find((event) => event.kind === 'task.skipped')!;
    const rows = (skipped.raw as unknown as { fields: { key: string; value: unknown }[] })
      .fields;
    const outcome = rows.find((row) => row.key === 'outcome');
    expect(typeof outcome?.value).toBe('string');
    expect(JSON.parse(outcome!.value as string)).toMatchObject({
      cause: 'error_skip',
      class: 'skipped',
      payload: { error: { code: 'NIKA-BUILTIN-ASSERT-001', transient: false } },
    });

    const recovered = events.find((event) => event.raw.kind === 'task_recovered')!;
    expect(Object.keys(recovered).sort()).toEqual(['kind', 'raw', 'transport']);

    expect(events.at(-1)).toMatchObject({ kind: 'run.settled', status: 'succeeded' });
    expect(events.at(-1)!.error).toBeUndefined();
    expect(events.at(-1)!.raw).toMatchObject({
      kind: 'run_settled',
      cause: 'normal',
      tasks: { total: 3, ok: 1, recovered: 1, skipped: 1, cancelled: 1, failed: 0 },
    });
  });

  it('names a task a resumed run reused over measured 0.123.2 frames', () => {
    // `publish` failed in a first run; `nika run --resume` of that run's
    // trace, with `--var ready=true`, reused `prepare`, whose identity matched
    // its recorded success, and ran `publish` live. The package itself never
    // resumes a run: this is the engine's frame, as any resumed run writes it.
    const events = native(wire('0.123.2-cache-hit.ndjson.stdout'));

    expect(events.map((event) => [event.kind, event.raw.kind, event.task])).toEqual([
      ['run.started', 'workflow_started', undefined],
      ['task.scheduled', 'task_scheduled', 'prepare'],
      ['task.scheduled', 'task_scheduled', 'publish'],
      // Reused, never started: the cache hit is the task's one ending.
      ['task.cache_hit', 'task_cache_hit', 'prepare'],
      ['task.started', 'task_started', 'publish'],
      ['engine.event', 'permit_checked', undefined],
      ['task.completed', 'task_completed', 'publish'],
      ['engine.event', 'workflow_completed', undefined],
      ['run.settled', 'run_settled', undefined],
    ]);

    const hit = events.find((event) => event.kind === 'task.cache_hit')!;
    // A reuse names its task, never a failure or a state.
    expect(Object.keys(hit).sort()).toEqual(['kind', 'raw', 'task', 'transport']);
    // The identity it matched and the output it reused stay on `raw`, in its rows.
    const rows = (hit.raw as unknown as { fields: { key: string; value: unknown }[] }).fields;
    const row = (key: string) => rows.find((candidate) => candidate.key === key)?.value;
    expect(rows.map((candidate) => candidate.key)).toEqual([
      'task', 'note', 'def_hash', 'input_hash', 'output', 'outcome',
    ]);
    expect(row('note')).toBe('cache hit');
    expect(row('def_hash')).toMatch(/^[0-9a-f]{64}$/);
    expect(row('input_hash')).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(row('output') as string)).toBe(true);
    expect(JSON.parse(row('outcome') as string)).toEqual({
      cause: 'normal',
      class: 'success',
      payload: { attempts: 1, value: true },
    });

    // The run counts the reused task as an ordinary success.
    expect(events.at(-1)).toMatchObject({ kind: 'run.settled', status: 'succeeded' });
    expect(events.at(-1)!.raw).toMatchObject({
      kind: 'run_settled',
      cause: 'normal',
      tasks: { total: 2, ok: 2, failed: 0, skipped: 0 },
    });
  });

  it('reads a human gate as waiting: never settled, never failed', () => {
    const events = native(wire('0.118.7-human-gate.ndjson.stdout'));

    expect(events.map((event) => event.kind)).toEqual([
      'run.started',
      'task.scheduled',
      'engine.event',
      'run.waiting',
    ]);
    const waiting = events.at(-1)!;
    // The engine's own state word survives; the SDK renames no status.
    expect(waiting.status).toBe('paused');
    expect(waiting.error).toBeUndefined();
    expect(waiting.raw).toMatchObject({ kind: 'run_settled', cause: 'human_gate' });
    expect(events.some((event) => event.kind === 'run.settled')).toBe(false);
    // The journal's own pause frame keeps flowing, unnamed and untouched.
    expect(events[2]!.raw.kind).toBe('workflow_paused');
  });

  it('reads an operator cancellation as one settlement carrying the engine word', () => {
    const events = native(wire('0.118.7-sigterm-cancel.ndjson.stdout'));

    expect(events.map((event) => event.kind)).toEqual([
      'run.started',
      'task.scheduled',
      'task.started',
      'engine.event',
      'task.completed',
      'engine.event',
      'run.settled',
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'run.settled', status: 'cancelled' });
    expect(events.at(-1)!.raw).toMatchObject({ kind: 'run_settled', cause: 'operator' });
  });

  it('names the seal and the interruption frames the native process can write', () => {
    expect(semanticRunEvent({ kind: 'run_sealed', receipt: { sealed: true } }, 'native-process'))
      .toMatchObject({ kind: 'run.sealed' });
    expect(semanticRunEvent(
      { kind: 'workflow_interrupted', status: 'interrupted' },
      'native-process',
    )).toMatchObject({ kind: 'run.interrupted', status: 'interrupted' });
  });

  it('never reads a native frame field as a durable cursor', () => {
    const event = semanticRunEvent({ kind: 'task_completed', sequence: 3 }, 'native-process');

    expect(event.kind).toBe('task.completed');
    expect(event).not.toHaveProperty('sequence');
    expect(event.raw.sequence).toBe(3);
  });
});

describe('semantic run events over the resident projection', () => {
  it.each([
    [{ sequence: 1, kind: 'execution.started', status: 'running' }, 'run.started', 'running'],
    [{ sequence: 2, kind: 'execution.settled', status: 'succeeded' }, 'run.settled', 'succeeded'],
    [{ sequence: 2, kind: 'execution.settled', status: 'failed' }, 'run.settled', 'failed'],
    // Both kinds are the ratified winner of one cancelled fact.
    [{ sequence: 2, kind: 'execution.settled', status: 'cancelled' }, 'run.settled', 'cancelled'],
    [{ sequence: 2, kind: 'execution.cancelled', status: 'cancelled' }, 'run.settled', 'cancelled'],
    // Refused after admission is a failed result, not a thrown error.
    [{ sequence: 2, kind: 'execution.refused', status: 'failed' }, 'run.settled', 'failed'],
    [{ sequence: 2, kind: 'execution.settled', status: 'paused' }, 'run.waiting', 'paused'],
    [{ sequence: 2, kind: 'execution.interrupted', status: 'interrupted' }, 'run.interrupted', 'interrupted'],
    [{ sequence: 2, kind: 'interrupted', status: 'interrupted' }, 'run.interrupted', 'interrupted'],
  ] as const)('%j is %s', (raw, kind, status) => {
    const event = semanticRunEvent(raw, 'http');

    expect(event).toMatchObject({ kind, status, transport: 'http', sequence: raw.sequence });
    expect(event.raw).toBe(raw);
  });

  it('yields no task event for a server run: the resident streams no per-task frame', () => {
    // The same three-task shape as the native 0.123.2 capture, as a server
    // job streams it: its settlement counts the skipped and cancelled tasks,
    // and the SDK synthesizes no `task.*` event out of those counts.
    const events = [
      { sequence: 1, kind: 'execution.queued', status: 'queued' },
      { sequence: 2, kind: 'execution.started', status: 'running' },
      {
        sequence: 3,
        kind: 'execution.settled',
        status: 'succeeded',
        settlement: {
          status: 'succeeded',
          cause: 'normal',
          tasks: { total: 3, ok: 1, recovered: 1, skipped: 1, cancelled: 1, failed: 0 },
        },
      },
    ].map((frame) => semanticRunEvent(frame as NikaEvent, 'http'));

    expect(events.map((event) => event.kind)).toEqual([
      'engine.event',
      'run.started',
      'run.settled',
    ]);
    expect(events.some((event) => event.kind.startsWith('task.'))).toBe(false);
    expect(events.some((event) => event.task !== undefined)).toBe(false);
  });

  it('names the interrupted evidence state, never a settlement', () => {
    const event = semanticRunEvent(
      { sequence: 4, kind: 'execution.interrupted', status: 'interrupted' },
      'http',
    );

    expect(event.kind).toBe('run.interrupted');
    // Its settlement is unknown (ADR-129): the frame names no failure either.
    expect(event).not.toHaveProperty('error');
  });

  it('carries the failure the resident named, without reading the settlement again', () => {
    const event = semanticRunEvent({
      sequence: 2,
      kind: 'execution.settled',
      status: 'failed',
      settlement: {
        status: 'failed',
        cause: 'task_failed',
        error: { code: 'NIKA-EXEC-001', message: 'exited 1', task: 'build' },
      },
    }, 'http');

    expect(event).toMatchObject({
      kind: 'run.settled',
      status: 'failed',
      error: { code: 'NIKA-EXEC-001', task: 'build' },
    });
  });
});

describe('a lifecycle name needs the exact state the producer wrote', () => {
  // The state word decides, and only a (kind, status) pair a producer defines
  // earns a lifecycle name. Anything else keeps flowing as an engine event:
  // the SDK never reads an ending out of a kind alone, a default, or prose.
  const END_KINDS = ['run_settled', 'execution.settled', 'execution.cancelled', 'execution.refused'];
  const NOT_AN_ENDING = [
    ['an absent status', {}],
    ['a null status', { status: null }],
    ['a future status', { status: 'archived' }],
    ['a queued status', { status: 'queued' }],
    ['a running status', { status: 'running' }],
    ['a non-string status', { status: 200 }],
    // The evidence state rides its own kinds; on an end kind it contradicts it.
    ['an interrupted status', { status: 'interrupted' }],
  ] as const;

  for (const kind of END_KINDS) {
    it.each(NOT_AN_ENDING)(`${kind} with %s is not settled`, (_label, state) => {
      const raw = { kind, sequence: 3, ...state } as unknown as NikaEvent;
      const event = semanticRunEvent(raw, 'http');

      expect(event.kind).toBe('engine.event');
      expect(event.raw).toBe(raw);
      expect(event).not.toHaveProperty('error');
    });
  }

  // The exhaustive set of pairs a producer writes for an ended run. The
  // settlement frame of either transport carries any settlement word; each of
  // the resident's two dedicated end kinds carries only its own.
  it.each([
    ['run_settled', 'succeeded'], ['run_settled', 'failed'], ['run_settled', 'cancelled'],
    ['execution.settled', 'succeeded'], ['execution.settled', 'failed'],
    ['execution.settled', 'cancelled'],
    ['execution.cancelled', 'cancelled'],
    ['execution.refused', 'failed'],
  ])('%s with %s is settled', (kind, status) => {
    expect(semanticRunEvent({ kind, status } as NikaEvent, 'http').kind).toBe('run.settled');
  });

  it.each([
    ['execution.refused', 'succeeded'],
    ['execution.refused', 'cancelled'],
    ['execution.cancelled', 'succeeded'],
    ['execution.cancelled', 'failed'],
  ])('%s with %s contradicts its own kind and is not settled', (kind, status) => {
    // A terminal word on the wrong dedicated kind is still a contradiction: a
    // refusal never succeeded, and a cancellation is neither a success nor a
    // failure. Whatever else the frame carries, the SDK names none of it.
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

  it('reads paused versus settled off the same frame kind, by its state word alone', () => {
    for (const kind of ['run_settled', 'execution.settled']) {
      expect(semanticRunEvent({ kind, status: 'paused' } as NikaEvent, 'http').kind)
        .toBe('run.waiting');
      expect(semanticRunEvent({ kind, status: 'succeeded' } as NikaEvent, 'http').kind)
        .toBe('run.settled');
    }
    // A human-readable message is not a state: it never makes a run wait.
    expect(semanticRunEvent({
      kind: 'execution.settled',
      status: 'failed',
      message: 'paused awaiting approval',
    }, 'http').kind).toBe('run.settled');
    expect(semanticRunEvent({
      kind: 'execution.settled',
      status: null,
      message: 'paused awaiting approval',
    } as unknown as NikaEvent, 'http').kind).toBe('engine.event');
  });

  it.each([
    ['execution.cancelled'],
    ['execution.refused'],
    ['execution.interrupted'],
    ['interrupted'],
    ['workflow_interrupted'],
    ['execution.started'],
  ])('%s carrying paused is not a waiting run: no producer writes that pair', (kind) => {
    expect(semanticRunEvent({ kind, status: 'paused' } as NikaEvent, 'http').kind)
      .not.toBe('run.waiting');
  });

  it.each([
    ['an absent status', {}],
    ['a null status', { status: null }],
    ['a settled status', { status: 'cancelled' }],
    ['a failed status', { status: 'failed' }],
    ['a future status', { status: 'lost' }],
  ] as const)('an interrupted kind with %s is not the evidence state', (_label, state) => {
    for (const kind of ['workflow_interrupted', 'execution.interrupted', 'interrupted']) {
      const raw = { kind, ...state } as unknown as NikaEvent;
      expect(semanticRunEvent(raw, 'http').kind).toBe('engine.event');
    }
  });
});

describe('a failure belongs to a failed state only', () => {
  it.each([
    ['succeeded', 'execution.settled'],
    ['cancelled', 'execution.settled'],
    ['cancelled', 'execution.cancelled'],
    ['succeeded', 'run_settled'],
    ['cancelled', 'run_settled'],
  ])('a %s %s frame names no error, whatever words it carries', (status, kind) => {
    // `JobEvent` lets any frame carry `code` and `message`: on a settlement
    // that did not fail they are words, not a failure.
    const event = semanticRunEvent({
      kind,
      status,
      code: 'operator',
      message: 'cancelled by the operator',
    } as NikaEvent, 'http');

    expect(event.kind).toBe('run.settled');
    expect(event).not.toHaveProperty('error');
  });

  it('lifts the failure a failed settlement named on the frame itself', () => {
    // The resident's shape before it nested the settlement whole.
    const event = semanticRunEvent({
      sequence: 2,
      kind: 'execution.settled',
      status: 'failed',
      code: 'NIKA-EXEC-001',
      message: 'command exited with status 1',
    }, 'http');

    expect(event).toMatchObject({
      kind: 'run.settled',
      status: 'failed',
      error: { code: 'NIKA-EXEC-001', message: 'command exited with status 1' },
    });
  });

  it('gives a waiting or an interrupted run no error at all', () => {
    for (const raw of [
      { kind: 'execution.settled', status: 'paused', message: 'awaiting approval' },
      { kind: 'execution.interrupted', status: 'interrupted', message: 'owner lost' },
    ]) {
      expect(semanticRunEvent(raw as NikaEvent, 'http')).not.toHaveProperty('error');
    }
  });
});

describe('the projection keeps no state between frames', () => {
  it('names duplicate-stage frames one by one, without deduplicating them', () => {
    // The measured native gate writes the pause twice, as a journal frame
    // then as the settlement: one keeps flowing unnamed, one is the wait.
    const gate = native(wire('0.118.7-human-gate.ndjson.stdout'));
    expect(gate.filter((event) => event.kind === 'run.waiting')).toHaveLength(1);
    expect(gate.map((event) => event.raw.kind)).toContain('workflow_paused');

    // Both ratified writers of one cancelled fact, should a resident send both.
    const twice = [
      { sequence: 2, kind: 'execution.cancelled', status: 'cancelled' },
      { sequence: 3, kind: 'execution.settled', status: 'cancelled' },
    ].map((frame) => semanticRunEvent(frame, 'http'));
    expect(twice.map((event) => [event.kind, event.sequence])).toEqual([
      ['run.settled', 2],
      ['run.settled', 3],
    ]);

    const started = { sequence: 1, kind: 'execution.started', status: 'running' } as const;
    const first = semanticRunEvent(started, 'http');
    const again = semanticRunEvent(started, 'http');
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
    expect(again.raw).toBe(first.raw);
  });
});

describe('the projection is total and writes nothing of its own', () => {
  it.each([
    [{ kind: 'permit_checked' }],
    [{ kind: 'workflow_completed', status: 'succeeded' }],
    [{ kind: 'execution.custom', sequence: 9, status: null }],
    [{ kind: null, sequence: 9, status: null }],
    [{}],
    // Hostile kinds that name an inherited object property are still just words.
    [{ kind: 'constructor' }],
    [{ kind: 'toString' }],
    [{ kind: '__proto__' }],
    [{ kind: 'hasOwnProperty', status: 'paused' }],
  ] as unknown as [NikaEvent][])('keeps %j as an unnamed engine event', (raw) => {
    const event = semanticRunEvent(raw, 'http');

    expect(event.kind).toBe('engine.event');
    expect(event.raw).toBe(raw);
  });

  it('keeps the protocol frame by identity and leaves every byte of it alone', () => {
    for (const name of [
      '0.119.0-hello.ndjson.stdout',
      '0.119.0-admitted-failure.ndjson.stdout',
      '0.118.7-human-gate.ndjson.stdout',
      '0.118.7-sigterm-cancel.ndjson.stdout',
      '0.123.2-skipped-cancelled.ndjson.stdout',
      '0.123.2-cache-hit.ndjson.stdout',
    ]) {
      for (const frame of wire(name)) {
        const before = JSON.stringify(frame);
        const event = semanticRunEvent(frame, 'native-process');

        expect(event.raw).toBe(frame);
        expect(JSON.stringify(frame)).toBe(before);
        expect(SEMANTIC_KINDS.has(event.kind)).toBe(true);
        expect(Object.isFrozen(event)).toBe(true);
      }
    }
  });

  it('states only what the frame stated', () => {
    const event = semanticRunEvent({ kind: 'workflow_started' }, 'native-process');

    expect(Object.keys(event).sort()).toEqual(['kind', 'raw', 'transport']);
  });

  it('reads no lifecycle meaning into a frame it does not name', () => {
    // The native journal states the end twice: `workflow_completed` then
    // `run_settled`. Only the named fact carries a state, so an application
    // reading `status` can never count one ending twice.
    const hello = native(wire('0.119.0-hello.ndjson.stdout'));
    const journal = hello.find((event) => event.raw.kind === 'workflow_completed')!;
    expect(Object.keys(journal).sort()).toEqual(['kind', 'raw', 'transport']);
    expect(hello.filter((event) => event.status === 'succeeded').map((event) => event.kind))
      .toEqual(['run.settled']);

    const gate = native(wire('0.118.7-human-gate.ndjson.stdout'));
    expect(gate.filter((event) => event.status === 'paused').map((event) => event.kind))
      .toEqual(['run.waiting']);

    const unnamed = semanticRunEvent({
      kind: 'execution.settled',
      status: 'archived',
      task: 'build',
      error: { code: 'NIKA-X', message: 'x' },
    } as NikaEvent, 'native-process');
    expect(Object.keys(unnamed).sort()).toEqual(['kind', 'raw', 'transport']);
  });

  it('still advances the replay cursor on a frame it does not name', () => {
    // The cursor is the transport's, not a lifecycle meaning: an application
    // that persists it must never fall behind on an unnamed frame. The
    // resident's `JobEvent` allows `status: null`, a value `NikaEvent` does not
    // spell: the frame is read from its bytes, as the transport reads it.
    const raw = JSON.parse('{"sequence":7,"kind":"execution.custom","status":null}') as NikaEvent;
    const event = semanticRunEvent(raw, 'http');

    expect(event).toEqual({
      kind: 'engine.event',
      transport: 'http',
      sequence: 7,
      raw: { sequence: 7, kind: 'execution.custom', status: null },
    });
  });
});
