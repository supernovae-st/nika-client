import { NikaProtocolError } from '../errors.js';
import { readSettlement } from './settlement.js';
import type {
  NikaEvent,
  NikaMachineError,
  NikaReceipt,
  NikaRunStatus,
  NikaSettlement,
  NikaTransportKind,
} from '../types.js';

export function machineObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseMachineObject(text: string, transport: NikaTransportKind): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new NikaProtocolError(transport, 'Engine machine output was not valid JSON', {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  const object = machineObject(value);
  if (!object) {
    throw new NikaProtocolError(transport, 'Engine machine output was not a JSON object');
  }
  return object;
}

export function eventStatus(event: NikaEvent | undefined): NikaRunStatus | undefined {
  if (typeof event?.status === 'string') return event.status;
  const fields = Array.isArray(event?.fields) ? event.fields : [];
  for (const field of fields) {
    const row = machineObject(field);
    if (row?.key === 'status' && typeof row.value === 'string') return row.value;
  }
  return undefined;
}

/**
 * The settlement a terminal frame carries (engine 0.118+ · ADR-128): the
 * native `run_settled` flattens it (`cause` · `elapsed_ms` · `tasks` ·
 * `spend`), the resident's `execution.settled` may nest it under
 * `settlement`. Absent on older engines; never invented from an exit code.
 */
export function eventSettlement(
  event: NikaEvent | undefined,
  transport: NikaTransportKind = 'http',
): NikaSettlement | undefined {
  if (!event) return undefined;
  const record = event as Record<string, unknown>;
  // The resident already owns this object. Keep additive fields and the
  // named failure exactly as recorded, on SSE and on durable reattachment.
  if (record.settlement !== undefined) {
    return readSettlement(record.settlement, transport, eventStatus(event));
  }
  if (['cause', 'elapsed_ms', 'tasks', 'spend'].every((key) => record[key] === undefined)) return undefined;
  const fields = ['status', 'cause', 'elapsed_ms', 'tasks', 'spend', 'error'];
  return readSettlement(Object.fromEntries(fields
    .filter((key) => record[key] !== undefined)
    .map((key) => [key, record[key]])), transport, eventStatus(event));
}

export function eventReceipt(event: NikaEvent | undefined): NikaReceipt | undefined {
  const direct = machineObject(event?.receipt);
  if (direct) return Object.freeze(direct) as NikaReceipt;
  const fields = Array.isArray(event?.fields) ? event.fields : [];
  for (const field of fields) {
    const row = machineObject(field);
    if (row?.key === 'receipt') {
      const receipt = machineObject(row.value);
      if (receipt) return Object.freeze(receipt) as NikaReceipt;
    }
  }
  return undefined;
}

export function eventOutputs(event: NikaEvent | undefined): Record<string, unknown> | undefined {
  const direct = machineObject(event?.outputs);
  if (direct) return direct;
  const fields = Array.isArray(event?.fields) ? event.fields : [];
  for (const field of fields) {
    const row = machineObject(field);
    if (row?.key === 'outputs') return machineObject(row.value);
  }
  return undefined;
}

export function eventError(event: NikaEvent | undefined): NikaMachineError | undefined {
  const settled = machineObject(machineObject(event?.settlement)?.error);
  if (settled) return settled;
  const direct = machineObject(event?.error);
  if (direct) return direct as NikaMachineError;
  if (typeof event?.code === 'string' || typeof event?.message === 'string') {
    return {
      ...(typeof event.code === 'string' ? { code: event.code } : {}),
      ...(typeof event.message === 'string' ? { message: event.message } : {}),
    };
  }
  return fieldsError(event);
}

/**
 * A native `task_failed` frame carries its failure as field rows, not as an
 * `error` object: `detail` holds `NIKA-<CODE> · <message>` and `task` names
 * the task. Engines before 0.117 name the cause nowhere else; from 0.117 the
 * terminal `run_settled` frame repeats it as an `error` object, which
 * `eventError` reads first. Read it the same way status, receipt, and
 * outputs are read.
 */
function fieldsError(event: NikaEvent | undefined): NikaMachineError | undefined {
  if (event?.kind !== 'task_failed') return undefined;
  const fields = Array.isArray(event.fields) ? event.fields : [];
  let detail: string | undefined;
  let task: string | undefined;
  for (const field of fields) {
    const row = machineObject(field);
    if (row?.key === 'detail' && typeof row.value === 'string') detail = row.value;
    if (row?.key === 'task' && typeof row.value === 'string') task = row.value;
  }
  if (detail === undefined) return undefined;
  const match = detail.trim().match(/^(NIKA-[A-Z0-9-]+)\s*·?\s*([\s\S]*)$/);
  const code = match?.[1];
  const message = (match ? match[2] : detail).trim();
  return {
    ...(code ? { code } : {}),
    ...(message.length > 0 ? { message } : {}),
    ...(task ? { task } : {}),
  };
}

export function receiptTraceLocator(receipt: NikaReceipt): string | undefined {
  const value = receipt.trace_path;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
