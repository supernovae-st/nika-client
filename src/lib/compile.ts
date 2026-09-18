import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../errors.js';
import type {
  NikaCheckResult,
  NikaCompileDiagnostic,
  NikaCompileOptions,
  NikaCompileOutcome,
  NikaCompilePreview,
  NikaCompileProvenance,
  NikaCompileQuestion,
  NikaCompileRequest,
  NikaCompileStatus,
  NikaTransportKind,
} from '../types.js';
import type { EngineCapture } from './engine-capture.js';
import { encodeLiteralInputs } from './literal-inputs.js';
import { machineObject } from './machine.js';

/**
 * The native compile adapter (issue #128): a thin projection over the engine's
 * one authoring capability, reached through `nika compile --json` — the
 * versioned `compile_version: 1` wire the CLI adapter renders from the typed
 * `CompileOutcome` core (engine nika#1663). There is no compiler in this file:
 * no intent parsing, no YAML work, no policy judgment. The SDK validates the
 * envelope, preserves the engine's fields verbatim, and classifies failures.
 *
 * The wire law (engine `nika-cli-host/src/compile/render.rs`):
 *
 * - exit 0 + `{compile_version:1, status:'ready', …}` — a complete candidate.
 * - exit 2 + `{compile_version:1, status:'incomplete'|'refused', …}` — DATA:
 *   questions and diagnostics, never an exception.
 * - exit 2 or 3 + `{compile_version:1, error:{code,message}}` — an
 *   engine-stamped failure (usage or environment/machinery).
 *
 * Anything else — a dead child, a truncated or malformed payload, a version
 * this SDK does not speak, an outcome contradicting its exit code — is a typed
 * failure. A partial `ready` from a dead child is never accepted.
 */

/** The capability token an engine advertises once it speaks the compile wire. */
export const COMPILE_CAPABILITY = 'compile';

/** The only compile wire generation this SDK reads. */
export const COMPILE_WIRE_VERSION = 1;

/**
 * Finite bound for one compile response (the candidate plus its full Check
 * report in one JSON document). Overflow kills the child and fails typed
 * (`NikaProtocolError`); the SDK never parses a truncated payload.
 */
export const COMPILE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/** How long a stopped compile child may take to exit before SIGKILL insists. */
export const COMPILE_KILL_GRACE_MS = 2_000;

const STATUSES: readonly NikaCompileStatus[] = ['ready', 'incomplete', 'refused'];

/** Caller-facing request validation: unknown shapes refuse, never downgrade. */
export function normalizeCompileRequest(
  input: string | NikaCompileRequest,
): NikaCompileRequest {
  if (typeof input === 'string') {
    if (input.length === 0) {
      throw new NikaConfigurationError('compile: an intent string must not be empty');
    }
    return { intent: input };
  }
  const record = machineObject(input);
  if (record === undefined) {
    throw new NikaConfigurationError(
      'compile: request must be an intent string, { intent, answers? }, or '
      + '{ workflow, change, answers? }',
    );
  }
  for (const key of Reflect.ownKeys(record)) {
    if (key !== 'intent' && key !== 'workflow' && key !== 'change' && key !== 'answers') {
      throw new NikaConfigurationError(
        `compile: unknown request field ${String(key)}; the request is refused `
        + 'rather than silently reinterpreted',
      );
    }
  }
  const answers = record.answers;
  if (answers !== undefined && !machineObject(answers)) {
    throw new NikaConfigurationError(
      'compile: answers must be a plain object mapping stable question keys to JSON values',
    );
  }
  const intent = record.intent;
  const workflow = record.workflow;
  const change = record.change;
  if (intent !== undefined) {
    if (workflow !== undefined || change !== undefined) {
      throw new NikaConfigurationError(
        'compile: intent (create) never mixes with workflow/change (edit) in one request',
      );
    }
    if (typeof intent !== 'string' || intent.length === 0) {
      throw new NikaConfigurationError('compile: intent must be a non-empty string');
    }
    return answers === undefined
      ? { intent }
      : { intent, answers: answers as Record<string, unknown> };
  }
  if (workflow === undefined && change === undefined) {
    throw new NikaConfigurationError(
      'compile: the request carries neither intent nor workflow/change; nothing would compile',
    );
  }
  if (typeof workflow !== 'string' || workflow.length === 0) {
    throw new NikaConfigurationError(
      'compile: an edit needs the accepted workflow source as a non-empty string',
    );
  }
  if (typeof change !== 'string' || change.length === 0) {
    throw new NikaConfigurationError('compile: an edit needs a non-empty change request');
  }
  return answers === undefined
    ? { workflow, change }
    : { workflow, change, answers: answers as Record<string, unknown> };
}

