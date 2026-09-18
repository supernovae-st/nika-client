import { NikaOperationError, NikaProtocolError } from '../errors.js';
import type { NikaCheckFinding, NikaTransportKind } from '../types.js';
import { machineObject } from './machine.js';

/**
 * `nika run --json` writes compact JSON objects, one per line (engine #1650):
 * lifecycle events when the run was admitted, or exactly one pre-run refusal
 * object when it was not. A run event names its `kind`; a refusal object does
 * not. It is one of the two shapes the engine was measured to write: its
 * check report carrying its own `clean: false` verdict beside `findings`, or
 * its error envelope `{ error: { code, message } }`, `code` null when the
 * refusal class carries no wire code. The engine admits and the engine
 * refuses; this module only reads which of the two it wrote. A report that
 * calls itself clean, findings with no verdict, or an envelope with no
 * message is none of them, and is never read as a refusal.
 */

/** What the engine said when it refused a run before admitting it. */
export interface RunRefusal {
  /** The engine's own code, only when the engine named one. */
  machineCode?: string;
  message: string;
  findings?: readonly NikaCheckFinding[];
}

/** The SDK's word for a refusal whose class the engine gave no code. */
const RUN_REFUSED = 'run_refused';
/** Only for a `clean: false` report whose findings carry no message at all. */
const UNEXPLAINED = 'The engine refused this workflow before admission';

/** A run event is the only admission evidence on this wire. */
export function isRunEvent(frame: Record<string, unknown>): boolean {
  return typeof frame.kind === 'string';
}

/** The refusal a first frame carries, or undefined when it is not one. */
export function preRunRefusal(
  frame: Record<string, unknown>,
  transport: NikaTransportKind,
): RunRefusal | undefined {
  if (isRunEvent(frame)) return undefined;
  if (frame.clean === false && Array.isArray(frame.findings)) {
    return checkRefusal(frame.findings, transport);
  }
  const error = machineObject(frame.error);
  if (!error || typeof error.message !== 'string' || error.message.length === 0) {
    return undefined;
  }
  const machineCode = typeof error.code === 'string' && error.code.length > 0
    ? error.code
    : undefined;
  return { ...(machineCode ? { machineCode } : {}), message: error.message };
}

export function runRefusalError(
  transport: NikaTransportKind,
  refusal: RunRefusal,
  exitCode: number,
): NikaOperationError {
  return new NikaOperationError(
    'run',
    transport,
    refusal.machineCode ?? RUN_REFUSED,
    refusal.message,
    {
      status: exitCode,
      ...(refusal.findings ? { findings: refusal.findings } : {}),
      ...(refusal.machineCode ? { machineCode: refusal.machineCode } : {}),
    },
  );
}

/**
 * The findings ride through untouched. The error is named after the first
 * finding that carries a code, in the engine's own `NIKA-… · message` voice.
 */
function checkRefusal(values: unknown[], transport: NikaTransportKind): RunRefusal {
  const findings: NikaCheckFinding[] = [];
  for (const value of values) {
    const finding = machineObject(value);
    if (!finding) {
      throw new NikaProtocolError(transport, 'Pre-run refusal findings were malformed');
    }
    findings.push(finding as NikaCheckFinding);
  }
  const named = findings.find((finding) => typeof finding.code === 'string' && finding.code)
    ?? findings[0];
  const machineCode = typeof named?.code === 'string' && named.code ? named.code : undefined;
  const said = typeof named?.message === 'string' && named.message ? named.message : undefined;
  const others = findings.length > 1 ? ` (+${findings.length - 1} more findings)` : '';
  return {
    ...(machineCode ? { machineCode } : {}),
    message: `${[machineCode, said ?? UNEXPLAINED].filter(Boolean).join(' · ')}${others}`,
    findings,
  };
}
