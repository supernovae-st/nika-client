import type {
  NikaEvent,
  NikaRunSealedEvent,
  NikaRunSettledEvent,
} from './types.js';

/**
 * Narrows any run event to the terminal settlement frame, which carries the
 * run's status, outputs, and receipt together. Kind equality alone cannot
 * exclude the forward-compatibility variant; this guard can.
 */
export function isNikaRunSettledEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(event: NikaEvent<Outputs>): event is NikaRunSettledEvent<Outputs> {
  return event.kind === 'run_settled';
}

/** Narrows any run event to the frame that sealed the run's trace chain. */
export function isNikaRunSealedEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(event: NikaEvent<Outputs>): event is NikaRunSealedEvent {
  return event.kind === 'run_sealed';
}
