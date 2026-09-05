import type {
  NikaEvent,
  NikaExecutionSettledEvent,
  NikaRunSealedEvent,
  NikaRunSettledEvent,
} from './types.js';

/** The statuses that settle this execution/observation leg (a pause can resume). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
  'paused',
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
  status: 'succeeded' | 'failed' | 'interrupted' | 'cancelled' | 'paused';
} {
  return typeof event.status === 'string' && TERMINAL_STATUSES.has(event.status);
}

/** Narrows any run event to the frame that sealed the run's trace chain. */
export function isNikaRunSealedEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(event: NikaEvent<Outputs>): event is NikaRunSealedEvent {
  return event.kind === 'run_sealed';
}