/** Caller-facing options validation: a bad timeout is a configuration error. */
export function normalizeCompileOptions(options: NikaCompileOptions): NikaCompileOptions {
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'signal' && key !== 'timeoutMs') {
      throw new NikaConfigurationError(`compile: unknown option ${String(key)}`);
    }
  }
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new NikaConfigurationError(
      `compile: timeoutMs must be a positive safe integer of milliseconds, got ${String(timeoutMs)}`,
    );
  }
  return options;
}

/**
 * Compose the caller signal with the timeout. `timedOut` tells the two apart
 * after the fact so the refusal names the right cause.
 */
export function compileSignal(options: NikaCompileOptions): {
  signal?: AbortSignal;
  timedOut(): boolean;
} {
  let timeout: AbortSignal | undefined;
  if (options.timeoutMs !== undefined) timeout = AbortSignal.timeout(options.timeoutMs);
  const signals = [options.signal, timeout].filter((s): s is AbortSignal => s !== undefined);
  return {
    signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
    timedOut: () => timeout?.aborted === true,
  };
}

export interface CompileInvocation {
  readonly args: string[];
  /**
   * EDIT only: the 0700 scratch directory holding the 0600 base-source file.
   * The caller removes it in `finally` — on success, failure and abort alike.
   */
  readonly scratchDir?: string;
}

/**
 * Build the compile argv. Injection laws: every caller-controlled option value
 * rides the `--name=value` form (a value that starts with a dash stays data),
 * the intent positional always follows an explicit `--`, and no shell is ever
 * involved (the capture spawns argv directly).
 */
export async function compileArgv(request: NikaCompileRequest): Promise<CompileInvocation> {
  const args = ['compile', '--json'];
  for (const answer of compileAnswers(request.answers)) {
    args.push(`--answer=${answer}`);
  }
  if (request.intent !== undefined) {
    args.push('--', request.intent);
    return { args };
  }
  // The CLI's EDIT reads the accepted base from a path (`--base`). The engine
  // core owns source selection; the SDK lends a scratch file outside the
  // caller's workspace rather than ever writing near it.
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'nika-sdk-compile-'));
  const base = path.join(scratchDir, 'base.nika.yaml');
  await writeFile(base, request.workflow, { encoding: 'utf8', mode: 0o600 });
  args.push('--base', base, `--change=${request.change}`);
  return { args, scratchDir };
}

/** Remove an EDIT scratch dir; safe to call on any settled path. */
export async function removeCompileScratch(invocation: CompileInvocation): Promise<void> {
  if (invocation.scratchDir !== undefined) {
    await rm(invocation.scratchDir, { recursive: true, force: true });
  }
}

/**
 * The answers map as `KEY=JSON` argv values. Values are judged once by the
 * shared strict-JSON encoder (a value JSON cannot carry — undefined, bigint,
 * cycle, accessor, Proxy — refuses before any spawn), then each is serialized
 * exactly once. A key that is empty or carries '=' is ambiguous under the
 * engine's split-on-first-equals and refuses.
 */
function compileAnswers(answers: Record<string, unknown> | undefined): string[] {
  if (answers === undefined) return [];
  encodeLiteralInputs(answers, 'compile({ answers })');
  return Reflect.ownKeys(answers).map((key) => {
    const name = String(key);
    if (name.length === 0 || name.includes('=')) {
      throw new NikaConfigurationError(
        'compile({ answers }): a question key must be non-empty and cannot carry '
        + "'='; the engine splits KEY=JSON on its first equals sign",
      );
    }
    return `${name}=${JSON.stringify(answers[name])}`;
  });
}

/**
 * Project one captured compile invocation to the outcome, or throw the typed
 * failure the convention assigns. See the module header for the wire law.
 */
