import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { types as utilTypes } from 'node:util';
import { addAbortListener } from 'node:events';
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
  NikaCompileSetConstant,
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
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const removeSignalListener = EventTarget.prototype.removeEventListener;
const signalInterface = new Set([
  'aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener', 'dispatchEvent',
]);

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
  const record = dataRecord(input, 'request');
  for (const key of Reflect.ownKeys(record)) {
    if (key !== 'intent' && key !== 'workflow' && key !== 'change' && key !== 'answers') {
      throw new NikaConfigurationError(
        `compile: unknown request field ${String(key)}; the request is refused `
        + 'rather than silently reinterpreted',
      );
    }
  }
  const answers = record.answers;
  if (answers !== undefined) encodeLiteralInputs(answers, 'compile({ answers })');
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
  const normalizedChange = normalizeChange(change);
  return answers === undefined
    ? { workflow, change: normalizedChange }
    : { workflow, change: normalizedChange, answers: answers as Record<string, unknown> };
}

/** Inspect descriptors only: no request getter, Proxy trap or coercion runs. */
function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new NikaConfigurationError(`compile: ${label} must be ${label === 'request' ? 'an intent string or ' : ''}a plain object with own data fields`);
  }
  const result: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string]!;
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) {
      throw new NikaConfigurationError(`compile: ${label} must contain only enumerable string data fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function normalizeChange(change: unknown): string | NikaCompileSetConstant {
  if (typeof change === 'string' && change.length > 0) return change;
  if (change === undefined || change === '') {
    throw new NikaConfigurationError('compile: an edit needs a non-empty change request');
  }
  // The strict encoder refuses accessors, proxies and non-JSON literals before
  // inspecting the structured edit. Clone so later caller mutation cannot alter it.
  const encoded = encodeLiteralInputs({ change }, 'compile({ change })');
  const object = machineObject(JSON.parse(encoded.json).change);
  const constant = machineObject(object?.set_constant);
  if (!object || Object.keys(object).length !== 1 || !constant
    || Object.keys(constant).length !== 2 || !('value' in constant)
    || typeof constant.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(constant.name)) {
    throw new NikaConfigurationError(
      'compile: an edit needs a non-empty change string or set_constant with a bare name and JSON value',
    );
  }
  return object as unknown as NikaCompileSetConstant;
}

/** Caller-facing options validation: a bad timeout is a configuration error. */
export function normalizeCompileOptions(options: NikaCompileOptions): NikaCompileOptions {
  const record = dataRecord(options, 'options');
  for (const key of Reflect.ownKeys(record)) {
    if (key !== 'signal' && key !== 'timeoutMs') {
      throw new NikaConfigurationError(`compile: unknown option ${String(key)}`);
    }
  }
  const timeoutMs = record.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)) {
    throw new NikaConfigurationError(
      'compile: timeoutMs must be a positive safe integer between 1 and 2147483647 milliseconds',
    );
  }
  const signal = record.signal;
  if (signal !== undefined) {
    const invalidSignal = () => new NikaConfigurationError('compile: signal must be an AbortSignal');
    if (signal === null || typeof signal !== 'object' || utilTypes.isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw invalidSignal();
    // A native brand does not make own interface overrides safe: Node's
    // AbortSignal.any reads aborted/reason through ordinary property access.
    // Inspect descriptors before even the intrinsic brand check, retaining the
    // signal's normal internal data fields without invoking caller accessors.
    const descriptors = Object.getOwnPropertyDescriptors(signal);
    for (const key of Reflect.ownKeys(descriptors)) {
      if ((typeof key === 'string' && signalInterface.has(key))
        || !('value' in descriptors[key as string]!)) throw invalidSignal();
    }
    try {
      signalAborted.call(signal);
    } catch { throw invalidSignal(); }
  }
  return record as NikaCompileOptions;
}

/**
 * Compose the caller signal with the timeout. `timedOut` tells the two apart
 * after the fact so the refusal names the right cause.
 */
export function compileSignal(options: NikaCompileOptions): {
  signal?: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const caller = options.signal;
  let bridge: AbortController | undefined;
  let abort: (() => void) | undefined;
  if (caller !== undefined) {
    bridge = new AbortController();
    // Never give a caller composite to AbortSignal.any: Node may read public
    // fields on its source signals, which our direct validation cannot inspect.
    // addAbortListener sees only the validated signal and resists an earlier
    // listener's stopImmediatePropagation. Downstream code sees our own signal.
    const controller = bridge;
    abort = () => controller.abort();
    if (signalAborted.call(caller)) abort();
    else addAbortListener(caller, abort);
  }
  let timeout: AbortSignal | undefined;
  if (options.timeoutMs !== undefined) timeout = AbortSignal.timeout(options.timeoutMs);
  const signals = [bridge?.signal, timeout].filter((s): s is AbortSignal => s !== undefined);
  return {
    signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
    timedOut: () => timeout?.aborted === true,
    // Use the intrinsic even if the caller shadows removeEventListener after
    // starting Compile. Do not retain a listener on a long-lived caller signal.
    dispose: () => {
      if (caller && abort) removeSignalListener.call(caller, 'abort', abort);
    },
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
    refuseNul(request.intent);
    args.push('--', request.intent);
    return { args };
  }
  const change = typeof request.change === 'string' ? request.change
    : `Set const.${request.change.set_constant.name} to ${literalJson(request.change.set_constant.value)}`;
  refuseNul(change);
  // The CLI's EDIT reads the accepted base from a path (`--base`). The engine
  // core owns source selection; the SDK lends a scratch file outside the
  // caller's workspace rather than ever writing near it.
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'nika-sdk-compile-'));
  const base = path.join(scratchDir, 'base.nika');
  try {
    await writeFile(base, request.workflow, { encoding: 'utf8', mode: 0o600 });
  } catch (cause) {
    // No invocation handle exists yet: this function still owns the directory,
    // including any partially written file after EIO/ENOSPC.
    await rm(scratchDir, { recursive: true, force: true });
    throw new NikaTransportError('native-process', 'compile could not write its temporary base source', {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  args.push('--base', base, `--change=${change}`);
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
    if (name.length === 0 || name.includes('=') || name.includes('\0')) {
      throw new NikaConfigurationError(
        'compile({ answers }): a question key must be non-empty and cannot carry '
        + "'='; the engine splits KEY=JSON on its first equals sign",
      );
    }
    return `${name}=${literalJson(answers[name])}`;
  });
}

function literalJson(value: unknown): string {
  return encodeLiteralInputs({ value }, 'compile({ change })').json.slice('{"value":'.length, -1);
}

function refuseNul(value: string): void {
  if (value.includes('\0')) throw new NikaConfigurationError('compile: text cannot contain a NUL byte');
}

/** Exact accepted Serve v1 envelope; no local capture or compiler is involved. */
export function compileBody(request: NikaCompileRequest): string {
  compileAnswers(request.answers); // Keep the literal/key law identical across doors.
  const answers = request.answers === undefined ? ''
    : `,"answers":${encodeLiteralInputs(request.answers, 'compile({ answers })').json}`;
  if (request.intent !== undefined) {
    refuseNul(request.intent);
    return `{"compile_version":1,"mode":"create","intent":${JSON.stringify(request.intent)}${answers}}`;
  }
  if (typeof request.change === 'string') refuseNul(request.change);
  const change = typeof request.change === 'string'
    ? `{"text":${JSON.stringify(request.change)}}`
    : `{"set_constant":{"name":${JSON.stringify(request.change.set_constant.name)},"value":${literalJson(request.change.set_constant.value)}}}`;
  return `{"compile_version":1,"mode":"edit","source":${JSON.stringify(request.workflow)},"change":${change}${answers}}`;
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
  validateCompileVersion(payload.compile_version, transport, engine, protocol);
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
  writtenFrom(payload.written, protocol);
  return compilePayloadFrom(payload, transport, engine);
}

/** Shared authoring fields only: native exit/written evidence stays in its adapter. */
export function compilePayloadFrom(
  payload: Record<string, unknown>,
  transport: NikaTransportKind,
  engine: string,
): NikaCompileOutcome {
  const protocol = (message: string) => new NikaProtocolError(transport, `compile at ${engine}: ${message}`);
  validateCompileVersion(payload.compile_version, transport, engine, protocol);
  if ('error' in payload) throw protocol('the payload carries an error instead of an outcome');
  if (transport === 'http' && 'written' in payload) throw protocol('HTTP outcome claims a written destination');
  const status = payload.status;
  if (typeof status !== 'string' || !STATUSES.includes(status as NikaCompileStatus)) {
    throw protocol('unknown compile status');
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
  };
  return outcome;
}

function validateCompileVersion(
  version: unknown,
  transport: NikaTransportKind,
  engine: string,
  protocol: (message: string) => NikaProtocolError,
): void {
  // Wire data is untrusted, including strings that may reflect a credential.
  // Never coerce or echo malformed values (even in an error's cause chain).
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw protocol('compile_version must be a positive safe integer');
  }
  if (version !== COMPILE_WIRE_VERSION) {
    throw new NikaCompatibilityError(COMPILE_CAPABILITY, transport,
      `Engine at ${engine} speaks compile wire ${version}; expected ${COMPILE_WIRE_VERSION}`);
  }
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
      || (question.type !== 'text' && question.type !== 'literal')
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
      || !['applied', 'missed', 'unknown', 'requiresHuman', 'refused'].includes(diagnostic.kind)
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
  if (!preview || preview.scope !== 'sourceOnly' || !machineObject(preview.report)) {
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
    || provenance.cognition !== 'deterministicOnly'
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
