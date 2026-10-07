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
  NikaCompileAuthoringReceipt,
  NikaCompileCreateRequest,
  NikaCompileDiagnostic,
  NikaCompileEditRequest,
  NikaCompileLimits,
  NikaCompileOptions,
  NikaCompileOutcome,
  NikaCompilePreview,
  NikaCompileProvenance,
  NikaCompileQuestion,
  NikaCompileRecordError,
  NikaCompileRequest,
  NikaCompileStatus,
  NikaCompileSetConstant,
  NikaCompileTrigger,
  NikaTransportKind,
} from '../types.js';
import type { EngineCapture } from './engine-capture.js';
import { encodeLiteralInputs } from './literal-inputs.js';
import { machineObject } from './machine.js';

/**
 * The compile adapters (issue #128): thin projections over the engine's one
 * authoring capability, reached through `nika compile --json` natively and
 * `POST /v1/compile` over HTTP. Both print the core's ONE machine document
 * (engine `nika-compile/src/wire.rs::outcome_document`). There is no compiler
 * in this file: no intent parsing, no YAML work, no policy judgment. The SDK
 * validates the envelope, preserves the engine's fields verbatim, and
 * classifies failures.
 *
 * The document has two generations: `compile_version: 2` exactly when a
 * provider call happened (`provenance.authoring` is its receipt), 1 otherwise.
 * A request may only receive a generation it could have opened: a provider
 * round (HTTP `explicitProvider`, a native seat: `--authoring-model` or
 * `--decision-model`) 1 or 2, every other request — a replay included — 1.
 *
 * The native wire law (engine `nika-cli-host/src/compile/render.rs`):
 *
 * - exit 0 + `{compile_version, status:'ready', …}` — a complete candidate.
 * - exit 2 + `{compile_version, status:'incomplete'|'refused', …}` — DATA:
 *   questions and diagnostics, never an exception.
 * - exit 2 or 3 + `{compile_version:1, error:{code,message}}` — an
 *   engine-stamped failure (usage or environment/machinery).
 *
 * Anything else — a dead child, a truncated or malformed payload, a version
 * this request cannot receive, an outcome contradicting its exit code or
 * calling a held candidate ready — is a typed failure. A partial `ready` from a
 * dead child is never accepted.
 */

/** The capability an engine advertises once it speaks the compile wire. */
export const COMPILE_CAPABILITY = 'compile';

/**
 * The capability a resident advertises once its operator seated a native
 * authoring model: `POST /v1/compile` then also speaks generation 2
 * (engine `nika-serve/src/server/model.rs`).
 */
export const COMPILE_NATIVE_V2_CAPABILITY = 'compileNativeV2';

/** The foundation compile wire generation every door speaks. */
export const COMPILE_WIRE_VERSION = 1;

/** The generation an outcome carries exactly when a provider call happened. */
export const COMPILE_PROVIDER_WIRE_VERSION = 2;

/** The response header of a fresh generation-2 round whose native plan the server keeps. */
export const COMPILE_REPLAY_HEADER = 'Nika-Compile-Replay';

/**
 * Finite bound for one compile response (the candidate plus its full Check
 * report in one JSON document). Overflow kills the child and fails typed
 * (`NikaProtocolError`); the SDK never parses a truncated payload.
 */
export const COMPILE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/** How long a stopped compile child may take to exit before SIGKILL insists. */
export const COMPILE_KILL_GRACE_MS = 2_000;

/**
 * How long past a fresh round's absolute deadline the server waits for the
 * round's work to hand over its answer (engine
 * `nika-serve/src/server/compile/author.rs` `HANDOFF`).
 */
export const COMPILE_SERVER_HANDOFF_MS = 5_000;

const MAX_TIMER_MS = 0x7fffffff;

