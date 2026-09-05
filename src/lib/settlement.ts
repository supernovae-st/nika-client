import { NikaProtocolError } from '../errors.js';
import type { NikaSettlement, NikaTransportKind } from '../types.js';

/** Validate known wire fields without closing the engine's additive vocabulary. */
export function readSettlement(
  value: unknown,
  transport: NikaTransportKind,
  expectedStatus?: string,
): NikaSettlement {
  const reject = (): never => {
    throw new NikaProtocolError(transport, 'Engine settlement was malformed or contradicted its status');
  };
  const object = record(value) ?? reject();
  strings(object, ['status', 'cause'], reject);
  numbers(object, ['elapsed_ms'], true, reject);
  if (object.status !== undefined && expectedStatus !== undefined && object.status !== expectedStatus) reject();
  if (object.tasks !== undefined) {
    const tasks = record(object.tasks) ?? reject();
    numbers(tasks, ['total', 'ok', 'failed', 'recovered', 'skipped', 'cancelled', 'never_started'], true, reject);
  }
  if (object.spend !== undefined) {
    const spend = record(object.spend) ?? reject();
    strings(spend, ['qualifier', 'pricing_as_of'], reject);
    numbers(spend, ['priced_calls', 'unpriced_calls'], true, reject);
    // Older frames explicitly used null for unknown spend; keep that fact.
    if (spend.total_cost_usd !== null) numbers(spend, ['total_cost_usd'], false, reject);
    if (spend.by_source !== undefined) {
      const bySource = record(spend.by_source) ?? reject();
      numbers(bySource, Object.keys(bySource), false, reject);
    }
  }
  if (object.error !== undefined) {
    strings(record(object.error) ?? reject(), ['code', 'message', 'task'], reject);
  }
  return object;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function strings(object: Record<string, unknown>, fields: string[], reject: () => never): void {
  for (const field of fields) {
    if (object[field] !== undefined && typeof object[field] !== 'string') reject();
  }
}

function numbers(
  object: Record<string, unknown>, fields: string[], integer: boolean, reject: () => never,
): void {
  for (const field of fields) {
    const value = object[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)
      || value < 0 || (integer && !Number.isSafeInteger(value)))) reject();
  }
}
