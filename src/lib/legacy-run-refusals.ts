import { NikaProtocolError } from '../errors.js';
import type { NikaTransportKind } from '../types.js';
import { machineObject } from './machine.js';
import type { RunRefusal } from './run-refusal.js';

/**
 * TEMPORARY · the three pre-run refusal dialects of engines up to 0.119.0,
 * which predate the one `run --json` grammar (engine #1650, merged after
 * 0.119.0). Measured on the released 0.119.0 binary:
 *
 *   1. a check refusal    → the check report, pretty-printed over many lines
 *   2. a budget refusal   → one plain `NIKA-1709 · …` line, no JSON
 *   3. a launch refusal   → nothing on stdout; `nika run: NIKA-1708 · …` on
 *                           stderr, exit 3
 *
 * This is not a protocol and must not grow: it only recovers what those
 * engines already said, so a red workflow teaches instead of surfacing as a
 * protocol error (issue #121). Delete this file, and its three call sites in
 * native-process-transport.ts, once the oldest supported engine writes the
 * compact grammar `run-refusal.ts` reads.
 */

/** The engine's refusal exit classes: 2 findings or budget, 3 launch or environment. */
const REFUSAL_EXITS = new Set([2, 3]);
/** The engine prefixes a stderr diagnostic with its own name, or name and verb. */
const ENGINE_PREFIX = /^nika(?: [a-z-]+)?:\s*/;

/** Dialect 2: no JSON value can open with `NIKA-`, so a match is never a frame. */
export function legacyTeachingLine(line: string): RunRefusal | undefined {
  const machineCode = leadingCode(line);
  return machineCode ? { machineCode, message: line } : undefined;
}

/**
 * Dialect 1: a first line that opens an object yet is not one may be the head
 * of a pretty-printed report. Read the rest of stdout, under the machine
 * bound, as one document. `frame` is absent when it still is not an object.
 */
export async function legacyPrettyReport(
  opening: string,
  lines: AsyncIterator<string>,
  limit: number,
  transport: NikaTransportKind,
): Promise<{ frame?: Record<string, unknown>; text: string } | undefined> {
  if (!opening.startsWith('{')) return undefined;
  let text = opening;
  let bytes = Buffer.byteLength(opening);
  for (;;) {
    const next = await lines.next();
    if (next.done) break;
    text += `\n${next.value}`;
    bytes += Buffer.byteLength(next.value) + 1;
    if (bytes > limit) {
      throw new NikaProtocolError(transport, `Native pre-run report exceeded ${limit} bytes`);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { text };
  }
  const frame = machineObject(value);
  return frame ? { frame, text } : { text };
}

/**
 * Dialect 3: stdout stayed empty and the refusal is on stderr alone. Only the
 * measured shape is read: a refusal exit, and a stderr line that opens with
 * the engine's code once its own prefix is removed. Any other silence is not
 * a refusal, and the caller keeps its protocol fault.
 */
export function legacyStderrRefusal(stderr: string, exitCode: number): RunRefusal | undefined {
  if (!REFUSAL_EXITS.has(exitCode)) return undefined;
  for (const raw of stderr.split('\n')) {
    const line = raw.trim().replace(ENGINE_PREFIX, '');
    const machineCode = leadingCode(line);
    if (machineCode) return { machineCode, message: line };
  }
  return undefined;
}

/**
 * The engine's own wire-code rule, anchored at the start of a line: a run of
 * `A-Z 0-9 - _` after `NIKA-` that carries a digit. `NIKA-` alone is prose.
 */
function leadingCode(text: string): string | undefined {
  const code = /^NIKA-[A-Z0-9_-]+/.exec(text)?.[0].replace(/-+$/, '');
  return code && /\d/.test(code) ? code : undefined;
}