const STATUSES: readonly NikaCompileStatus[] = ['ready', 'incomplete', 'refused'];
const COGNITIONS: readonly string[] = ['deterministicOnly', 'explicitProvider', 'explicitDecision'];
const QUESTION_TYPES: readonly string[] = ['text', 'literal', 'choice'];
const DIAGNOSTIC_KINDS: readonly string[] = ['applied', 'missed', 'unknown', 'requiresHuman', 'refused'];
const TRIGGER_TEXT_FIELDS = [
  'source_hint', 'event_hint', 'cadence', 'cron', 'at', 'payload_input',
  'timezone', 'missed', 'overlap', 'ceiling',
] as const;
/** The facts only the CLI adapter adds to the core's document. */
const CLI_ONLY_FIELDS = ['written', 'existing_destination', 'plan_record_error', 'declined_record_error'] as const;
/** The verifier's markers: a held candidate, and a withdrawn unjudged one. Neither is ever ready. */
const HELD_TARGET = 'verify_held';
const RESUME_TARGET = 'verify_resume';
/** 32 random bytes as lowercase hex: the only token spelling a server issues. */
const REPLAY_TOKEN = /^[0-9a-f]{64}$/;
const U32_MAX = 4_294_967_295;
/** The wire bounds of each limit (`CompileRequestV2.limits`): [minimum, maximum]. */
const LIMIT_BOUNDS: Readonly<Record<keyof NikaCompileLimits, readonly [number, number]>> = {
  max_calls: [1, U32_MAX],
  repairs: [0, U32_MAX],
  max_tokens: [1, U32_MAX],
  call_timeout_ms: [1, Number.MAX_SAFE_INTEGER],
  deadline_ms: [1, Number.MAX_SAFE_INTEGER],
};
const CREATE_ONLY_FIELDS = ['workflow_id', 'decisionModel', 'fresh'] as const;
const REQUEST_FIELDS = new Set<string>([
  'intent', ...CREATE_ONLY_FIELDS,
  'workflow', 'change', 'original_intent',
  'answers', 'cognition', 'limits', 'replay_token', 'authoringModel', 'output',
]);
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const removeSignalListener = EventTarget.prototype.removeEventListener;
const signalInterface = new Set([
  'aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener', 'dispatchEvent',
]);

type SharedRequestFields = Pick<
  NikaCompileCreateRequest,
  'cognition' | 'limits' | 'replay_token' | 'authoringModel' | 'output'
>;

/**
 * Caller-facing request validation: unknown shapes refuse, never downgrade.
 * The laws judged here are the request's own shape and the published pairing
 * rules of the wire (a replay token rides `deterministicOnly`, limits bound a
 * provider round, `original_intent` stands beside a text change). What only a
 * transport can judge — a field the other door owns — is judged there.
 */
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
    if (typeof key !== 'string' || !REQUEST_FIELDS.has(key)) {
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
    if (record.original_intent !== undefined) {
      throw new NikaConfigurationError(
        'compile: original_intent names the request an edited base answered; a create request carries its own intent',
      );
    }
    const create: NikaCompileCreateRequest = { intent };
    const workflowId = optionalText(record.workflow_id, 'workflow_id');
    if (workflowId !== undefined) create.workflow_id = workflowId;
    if (answers !== undefined) create.answers = answers as Record<string, unknown>;
    Object.assign(create, sharedFields(record));
    const decisionModel = optionalText(record.decisionModel, 'decisionModel');
    if (decisionModel !== undefined) create.decisionModel = decisionModel;
    const fresh = record.fresh;
    if (fresh !== undefined && typeof fresh !== 'boolean') {
      throw new NikaConfigurationError('compile: fresh must be a boolean');
    }
    if (fresh === true) create.fresh = true;
    return create;
  }
  if (workflow === undefined && change === undefined) {
    throw new NikaConfigurationError(
      'compile: the request carries neither intent nor workflow/change; nothing would compile',
    );
  }
  for (const key of CREATE_ONLY_FIELDS) {
    if (record[key] !== undefined) {
      throw new NikaConfigurationError(
        `compile: ${key} belongs to a create request (intent); an edit cannot carry it`,
      );
    }
  }
  if (typeof workflow !== 'string' || workflow.length === 0) {
    throw new NikaConfigurationError(
      'compile: an edit needs the accepted workflow source as a non-empty string',
    );
  }
  const normalizedChange = normalizeChange(change);
  const edit: NikaCompileEditRequest = { workflow, change: normalizedChange };
  const originalIntent = optionalText(record.original_intent, 'original_intent');
  if (originalIntent !== undefined) {
    if (typeof normalizedChange !== 'string') {
      throw new NikaConfigurationError(
        'compile: original_intent is read beside a text change; a set_constant edit is applied without it',
      );
    }
    edit.original_intent = originalIntent;
  }
  if (answers !== undefined) edit.answers = answers as Record<string, unknown>;
  Object.assign(edit, sharedFields(record));
  return edit;
}

