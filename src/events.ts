import { readAccessRequirement, readAccessSelection } from './lib/access-evidence.js';
import type {
  NikaAccessRequirement,
  NikaAccessSelection,
  NikaEvent,
  NikaExecutionSettledEvent,
  NikaRunEvent,
  NikaRunSealedEvent,
  NikaRunSettledEvent,
  NikaTransportKind,
} from './types.js';

/** The statuses after which the engine sends no further frame for a run. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
]);

/**
 * Narrows any run event to the terminal settlement frame, which carries the
 * run's status, outputs, and receipt together. Both transports have one: the
 * native process emits `run_settled`, `nika serve` emits `execution.settled`.
 * Kind equality alone cannot exclude the forward-compatibility variant; this
 * guard can.
 */
export function isNikaRunSettledEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(
  event: NikaEvent<Outputs>,
): event is NikaRunSettledEvent<Outputs> | NikaExecutionSettledEvent<Outputs> {
  return event.kind === 'run_settled' || event.kind === 'execution.settled';
}

/**
 * Narrows any run event to a terminal one by the status the engine reported,
 * not by its kind, so it holds on either transport and across kinds this SDK
 * version does not know yet. It therefore also covers the frames that end a
 * run without settling outputs: `execution.cancelled`, `execution.refused`,
 * `interrupted`, `workflow_failed` and `workflow_cancelled` (the engine's
 * four run terminals are `workflow_completed` · `workflow_failed` ·
 * `workflow_paused` · `workflow_cancelled` · ADR-128).
 */
export function isNikaTerminalEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(
  event: NikaEvent<Outputs>,
): event is NikaEvent<Outputs> & {
  status: 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
} {
  return typeof event.status === 'string' && TERMINAL_STATUSES.has(event.status);
}

/** Narrows any run event to the frame that sealed the run's trace chain. */
export function isNikaRunSealedEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(event: NikaEvent<Outputs>): event is NikaRunSealedEvent {
  return event.kind === 'run_sealed';
}

/** The engine frame an event stands for, and the door it came through. */
function frameOf(event: NikaEvent | NikaRunEvent): {
  rows: unknown;
  transport: NikaTransportKind;
} {
  const run = event as Partial<NikaRunEvent>;
  const raw = run.raw !== undefined && typeof run.raw === 'object' && run.raw !== null
    ? run.raw as Record<string, unknown>
    : event as Record<string, unknown>;
  return {
    rows: raw.fields,
    // Only a native frame carries field rows; a bare frame names no door.
    transport: run.transport === 'http' ? 'http' : 'native-process',
  };
}

/**
 * Reads the access selection receipt of one `infer:` or `agent:` call from
 * the task's terminal frame (`task_completed`, or the failed or cancelled
 * frame of a task that reached its route): what the workflow asked, what the
 * engine sent and what the route read back, for the model, the effort and,
 * when the file declares one, the service tier.
 *
 * Returns `undefined` when the frame carries no receipt: a task that called
 * no model, a file that declares no access contract, or a run on `nika
 * serve`, which keeps these rows in the sealed journal and projects none of
 * them. A receipt that is present and malformed throws `NikaProtocolError`.
 * Accepts an engine frame (`run.events()`) or the stable event that wraps it.
 */
export function readNikaAccessSelection(
  event: NikaEvent | NikaRunEvent,
): NikaAccessSelection | undefined {
  const { rows, transport } = frameOf(event);
  return readAccessSelection(rows, transport);
}

/**
 * Reads the access contract the workflow file declared (`run.access`,
 * `run.reasoning`) from the opening frame or from a task's terminal frame.
 * Returns `undefined` when the frame carries none, which is every frame of a
 * file that declares no contract and every frame from `nika serve`.
 */
export function readNikaAccessRequirement(
  event: NikaEvent | NikaRunEvent,
): NikaAccessRequirement | undefined {
  const { rows, transport } = frameOf(event);
  return readAccessRequirement(rows, transport);
}
