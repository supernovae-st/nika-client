import type {
  NikaEvent,
  NikaRunEvent,
  NikaRunEventKind,
  NikaTransportKind,
} from '../types.js';
import { eventError, eventStatus, machineObject } from './machine.js';

/**
 * The semantic adapter (issue #117): one protocol frame in, the same frame
 * out under the SDK's lifecycle word. It is a pure projection. It reads the
 * kind and the state word the engine wrote, keeps the frame by identity on
 * `raw`, and writes no fact of its own, so a transport that emits fewer
 * frames simply yields fewer events.
 */

const STARTED: ReadonlySet<string> = new Set(['workflow_started', 'execution.started']);

// A Map, never an object literal: a frame's kind is engine-supplied text, and
// `constructor` must stay a word instead of resolving up a prototype chain.
const TASKS: ReadonlyMap<string, NikaRunEventKind> = new Map([
  ['task_scheduled', 'task.scheduled'],
  ['task_started', 'task.started'],
  ['task_completed', 'task.completed'],
  ['task_failed', 'task.failed'],
]);

/** The settlement frame of each transport: the one frame a run can wait on. */
const SETTLEMENT: ReadonlySet<string> = new Set(['run_settled', 'execution.settled']);

/** The run's own settlement words (ADR-128). `paused` waits; it does not settle. */
const SETTLEMENT_WORDS: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * The exact (kind, status) pairs a producer writes for an ended run, listed
 * and never computed as a product of kinds and words. The settlement frame of
 * either transport carries any settlement word. Each of the resident's two
 * dedicated end kinds carries only its own: it ratifies `execution.cancelled`
 * beside `execution.settled` for one cancelled fact, and a refusal after
 * admission is a failed result. A refusal that succeeded, or a cancellation
 * that failed, is a contradiction no producer defines, and earns no name.
 */
const SETTLED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['run_settled', SETTLEMENT_WORDS],
  ['execution.settled', SETTLEMENT_WORDS],
  ['execution.cancelled', new Set(['cancelled'])],
  ['execution.refused', new Set(['failed'])],
]);

const INTERRUPTED: ReadonlySet<string> = new Set([
  'workflow_interrupted',
  'execution.interrupted',
  'interrupted',
]);

export function semanticRunEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(raw: NikaEvent<Outputs>, transport: NikaTransportKind): NikaRunEvent<Outputs> {
  const stated = eventStatus(raw);
  const kind = semanticKind(raw.kind, stated);
  // A frame the SDK does not name is given no lifecycle meaning at all. The
  // native journal states one ending twice (`workflow_completed`, then
  // `run_settled`): only the named fact carries the state, so an application
  // reading `status` never counts an ending twice.
  const named = kind !== 'engine.event';
  const status = named ? stated : undefined;
  const task = kind.startsWith('task.') ? eventTask(raw) : undefined;
  // A failure belongs to a failed state only: a failed task, or a settlement
  // whose state word is `failed`. `JobEvent` lets any frame carry `code` and
  // `message`; on a run that succeeded, was cancelled, waits, or was
  // interrupted, those are words, never a failure.
  const failed = kind === 'task.failed' || (kind === 'run.settled' && status === 'failed');
  const error = failed ? eventError(raw) : undefined;
  // Only the resident's validated SSE id is a replay cursor, and it is the
  // transport's: it advances on every frame, named or not.
  const sequence = transport === 'http' && Number.isSafeInteger(raw.sequence)
    ? raw.sequence
    : undefined;
  return Object.freeze({
    kind,
    transport,
    ...(status !== undefined ? { status } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(error !== undefined ? { error } : {}),
    raw,
  });
}

/**
 * A frame that speaks of the run's state earns a lifecycle name only for a
 * (kind, status) pair a producer defines. The state word decides and is never
 * defaulted: an absent, null, future, or still-running status, or a word that
 * contradicts its kind, keeps flowing as `engine.event` with `raw` intact.
 */
function semanticKind(kind: unknown, status: string | undefined): NikaRunEventKind {
  if (typeof kind !== 'string') return 'engine.event';
  if (STARTED.has(kind)) return 'run.started';
  const task = TASKS.get(kind);
  if (task !== undefined) return task;
  if (kind === 'run_sealed') return 'run.sealed';
  // `interrupted` is the evidence state whose settlement is unknown (ADR-129):
  // it rides its own kinds, and is never called settled.
  if (INTERRUPTED.has(kind)) return status === 'interrupted' ? 'run.interrupted' : 'engine.event';
  if (status === undefined) return 'engine.event';
  // A human gate holds the run: waiting is never a completed execution.
  if (status === 'paused') return SETTLEMENT.has(kind) ? 'run.waiting' : 'engine.event';
  return SETTLED.get(kind)?.has(status) === true ? 'run.settled' : 'engine.event';
}

/** The task a frame named: directly, or as the native `task` field row. */
function eventTask(raw: NikaEvent): string | undefined {
  if (typeof raw.task === 'string') return raw.task;
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  for (const field of fields) {
    const row = machineObject(field);
    if (row?.key === 'task' && typeof row.value === 'string') return row.value;
  }
  return undefined;
}