/** The fields both shapes carry, with the wire's pairing rules. */
function sharedFields(record: Record<string, unknown>): SharedRequestFields {
  const fields: SharedRequestFields = {};
  const cognition = record.cognition;
  if (cognition !== undefined) {
    if (cognition !== 'explicitProvider' && cognition !== 'deterministicOnly') {
      throw new NikaConfigurationError(
        'compile: cognition must be explicitProvider or deterministicOnly',
      );
    }
    fields.cognition = cognition;
  }
  const token = record.replay_token;
  if (token !== undefined) {
    // Never quoted: the token is a server-issued handle.
    if (typeof token !== 'string' || !REPLAY_TOKEN.test(token)) {
      throw new NikaConfigurationError(
        'compile: replay_token must be the 64 lowercase hexadecimal digits of a Nika-Compile-Replay header',
      );
    }
    if (cognition !== 'deterministicOnly') {
      throw new NikaConfigurationError(
        "compile: a replay_token rides cognition 'deterministicOnly' (a zero-call replay of a "
        + 'kept round), never a fresh round',
      );
    }
    fields.replay_token = token;
  }
  const authoringModel = optionalText(record.authoringModel, 'authoringModel');
  if (authoringModel !== undefined) fields.authoringModel = authoringModel;
  if (record.limits !== undefined) {
    const limits = normalizeLimits(record.limits);
    if (cognition === 'deterministicOnly') {
      throw new NikaConfigurationError(
        'compile: limits bound a provider round; a deterministicOnly request makes no call',
      );
    }
    if (cognition !== 'explicitProvider' && authoringModel === undefined) {
      throw new NikaConfigurationError(
        "compile: limits bound a provider round: name cognition 'explicitProvider' (HTTP) "
        + 'or authoringModel (local engine)',
      );
    }
    fields.limits = limits;
  }
  const output = optionalText(record.output, 'output');
  if (output !== undefined) fields.output = output;
  return fields;
}

/** Integers within the wire's published bounds; an operator ceiling is the server's to judge. */
function normalizeLimits(value: unknown): NikaCompileLimits {
  const record = dataRecord(value, 'limits');
  const limits: NikaCompileLimits = {};
  for (const key of Reflect.ownKeys(record)) {
    const bounds = typeof key === 'string' && Object.hasOwn(LIMIT_BOUNDS, key)
      ? LIMIT_BOUNDS[key as keyof NikaCompileLimits]
      : undefined;
    if (!bounds) {
      throw new NikaConfigurationError(
        `compile: unknown limit ${String(key)}; limits are max_calls, repairs, max_tokens, `
        + 'call_timeout_ms and deadline_ms',
      );
    }
    const number = record[key as string];
    if (typeof number !== 'number' || !Number.isSafeInteger(number)
      || number < bounds[0] || number > bounds[1]) {
      throw new NikaConfigurationError(
        `compile: limits.${String(key)} must be an integer from ${bounds[0]} to ${bounds[1]}`,
      );
    }
    limits[key as keyof NikaCompileLimits] = number;
  }
  return limits;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new NikaConfigurationError(`compile: ${field} must be a non-empty string`);
  }
  refuseNul(value);
  return value;
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

/**
 * Caller-facing options validation: reject direct signal overrides before use.
 * Standard AbortSignals, including composites, are supported. Their hidden
 * source graph remains Node's responsibility: on some Node versions even an
 * intrinsic state getter reads public fields of composite sources. Sources
 * with caller-modified interfaces are outside the no-accessor guarantee.
 */
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
    // Give downstream code our own signal so it does not traverse the caller's
    // source graph. Reading/subscribing here still uses Node's composite
    // semantics (see normalizeCompileOptions). addAbortListener resists an
    // earlier listener's stopImmediatePropagation.
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
  /** The wire generations this invocation may answer: 2 only beside a seat. */
  readonly accepted: readonly number[];
}

/**
 * Build the compile argv (engine `nika-cli-host/src/compile.rs::CompileArgs`).
 * Injection laws: every caller-controlled option value rides the
 * `--name=value` form (a value that starts with a dash stays data), the
 * positional always follows an explicit `--`, and no shell is ever involved
 * (the capture spawns argv directly). A field only the HTTP wire has is a
 * typed gap here, before any process exists.
 */
