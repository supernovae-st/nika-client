import { NikaProtocolError } from '../errors.js';
import type {
  NikaAccessRequirement,
  NikaAccessSelection,
  NikaTransportKind,
} from '../types.js';

const SELECTION_SCHEMA = 'nika/access-selection@1';
const DIMENSION_FACTS = ['requested', 'option', 'transmitted', 'configured', 'configured_source'] as const;
const TIER_FACTS = ['requested', 'option', 'transmitted', 'configured', 'configured_source'] as const;

type Fault = (detail: string) => never;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** A fact of the receipt: a string, or an explicit `null`. Never absent, never another type. */
function fact(name: string, holder: Record<string, unknown>, key: string, fault: Fault): void {
  const value = holder[key];
  if (value !== null && typeof value !== 'string') fault(`${name}.${key} was not a string or null`);
}

/** `{ value, evidence }`, with `evidence` reading `unknown` exactly when `value` is `null`. */
function attested(name: string, value: unknown, fault: Fault): void {
  const pair = record(value) ?? fault(`${name} was not an object`);
  fact(name, pair, 'value', fault);
  if (typeof pair.evidence !== 'string') fault(`${name}.evidence was not a string`);
  if ((pair.value === null) !== (pair.evidence === 'unknown')) {
    fault(`${name} names a value and an evidence that contradict each other`);
  }
}

/**
 * The JSON text of one frame row, parsed. The engine writes a row as one
 * compact JSON object inside a string, so a row that is present and is not
 * that is a protocol fault, never a value to guess at.
 */
function rowObject(
  rows: unknown,
  key: string,
  transport: NikaTransportKind,
): Record<string, unknown> | undefined {
  if (!Array.isArray(rows)) return undefined;
  for (const candidate of rows) {
    const row = record(candidate);
    if (row?.key !== key) continue;
    const fault: Fault = (detail) => {
      throw new NikaProtocolError(transport, `Engine ${key} row was malformed: ${detail}`);
    };
    if (typeof row.value !== 'string') return fault('not a JSON text');
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return fault('not valid JSON');
    }
    return record(parsed) ?? fault('not an object');
  }
  return undefined;
}

/** Read the `access_requirement` row of a frame's field list. */
export function readAccessRequirement(
  rows: unknown,
  transport: NikaTransportKind,
): NikaAccessRequirement | undefined {
  const requirement = rowObject(rows, 'access_requirement', transport);
  if (!requirement) return undefined;
  for (const key of ['via', 'protocol', 'fallback', 'service_tier', 'effort']) {
    if (requirement[key] !== undefined && typeof requirement[key] !== 'string') {
      throw new NikaProtocolError(
        transport,
        `Engine access_requirement row was malformed: ${key} was not a string`,
      );
    }
  }
  return Object.freeze(requirement) as NikaAccessRequirement;
}

/**
 * Read the `access_selection` row of a frame's field list. Every fact of the
 * `nika/access-selection@1` receipt is checked; a later schema generation is
 * returned as read, because this SDK does not know its facts.
 */
export function readAccessSelection(
  rows: unknown,
  transport: NikaTransportKind,
): NikaAccessSelection | undefined {
  const selection = rowObject(rows, 'access_selection', transport);
  if (!selection) return undefined;
  const fault: Fault = (detail) => {
    throw new NikaProtocolError(transport, `Engine access_selection row was malformed: ${detail}`);
  };
  if (typeof selection.schema !== 'string') fault('schema was not a string');
  if (selection.schema !== SELECTION_SCHEMA) return Object.freeze(selection) as NikaAccessSelection;
  if (selection.protocol !== null && typeof selection.protocol !== 'string') {
    fault('protocol was not a string or null');
  }
  for (const name of ['model', 'effort'] as const) {
    const dimension = record(selection[name]) ?? fault(`${name} was not an object`);
    for (const key of DIMENSION_FACTS) fact(name, dimension, key, fault);
  }
  const responder = record(selection.responder) ?? fault('responder was not an object');
  fact('responder', responder, 'model', fault);
  if (typeof responder.evidence !== 'string') fault('responder.evidence was not a string');
  if (selection.service_tier !== undefined) {
    const tier = record(selection.service_tier) ?? fault('service_tier was not an object');
    for (const key of TIER_FACTS) fact('service_tier', tier, key, fault);
    const offered = tier.offered;
    if (offered !== null && !(Array.isArray(offered) && offered.every((value) => typeof value === 'string'))) {
      fault('service_tier.offered was not a list of strings or null');
    }
    attested('service_tier.turn', tier.turn, fault);
    attested('service_tier.effective', tier.effective, fault);
  }
  const moved = selection.changed_mid_turn;
  if (moved !== undefined && !(Array.isArray(moved) && moved.every((value) => typeof value === 'string'))) {
    fault('changed_mid_turn was not a list of strings');
  }
  return Object.freeze(selection) as NikaAccessSelection;
}
