import { NikaOperationError, NikaProtocolError } from '../errors.js';
import type { NikaCheckFinding, NikaTransportKind } from '../types.js';
import { machineObject } from './machine.js';

/*
 * The native admission law as @supernovae-st/nika 0.120.3 publishes it on npm
 * (its run-refusal and legacy-run-refusals modules): the engine's first
 * machine frame decides. A frame with a `kind` is a run event, the engine's
 * own admission evidence. An object without one is its single pre-run refusal
 * object: a red check report (`clean: false` with its findings) or an
 * `{ "error": { code, message } }` envelope. The SDK reads which one the
 * engine wrote and judges nothing itself. The published multi-line report of
 * older engines is not carried here: a report that spans lines stays a
 * protocol fault.
 */

/** The SDK's own code when the engine named none (an unreadable workflow file). */
const RUN_REFUSED = 'run_refused';
const UNEXPLAINED = 'The engine refused this workflow before admission';
/** Exits an engine uses for a refusal it teaches on stderr alone. */
const REFUSAL_EXITS: ReadonlySet<number> = new Set([2, 3]);
/** The engine prefixes a stream-routed line with its own name. */
const ENGINE_PREFIX = /^nika(?: [a-z-]+)?:\s*/;

/** What the engine refused with: its code when it named one, its words, its check findings. */
export interface RunRefusal {
  machineCode?: string;
  message: string;
  findings?: NikaCheckFinding[];
}

/** A machine frame that is a run event: the engine admitted the run. */
export function isRunEvent(frame: Record<string, unknown>): boolean {
  return typeof frame.kind === 'string';
}

/** The pre-run refusal a kindless frame carries, or `undefined` when it carries none. */
export function preRunRefusal(
  frame: Record<string, unknown>,
  transport: NikaTransportKind,
): RunRefusal | undefined {
  if (isRunEvent(frame)) return undefined;
  if (frame.clean === false && Array.isArray(frame.findings)) {
    return checkRefusal(frame.findings, transport);
  }
  const error = machineObject(frame.error);
  if (!error || typeof error.message !== 'string' || error.message.length === 0) return undefined;
  const machineCode = typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined;
  return { ...(machineCode ? { machineCode } : {}), message: error.message };
}

/**
 * A refusal line an engine writes instead of a machine frame (`NIKA-1709 ·
 * refusing to start …`): no JSON value can open with `NIKA-`, so a match is
 * never a frame.
 */
export function teachingLineRefusal(line: string): RunRefusal | undefined {
  const machineCode = leadingCode(line);
  return machineCode ? { machineCode, message: line } : undefined;
}

/** A refusal an engine taught on stderr alone, with a refusal exit and no machine frame. */
export function stderrRefusal(stderr: string, exitCode: number): RunRefusal | undefined {
  if (!REFUSAL_EXITS.has(exitCode)) return undefined;
  for (const raw of stderr.split('\n')) {
    const line = raw.trim().replace(ENGINE_PREFIX, '');
    const machineCode = leadingCode(line);
    if (machineCode) return { machineCode, message: line };
  }
  return undefined;
}

/** The typed refusal `run()` rejects with, carrying the engine's code, words and exit status. */
export function runRefusalError(
  transport: NikaTransportKind,
  refusal: RunRefusal,
  exitCode: number,
): NikaOperationError {
  return new NikaOperationError('run', transport, refusal.machineCode ?? RUN_REFUSED, refusal.message, {
    status: exitCode,
    ...(refusal.findings ? { findings: refusal.findings } : {}),
    ...(refusal.machineCode ? { machineCode: refusal.machineCode } : {}),
  });
}

function checkRefusal(values: unknown[], transport: NikaTransportKind): RunRefusal {
  const findings: NikaCheckFinding[] = [];
  for (const value of values) {
    const finding = machineObject(value);
    if (!finding) throw new NikaProtocolError(transport, 'Pre-run refusal findings were malformed');
    findings.push(finding as NikaCheckFinding);
  }
  const named = findings.find((finding) => typeof finding.code === 'string' && finding.code) ?? findings[0];
  const machineCode = typeof named?.code === 'string' && named.code ? named.code : undefined;
  const said = typeof named?.message === 'string' && named.message ? named.message : undefined;
  const others = findings.length > 1 ? ` (+${findings.length - 1} more findings)` : '';
  return {
    ...(machineCode ? { machineCode } : {}),
    message: `${[machineCode, said ?? UNEXPLAINED].filter(Boolean).join(' · ')}${others}`,
    findings,
  };
}

/** The engine code a line opens with; a code needs a digit, so a bare word is never one. */
function leadingCode(text: string): string | undefined {
  const code = /^NIKA-[A-Z0-9_-]+/.exec(text)?.[0].replace(/-+$/, '');
  return code && /\d/.test(code) ? code : undefined;
}