export async function compileArgv(request: NikaCompileRequest): Promise<CompileInvocation> {
  refuseWireOnlyFields(request);
  const args = ['compile', '--json'];
  for (const answer of compileAnswers(request.answers)) {
    args.push(`--answer=${answer}`);
  }
  args.push(...seatFlags(request));
  // Only a seat can call a provider; the receipt check still pairs 2 with its receipt.
  const accepted = request.authoringModel === undefined && request.decisionModel === undefined
    ? [COMPILE_WIRE_VERSION]
    : [COMPILE_WIRE_VERSION, COMPILE_PROVIDER_WIRE_VERSION];
  if (request.intent !== undefined) {
    refuseNul(request.intent);
    args.push('--', request.intent);
    return { args, accepted };
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
  // The positional beside `--base` is the request the base answered.
  if (request.original_intent !== undefined) args.push('--', request.original_intent);
  return { args, scratchDir, accepted };
}

/** The local engine's own flags, in the CLI's spelling. */
function seatFlags(request: NikaCompileRequest): string[] {
  const flags: string[] = [];
  if (request.authoringModel !== undefined) flags.push(`--authoring-model=${request.authoringModel}`);
  if (request.decisionModel !== undefined) flags.push(`--decision-model=${request.decisionModel}`);
  const limits = request.limits;
  if (limits?.max_calls !== undefined) flags.push(`--authoring-max-calls=${limits.max_calls}`);
  if (limits?.repairs !== undefined) flags.push(`--authoring-repairs=${limits.repairs}`);
  if (limits?.max_tokens !== undefined) flags.push(`--authoring-max-tokens=${limits.max_tokens}`);
  if (limits?.call_timeout_ms !== undefined) {
    flags.push(`--authoring-timeout=${limits.call_timeout_ms / 1000}`);
  }
  if (request.fresh === true) flags.push('--fresh');
  if (request.output !== undefined) flags.push(`--output=${request.output}`);
  return flags;
}

/** HTTP wire fields with no local flag: a typed gap, never a silent drop. */
function refuseWireOnlyFields(request: NikaCompileRequest): void {
  const gap = (field: string, why: string) => new NikaCompatibilityError(
    'compileOptions', 'native-process', `compile: ${field} ${why}`,
  );
  if (request.cognition !== undefined) {
    throw gap('cognition', 'is a field of POST /v1/compile; on a local engine the seat you name '
      + '(authoringModel or decisionModel) is the cognition, and without one it is deterministic');
  }
  if (request.replay_token !== undefined) {
    throw gap('replay_token', 'names a round a nika serve run kept; a local engine replays the '
      + 'plan it recorded under .nika/compile/ when an answer round repeats the intent');
  }
  if (request.workflow_id !== undefined) {
    throw gap('workflow_id', 'has no local flag; there the output file name names the created workflow');
  }
  const limits = request.limits;
  if (limits?.deadline_ms !== undefined) {
    throw gap('limits.deadline_ms', 'has no local flag; bound the compile child with timeoutMs or signal');
  }
  if (limits?.call_timeout_ms !== undefined && limits.call_timeout_ms % 1000 !== 0) {
    throw gap('limits.call_timeout_ms', 'must be whole seconds on a local engine (--authoring-timeout takes seconds)');
  }
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

/** One `POST /v1/compile` request, and what its answer may be. */
export interface CompileHttpRequest {
  /** The exact JSON body. */
  readonly body: string;
  /** The request's wire generation. */
  readonly generation: 1 | 2;
  /** The `/health` capability the request needs. */
  readonly capability: string;
  /** The wire generations its answer may carry. */
  readonly accepted: readonly number[];
  /** A fresh provider round: it may spend, and only its answer may carry a replay token. */
  readonly provider: boolean;
}

/**
 * The client's deadline for one HTTP compile, in milliseconds, or none.
 *
 * - The caller's `timeoutMs` always wins.
 * - A generation-1 request or a replay is answered within the server's
 *   request deadline: the client keeps its `requestTimeout`.
 * - A fresh provider round is bounded by the server only when the operator
 *   configured a deadline or the request carries `limits.deadline_ms`. With
 *   that explicit deadline the client waits for it, the server's handoff and
 *   one `requestTimeout` more, so the server's own 408
 *   `compile_deadline_exceeded` arrives before the client stops waiting.
 *   Without it the SDK sets no deadline: stopping the wait would neither stop
 *   the round nor its spend, and would lose its answer and replay token.
 */
export function compileTimeoutMs(
  request: NikaCompileRequest,
  provider: boolean,
  timeoutMs: number | undefined,
  requestTimeout: number,
): number | undefined {
  if (timeoutMs !== undefined) return timeoutMs;
  if (!provider) return requestTimeout;
  const deadline = request.limits?.deadline_ms;
  return deadline === undefined
    ? undefined
    : Math.min(deadline + COMPILE_SERVER_HANDOFF_MS + requestTimeout, MAX_TIMER_MS);
}

/**
 * The exact Serve envelope (engine `nika-serve/src/server/compile.rs` for
 * generation 1, `compile/v2.rs` for generation 2); no local capture or
 * compiler is involved. Generation 2 is the provider round
 * (`explicitProvider`) and the replay of a kept one (`deterministicOnly` +
 * `replay_token`); everything else is generation 1, byte for byte as before.
 */
export function compileRequest(request: NikaCompileRequest): CompileHttpRequest {
  refuseNativeOnlyFields(request);
  compileAnswers(request.answers); // Keep the literal/key law identical across doors.
  const answers = request.answers === undefined ? ''
    : `,"answers":${encodeLiteralInputs(request.answers, 'compile({ answers })').json}`;
  const provider = request.cognition === 'explicitProvider';
  const generation: 1 | 2 = provider || request.replay_token !== undefined
    ? COMPILE_PROVIDER_WIRE_VERSION
    : COMPILE_WIRE_VERSION;
  const head = `{"compile_version":${generation},"mode":"${request.intent !== undefined ? 'create' : 'edit'}"`
    + (request.cognition === undefined ? '' : `,"cognition":"${request.cognition}"`);
  let input: string;
  if (request.intent !== undefined) {
    refuseNul(request.intent);
    input = `,"intent":${JSON.stringify(request.intent)}`
      + (request.workflow_id === undefined ? '' : `,"workflow_id":${JSON.stringify(request.workflow_id)}`);
  } else {
    if (typeof request.change === 'string') refuseNul(request.change);
    if (request.original_intent !== undefined && generation === COMPILE_WIRE_VERSION) {
      throw new NikaConfigurationError(
        "compile: original_intent is a generation-2 field: send cognition 'explicitProvider' "
        + '(or replay a kept round) to revise against it',
      );
    }
    if (generation === COMPILE_PROVIDER_WIRE_VERSION && typeof request.change === 'string'
      && request.original_intent === undefined) {
      throw new NikaConfigurationError(
        'compile: a generation-2 text change is read beside the request its base answered: add original_intent',
      );
    }
    const change = typeof request.change === 'string'
      ? `{"text":${JSON.stringify(request.change)}}`
      : `{"set_constant":{"name":${JSON.stringify(request.change.set_constant.name)},"value":${literalJson(request.change.set_constant.value)}}}`;
    input = `,"source":${JSON.stringify(request.workflow)},"change":${change}`
      + (request.original_intent === undefined ? '' : `,"original_intent":${JSON.stringify(request.original_intent)}`);
  }
  const limits = request.limits === undefined ? '' : `,"limits":${JSON.stringify(request.limits)}`;
  const token = request.replay_token === undefined ? '' : `,"replay_token":"${request.replay_token}"`;
  return {
    body: `${head}${input}${answers}${limits}${token}}`,
    generation,
    capability: generation === COMPILE_PROVIDER_WIRE_VERSION
      ? COMPILE_NATIVE_V2_CAPABILITY
      : COMPILE_CAPABILITY,
    accepted: provider
      ? [COMPILE_WIRE_VERSION, COMPILE_PROVIDER_WIRE_VERSION]
      : [COMPILE_WIRE_VERSION],
    provider,
  };
}

/** Local engine flags with no field on the HTTP wire: a typed gap, never a silent drop. */
function refuseNativeOnlyFields(request: NikaCompileRequest): void {
  const fields = [
    ['authoringModel', '--authoring-model'],
    ['decisionModel', '--decision-model'],
    ['fresh', '--fresh'],
    ['output', '--output'],
  ] as const;
  for (const [field, flag] of fields) {
    if (request[field] !== undefined) {
      throw new NikaCompatibilityError(
        'compileOptions',
        'http',
        `compile: ${field} is the local engine's ${flag} flag; POST /v1/compile has no such field `
        + "(the server's operator seats the authoring model, and the server writes no file)",
      );
    }
  }
}

/** What a native invocation asked for, to judge its answer against. */
export interface CompileExpectation {
  /** The generations the request may receive. Default: generation 1 only. */
  readonly accepted?: readonly number[];
  /** The destination the request named (`--output`), if any. */
  readonly output?: string;
}

/**
 * Project one captured compile invocation to the outcome, or throw the typed
 * failure the convention assigns. See the module header for the wire law.
 */
export function compileOutcomeFrom(
  captured: EngineCapture,
  transport: NikaTransportKind,
  engine: string,
  expectation: CompileExpectation = {},
): NikaCompileOutcome {
  const accepted = expectation.accepted ?? [COMPILE_WIRE_VERSION];
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
  validateCompileVersion(payload.compile_version, transport, engine, protocol, accepted);
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
  const outcome = compilePayloadFrom(payload, transport, engine, accepted);
  return { ...outcome, ...cliFacts(payload, outcome.status, expectation.output, protocol) };
}

/**
 * The facts only the CLI adapter adds (render.rs): `written`, surfaced only
 * when the request named a destination; the destination it left in place;
 * and its own record-keeping failures under `.nika/compile/`.
 */
function cliFacts(
  payload: Record<string, unknown>,
  status: NikaCompileStatus,
  output: string | undefined,
  protocol: (message: string) => NikaProtocolError,
): Partial<NikaCompileOutcome> {
  const written = payload.written;
  if (output === undefined) {
    // The SDK passed no destination, so the engine can never have written.
    if (written !== null) {
      throw protocol('the outcome claims a written destination the SDK never asked for');
    }
  } else if (written !== null && (written !== output || status !== 'ready')) {
    // Only a ready candidate is written, and only where the request named.
    throw protocol('the outcome claims a written destination other than the ready candidate the SDK named');
  }
  const facts: Partial<NikaCompileOutcome> = output === undefined
    ? {}
    : { written: written as string | null };
  if ('existing_destination' in payload) {
    if (output === undefined || payload.existing_destination !== output || written !== null) {
      throw protocol('existing_destination names no destination this request left in place');
    }
    facts.existing_destination = output;
  }
  for (const field of ['plan_record_error', 'declined_record_error'] as const) {
    if (field in payload) facts[field] = recordError(payload[field], field, protocol);
  }
  return facts;
}

function recordError(
  value: unknown,
  field: string,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileRecordError {
  const record = machineObject(value);
  if (!record || typeof record.path !== 'string' || typeof record.message !== 'string') {
    throw protocol(`${field} lacks its path/message strings`);
  }
  return record as NikaCompileRecordError;
}

/** Shared authoring fields only: native exit/written evidence stays in its adapter. */
export function compilePayloadFrom(
  payload: Record<string, unknown>,
  transport: NikaTransportKind,
  engine: string,
  accepted: readonly number[] = [COMPILE_WIRE_VERSION],
): NikaCompileOutcome {
  const protocol = (message: string) => new NikaProtocolError(transport, `compile at ${engine}: ${message}`);
  validateCompileVersion(payload.compile_version, transport, engine, protocol, accepted);
  if ('error' in payload) throw protocol('the payload carries an error instead of an outcome');
  if (transport === 'http') {
    for (const field of CLI_ONLY_FIELDS) {
      if (field in payload) throw protocol(`HTTP outcome carries the local engine's ${field}`);
    }
  }
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
  const diagnostics = diagnosticsFrom(payload.diagnostics, protocol);
  if (status === 'ready' && diagnostics.some((diagnostic) => diagnostic.kind === 'applied'
    && (diagnostic.target === HELD_TARGET || diagnostic.target === RESUME_TARGET))) {
    // A held candidate is a preview and a withdrawn one is no candidate: neither is ever ready.
    throw protocol('a ready outcome carries the verifier\'s verify_held or verify_resume marker');
  }
  const version = payload.compile_version as 1 | 2;
  const outcome: NikaCompileOutcome = {
    compile_version: version,
    status: status as NikaCompileStatus,
    ready: status === 'ready',
    candidate,
    questions: questionsFrom(payload.questions, protocol),
    diagnostics,
    requested_boundary: nullableObject(payload.requested_boundary, 'requested_boundary', protocol),
    ...('requested_trigger' in payload
      ? { requested_trigger: triggerFrom(payload.requested_trigger, protocol) }
      : {}),
    check_preview: previewFrom(payload.check_preview, protocol),
    provenance: provenanceFrom(payload.provenance, version, protocol),
  };
  return outcome;
}

function validateCompileVersion(
  version: unknown,
  transport: NikaTransportKind,
  engine: string,
  protocol: (message: string) => NikaProtocolError,
  accepted: readonly number[],
): void {
  // Wire data is untrusted, including strings that may reflect a credential.
  // Never coerce or echo malformed values (even in an error's cause chain).
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw protocol('compile_version must be a positive safe integer');
  }
  if (!accepted.includes(version)) {
    throw new NikaCompatibilityError(COMPILE_CAPABILITY, transport,
      `Engine at ${engine} speaks compile wire ${version}; expected ${accepted.join(' or ')}`);
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
      || typeof question.type !== 'string'
      || !QUESTION_TYPES.includes(question.type)
      || typeof question.why !== 'string'
      || typeof question.mandatory !== 'boolean'
    ) {
      throw protocol('a question lacks its key/label/type/why/mandatory shape');
    }
    if ('options' in question && (!Array.isArray(question.options)
      || !question.options.every((option) => {
        const choice = machineObject(option);
        return choice !== undefined && typeof choice.key === 'string' && typeof choice.label === 'string';
      }))) {
      throw protocol('a question\'s options lack their key/label shape');
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
      || !DIAGNOSTIC_KINDS.includes(diagnostic.kind)
      || typeof diagnostic.target !== 'string'
      || typeof diagnostic.message !== 'string'
    ) {
      throw protocol('a diagnostic lacks its kind/target/message shape');
    }
    return diagnostic as unknown as NikaCompileDiagnostic;
  });
}

function triggerFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileTrigger | null {
  if (value === null) return null;
  const trigger = machineObject(value);
  if (!trigger || typeof trigger.kind !== 'string' || typeof trigger.status !== 'string') {
    throw protocol('requested_trigger lacks its kind/status shape');
  }
  for (const field of TRIGGER_TEXT_FIELDS) {
    if (field in trigger && trigger[field] !== null && typeof trigger[field] !== 'string') {
      throw protocol(`requested_trigger.${field} is neither text nor null`);
    }
  }
  return trigger as NikaCompileTrigger;
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
  version: 1 | 2,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileProvenance {
  const provenance = machineObject(value);
  if (
    !provenance
    || typeof provenance.compiler_version !== 'string'
    || typeof provenance.spec_pin !== 'string'
    || (provenance.skeleton !== null && typeof provenance.skeleton !== 'string')
    || typeof provenance.cognition !== 'string'
    || !COGNITIONS.includes(provenance.cognition)
  ) {
    throw protocol('provenance lacks its compiler_version/spec_pin/skeleton/cognition shape');
  }
  if ('strategy' in provenance && typeof provenance.strategy !== 'string') {
    throw protocol('provenance.strategy is not a word');
  }
  if ('suggested_file' in provenance && provenance.suggested_file !== null
    && typeof provenance.suggested_file !== 'string') {
    throw protocol('provenance.suggested_file is neither text nor null');
  }
  for (const field of ['plan', 'decision'] as const) {
    if (field in provenance && !machineObject(provenance[field])) {
      throw protocol(`provenance.${field} is not an object`);
    }
  }
  // The engine prints generation 2 exactly when the receipt exists (wire.rs).
  const receipt = 'authoring' in provenance;
  if (receipt !== (version === COMPILE_PROVIDER_WIRE_VERSION)) {
    throw protocol(receipt
      ? 'a compile_version 1 outcome carries a provider-call receipt'
      : 'a compile_version 2 outcome carries no provenance.authoring receipt');
  }
  if (receipt) authoringFrom(provenance.authoring, protocol);
  return provenance as unknown as NikaCompileProvenance;
}

function authoringFrom(
  value: unknown,
  protocol: (message: string) => NikaProtocolError,
): NikaCompileAuthoringReceipt {
  const receipt = machineObject(value);
  const count = (field: unknown, nullable = false) => (nullable && field === null)
    || (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0);
  if (
    !receipt
    || typeof receipt.model !== 'string'
    || !count(receipt.calls)
    || !count(receipt.input_tokens, true)
    || !count(receipt.output_tokens, true)
    || !count(receipt.elapsed_ms)
    || !machineObject(receipt.sampling)
    || !Array.isArray(receipt.context)
    || !receipt.context.every((entry) => machineObject(entry) !== undefined)
    || (receipt.backend !== null && !machineObject(receipt.backend))
  ) {
    throw protocol('provenance.authoring lacks its model/calls/tokens/elapsed_ms/sampling/context/backend shape');
  }
  return receipt as unknown as NikaCompileAuthoringReceipt;
}

/**
 * Whether the verifier held this outcome's candidate: it answered on these
 * bytes against the request and did not accept them (the engine's `applied`
 * diagnostic targeting `verify_held`). Such an outcome is `incomplete` and its
 * `candidate` is a preview to show at most — never run it or save it as an
 * accepted result. A server keeps no replay token for it, so asking again is a
 * fresh round.
 */
export function isNikaCompileHeld(outcome: NikaCompileOutcome): boolean {
  return outcome.diagnostics.some(
    (diagnostic) => diagnostic.kind === 'applied' && diagnostic.target === HELD_TARGET,
  );
}

/**
 * The request of the next round of a compile: the same input with these
 * answers added to the previous ones (a later answer to the same key wins).
 * It maps; it judges nothing and never decides to spend for you.
 *
 * - When `outcome` carries a `replay_token` (HTTP, a fresh round whose native
 *   plan the server keeps), the next request replays that round with zero
 *   provider calls: the exact input, `cognition: 'deterministicOnly'`, the
 *   token, and no `limits`. A replay binds the answers into the kept plan but
 *   asks no verifier, so a model-authored candidate stays `incomplete`, a
 *   preview whose judgment is pending (`provenance.decision.pending`). A
 *   judged, ready candidate needs a new `explicitProvider` round carrying the
 *   answers — your first request with `answers` — and that round may spend.
 * - Otherwise the previous request is repeated with the merged answers. A
 *   replay request keeps its token. A local engine replays the plan it
 *   recorded under `.nika/compile/` in its working directory when the round
 *   carries at least one answer (so `fresh` is dropped), and the seat's judge
 *   may then decide it; a local round with no answer reads the intent again.
 *   An HTTP `explicitProvider` request without a token is a new fresh round:
 *   it may spend again. A deterministic request is stateless.
 *
 * A loop over rounds should stop when a round brings no new answer. An
 * `intent.clarification` answer replaces the request: a server refuses it as
 * an answer (`compile_new_intent_required`, `compile_replay_input_changed`);
 * start a new create request with the replacement intent instead.
 */
export function nextCompileRequest(
  previous: string | NikaCompileRequest,
  outcome: NikaCompileOutcome,
  answers: Record<string, unknown>,
): NikaCompileRequest {
  const request = normalizeCompileRequest(previous);
  encodeLiteralInputs(answers, 'compile({ answers })');
  const merged: Record<string, unknown> = { ...request.answers, ...answers };
  const token = replayTokenOf(outcome);
  if (token !== undefined) {
    if (request.intent !== undefined) {
      return {
        intent: request.intent,
        ...(request.workflow_id === undefined ? {} : { workflow_id: request.workflow_id }),
        answers: merged,
        cognition: 'deterministicOnly',
        replay_token: token,
      };
    }
    return {
      workflow: request.workflow,
      change: request.change,
      ...(request.original_intent === undefined ? {} : { original_intent: request.original_intent }),
      answers: merged,
      cognition: 'deterministicOnly',
      replay_token: token,
    };
  }
  if (request.intent !== undefined) {
    const { fresh: _fresh, ...create } = request;
    return { ...create, answers: merged };
  }
  return { ...request, answers: merged };
}

/** The outcome's replay token, read from its own data descriptor only. */
function replayTokenOf(outcome: NikaCompileOutcome): string | undefined {
  if (outcome === null || typeof outcome !== 'object' || utilTypes.isProxy(outcome)) {
    throw new NikaConfigurationError('compile: the outcome must be the object compile() resolved');
  }
  const descriptor = Object.getOwnPropertyDescriptor(outcome, 'replay_token');
  if (descriptor === undefined) return undefined;
  const token = 'value' in descriptor ? descriptor.value : undefined;
  if (typeof token !== 'string' || !REPLAY_TOKEN.test(token)) {
    throw new NikaConfigurationError(
      'compile: the outcome\'s replay_token is not the 64 lowercase hexadecimal digits a server issues',
    );
  }
  return token;
}
