import type { NikaRunResult } from './types.js';

/**
 * Narrows a result to the engine's successful settlement. Admitted failures
 * resolve as result data; awaiting a run alone does not establish success.
 * Paused, cancelled, interrupted, failed, and unknown statuses return false.
 * Outputs remain optional: a successful workflow need not declare any.
 */
export function isNikaRunSucceeded<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
>(result: NikaRunResult<Outputs>): result is NikaRunResult<Outputs> & { status: 'succeeded' } {
  return result.status === 'succeeded';
}
