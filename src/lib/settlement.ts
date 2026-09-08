import { NikaProtocolError } from '../errors.js';
import type { NikaSettlement, NikaTransportKind } from '../types.js';

const TALLY_FIELDS = [
  'total', 'ok', 'failed', 'recovered', 'skipped', 'cancelled', 'never_started',
] as const;

/**
 * Read the settlement the engine built once (ADR-128 · engine 0.118) as the
 * resident projects it: nested whole on the terminal frame and on the
 * durable job. Every known fact is typed, and a wrong type is a protocol
 * fault, as a malformed durable `error` already is; fields this SDK does not
 * know ride through, because the vocabulary is additive. `expectedStatus` is
 * the frame's or job's own status: a settlement that names another state
 * contradicts the record carrying it.
 */
export function readSettlement(
  value: unknown,
  transport: NikaTransportKind,
  expectedStatus?: string,
): NikaSettlement {
  const fault = (detail: string): never => {
    throw new NikaProtocolError(transport, `Engine settlement was malformed: ${detail}`);
  };
  const settlement = record(value) ?? fault('not an object');
  for (const field of ['status', 'cause'] as const) {
    if (settlement[field] !== undefined && typeof settlement[field] !== 'string') {
      fault(`${field} was not a string`);
    }
  }
  if (
    settlement.status !== undefined
    && expectedStatus !== undefined
    && settlement.status !== expectedStatus
  ) {
    fault(`status ${String(settlement.status)} contradicts the record's ${expectedStatus}`);
  }
  count('elapsed_ms', settlement.elapsed_ms, fault);
  if (settlement.tasks !== undefined) {
    const tasks = record(settlement.tasks) ?? fault('tasks was not an object');
    for (const field of TALLY_FIELDS) count(`tasks.${field}`, tasks[field], fault);
  }
  if (settlement.spend !== undefined) {
    const spend = record(settlement.spend) ?? fault('spend was not an object');
    if (spend.qualifier !== undefined && typeof spend.qualifier !== 'string') {
      fault('spend.qualifier was not a string');
    }
    if (
      spend.pricing_as_of !== undefined
      && spend.pricing_as_of !== null
      && typeof spend.pricing_as_of !== 'string'
    ) {
      fault('spend.pricing_as_of was not a string');
    }
    count('spend.priced_calls', spend.priced_calls, fault);
    count('spend.unpriced_calls', spend.unpriced_calls, fault);
    // Unknown cost is never zero: the resident omits total_cost_usd when
    // nothing was metered, and earlier native frames wrote null. Both stay
    // exactly as read.
    if (spend.total_cost_usd !== undefined && spend.total_cost_usd !== null) {
      amount('spend.total_cost_usd', spend.total_cost_usd, fault);
    }
    if (spend.by_source !== undefined) {
      const bySource = record(spend.by_source) ?? fault('spend.by_source was not an object');
      for (const [source, cost] of Object.entries(bySource)) {
        amount(`spend.by_source.${source}`, cost, fault);
      }
    }
  }
  if (settlement.error !== undefined) {
    const error = record(settlement.error) ?? fault('error was not an object');
    if (typeof error.code !== 'string' || typeof error.message !== 'string') {
      fault('error omitted its code or message');
    }
    if (error.task !== undefined && typeof error.task !== 'string') {
      fault('error.task was not a string');
    }
  }
  return settlement as NikaSettlement;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** A tally or a duration: a non-negative safe integer when present. */
function count(name: string, value: unknown, fault: (detail: string) => never): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fault(`${name} was not a non-negative integer`);
  }
}

/** A cost: a finite non-negative number. */
function amount(name: string, value: unknown, fault: (detail: string) => never): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fault(`${name} was not a non-negative number`);
  }
}
