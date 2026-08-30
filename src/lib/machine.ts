import { NikaProtocolError } from '../errors.js';
import type {
  NikaEvent,
  NikaMachineError,
  NikaReceipt,
  NikaRunStatus,
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

export function eventReceipt(event: NikaEvent | undefined): NikaReceipt | undefined {
  const direct = machineObject(event?.receipt);
  if (direct) return direct as NikaReceipt;
  const fields = Array.isArray(event?.fields) ? event.fields : [];
  for (const field of fields) {
    const row = machineObject(field);
    if (row?.key === 'receipt') {
      const receipt = machineObject(row.value);
      if (receipt) return receipt as NikaReceipt;
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
  const direct = machineObject(event?.error);
  if (direct) return direct as NikaMachineError;
  if (typeof event?.code === 'string' || typeof event?.message === 'string') {
    return {
      ...(typeof event.code === 'string' ? { code: event.code } : {}),
      ...(typeof event.message === 'string' ? { message: event.message } : {}),
    };
  }
  return undefined;
}

export function receiptTraceLocator(receipt: NikaReceipt): string | undefined {
  const value = receipt.trace_path;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