export function compileOutcomeFrom(
  captured: EngineCapture,
  transport: NikaTransportKind,
  engine: string,
): NikaCompileOutcome {
  const protocol = (message: string): NikaProtocolError =>
    new NikaProtocolError(transport, `${message} (compile child at ${engine})`);
  if (captured.exitSignal !== null) {
    throw new NikaTransportError(
      transport,
      `compile child at ${engine} was ended externally by ${captured.exitSignal}`,
    );
  }
  const payload = machineObject(tryParseJson(captured.stdout));
  if (!payload) {
    const detail = excerpt(captured.stderr) || excerpt(captured.stdout);
    throw protocol(
      `the compile wire object is absent or malformed (exit ${captured.exitCode})`
      + (detail ? `: ${detail}` : ''),
    );
  }
  if (payload.compile_version !== COMPILE_WIRE_VERSION) {
    throw new NikaCompatibilityError(
      COMPILE_CAPABILITY,
      transport,
      `Engine at ${engine} speaks compile wire `
      + `${String(payload.compile_version ?? '(none)')}; this SDK speaks `
      + `compile_version ${COMPILE_WIRE_VERSION} only`,
    );
  }
  const hasError = 'error' in payload;
  const hasStatus = 'status' in payload;
  if (hasError && hasStatus) {
    throw protocol('the payload carries both an outcome and an error');
  }
  if (hasError) {
    const error = machineObject(payload.error);
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw protocol('the error payload lacks its code/message strings');
    }
    if (captured.exitCode !== 2 && captured.exitCode !== 3) {
      throw protocol(
        `an engine-stamped error arrived with exit ${captured.exitCode}, not 2 or 3`,
      );
    }
    throw new NikaOperationError('compile', transport, error.code, error.message, {
      status: captured.exitCode,
      machineCode: error.code,
    });
  }
  const status = payload.status;
  if (typeof status !== 'string' || !STATUSES.includes(status as NikaCompileStatus)) {
    throw protocol(`unknown compile status ${JSON.stringify(status ?? null)}`);
  }
  if (status === 'ready' ? captured.exitCode !== 0 : captured.exitCode !== 2) {
    throw protocol(
      `status ${JSON.stringify(status)} contradicts exit ${captured.exitCode}`,
    );
  }
  const candidate = payload.candidate;
  if (candidate !== null && typeof candidate !== 'string') {
    throw protocol('candidate is neither source text nor null');
  }
  if (status === 'ready' && candidate === null) {
    throw protocol('a ready outcome carries no candidate');
  }
  const outcome: NikaCompileOutcome = {
    compile_version: COMPILE_WIRE_VERSION,
    status: status as NikaCompileStatus,
    ready: status === 'ready',
    candidate,
    questions: questionsFrom(payload.questions, protocol),
    diagnostics: diagnosticsFrom(payload.diagnostics, protocol),
    requested_boundary: nullableObject(payload.requested_boundary, 'requested_boundary', protocol),
    check_preview: previewFrom(payload.check_preview, protocol),
    provenance: provenanceFrom(payload.provenance, protocol),
    written: writtenFrom(payload.written, protocol),
    exitCode: captured.exitCode,
  };
  return outcome;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function excerpt(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= 240 ? flat : `${flat.slice(0, 240)}…`;
}

function nullableObject(
  value: unknown,
  field: string,
  protocol: (message: string) => NikaProtocolError,
): Record<string, unknown> | null {
  if (value === null) return null;
  const object = machineObject(value);
  if (!object) throw protocol(`${field} is neither an object nor null`);
  return object;
}

function questionsFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileQuestion[] {
  if (!Array.isArray(value)) throw protocol('questions is not an array');
  return value.map((entry) => {
    const question = machineObject(entry);
    if (
      !question
      || typeof question.key !== 'string'
      || typeof question.label !== 'string'
      || typeof question.type !== 'string'
      || typeof question.why !== 'string'
      || typeof question.mandatory !== 'boolean'
    ) {
      throw protocol('a question lacks its key/label/type/why/mandatory shape');
    }
    return question as unknown as NikaCompileQuestion;
  });
}

function diagnosticsFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileDiagnostic[] {
  if (!Array.isArray(value)) throw protocol('diagnostics is not an array');
  return value.map((entry) => {
    const diagnostic = machineObject(entry);
    if (
      !diagnostic
      || typeof diagnostic.kind !== 'string'
      || typeof diagnostic.target !== 'string'
      || typeof diagnostic.message !== 'string'
    ) {
      throw protocol('a diagnostic lacks its kind/target/message shape');
    }
    return diagnostic as unknown as NikaCompileDiagnostic;
  });
}

function previewFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): NikaCompilePreview | null {
  if (value === null) return null;
  const preview = machineObject(value);
  if (!preview || typeof preview.scope !== 'string' || !machineObject(preview.report)) {
    throw protocol('check_preview lacks its scope/report shape');
  }
  return { ...preview, scope: preview.scope, report: preview.report as NikaCheckResult };
}

function provenanceFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileProvenance {
  const provenance = machineObject(value);
  if (
    !provenance
    || typeof provenance.compiler_version !== 'string'
    || typeof provenance.spec_pin !== 'string'
    || (provenance.skeleton !== null && typeof provenance.skeleton !== 'string')
    || typeof provenance.cognition !== 'string'
  ) {
    throw protocol('provenance lacks its compiler_version/spec_pin/skeleton/cognition shape');
  }
  return provenance as unknown as NikaCompileProvenance;
}

function writtenFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): null {
  // The SDK passes no destination, so the engine can never have written.
  if (value !== null) {
    throw protocol('the outcome claims a written destination the SDK never asked for');
  }
  return null;
}
