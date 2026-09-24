import { NikaConfigurationError } from '../errors.js';
import type { NikaScheduleOptions } from '../types.js';
import { encodeLiteralInputs } from './literal-inputs.js';

/** Snapshot the scalar wire before negotiation; coercion and binding belong to Serve. */
export function scheduleInputs(inputs: unknown): NikaScheduleOptions['inputs'] {
  if (inputs === undefined) return undefined;
  // Reuse descriptor-safe strict JSON encoding; never invoke a caller getter,
  // Proxy trap or toJSON while deciding which bytes the resident will receive.
  const captured: Record<string, unknown> = JSON.parse(encodeLiteralInputs(inputs, 'schedule({ inputs })').json);
  for (const value of Object.values(captured)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new NikaConfigurationError('schedule({ inputs }): values must be strings, finite numbers or booleans');
    }
  }
  return captured as NikaScheduleOptions['inputs'];
}
