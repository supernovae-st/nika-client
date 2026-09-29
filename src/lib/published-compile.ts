import { types as utilTypes } from 'node:util';
import { NikaConfigurationError, NikaTransportError } from '../errors.js';
import type {
  NikaCompileOptions,
  NikaCompileRequest,
  NikaCompileResult,
  NikaCompileSetConstant,
  NikaPublishedCompileOutcome,
  NikaPublishedCompileRequest,
  NikaTransportKind,
} from '../types.js';
import { encodeLiteralInputs } from './literal-inputs.js';
import { machineObject } from './machine.js';

/*
 * The published 0.120 compile door on this line's resident compile contract.
 * A request is exactly one of two things, told apart by one own field and
 * never guessed: a typed V9 request carries `compile_version` and keeps its
 * own contract (outcome plus the kept-round replay token); a published
 * request (an intent string, `{ intent }`, or `{ workflow, change }`) carries
 * none, is validated as @supernovae-st/nika 0.120.3 validates it on npm,
 * translated once to the V9 `compile_version: 1` wire, and resolves the
 * published outcome projection: the resident's outcome with `ready` derived
 * as `status === 'ready'`. The replay token stays confined to the V9 door:
 * the published door never offered one, so none is handed out here.
 */

const SIGNAL_INTERFACE = new Set([
  'aborted',
  'reason',
  'throwIfAborted',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
]);
// The intrinsics, so a caller that shadows them after the call cannot change what runs.
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const removeSignalListener = EventTarget.prototype.removeEventListener;
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A request is published-shaped when it is a string or an object without its
 * own `compile_version`. What is neither (null, undefined, another primitive,
 * a Proxy) is refused here, before any trap, read or request: telling the
 * doors apart runs no caller code.
 */
export function isPublishedCompileRequest(request: unknown): request is string | NikaPublishedCompileRequest {
  if (typeof request === 'string') return true;
  if (request === null || typeof request !== 'object' || utilTypes.isProxy(request)) {
    throw new NikaConfigurationError('compile: request must be an intent string or a plain object with own data fields');
  }
  return !Object.hasOwn(request, 'compile_version');
}

/**
 * A V9 request that also carries a published-only form is refused before any
 * network, never reinterpreted: `workflow` (the published edit source) or a
 * string `change` (the published free-text edit). Own fields are read as
 * descriptors, so no getter runs here.
 */
export function refuseHybridRequest(request: NikaCompileRequest): void {
  const change = Object.getOwnPropertyDescriptor(request, 'change');
  if (Object.hasOwn(request, 'workflow') || typeof change?.value === 'string') {
    throw new NikaConfigurationError(
      'compile: a request with compile_version is the V9 wire; workflow and a text change belong to the '
      + 'published request shape, and the two are never mixed or reinterpreted',
    );
  }
}

/** Validate a published request exactly as published, and translate it once to the V9 wire. */
export function publishedCompileWire(input: string | NikaPublishedCompileRequest): NikaCompileRequest {
  if (typeof input === 'string') {
    if (input.length === 0) throw new NikaConfigurationError('compile: an intent string must not be empty');
    return { compile_version: 1, mode: 'create', intent: input };
  }
  const record = dataRecord(input, 'request');
  for (const key of Reflect.ownKeys(record)) {
    if (key !== 'intent' && key !== 'workflow' && key !== 'change' && key !== 'answers') {
      throw new NikaConfigurationError(
        `compile: unknown request field ${String(key)}; the request is refused rather than silently reinterpreted`,
      );
    }
  }
  const answers = record.answers === undefined
    ? undefined
    : JSON.parse(encodeLiteralInputs(record.answers, 'compile({ answers })').json) as Record<string, unknown>;
  const { intent, workflow, change } = record;
  if (intent !== undefined) {
    if (workflow !== undefined || change !== undefined) {
      throw new NikaConfigurationError('compile: intent (create) never mixes with workflow/change (edit) in one request');
    }
    if (typeof intent !== 'string' || intent.length === 0) {
      throw new NikaConfigurationError('compile: intent must be a non-empty string');
    }
    return { compile_version: 1, mode: 'create', intent, ...(answers === undefined ? {} : { answers }) };
  }
  if (workflow === undefined && change === undefined) {
    throw new NikaConfigurationError('compile: the request carries neither intent nor workflow/change; nothing would compile');
  }
  if (typeof workflow !== 'string' || workflow.length === 0) {
    throw new NikaConfigurationError('compile: an edit needs the accepted workflow source as a non-empty string');
  }
  return {
    compile_version: 1,
    mode: 'edit',
    source: workflow,
    change: wireChange(change),
    ...(answers === undefined ? {} : { answers }),
  };
}

/** The published outcome projection: the resident's outcome, `ready` derived from its own word. */
export function publishedOutcome(result: NikaCompileResult): NikaPublishedCompileOutcome {
  return { ...result.outcome, ready: result.outcome.status === 'ready' };
}

/** Validate the published options exactly as published: `signal` and `timeoutMs`, nothing else. */
export function publishedCompileOptions(options: unknown): NikaCompileOptions {
  const record = dataRecord(options, 'options');
  for (const key of Reflect.ownKeys(record)) {
    if (key !== 'signal' && key !== 'timeoutMs') {
      throw new NikaConfigurationError(`compile: unknown option ${String(key)}`);
    }
  }
  checkTimeout(record.timeoutMs);
  const signal = record.signal;
  if (signal !== undefined) {
    const invalid = () => new NikaConfigurationError('compile: signal must be an AbortSignal');
    if (signal === null || typeof signal !== 'object' || utilTypes.isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(signal);
    for (const key of Reflect.ownKeys(descriptors)) {
      if ((typeof key === 'string' && SIGNAL_INTERFACE.has(key)) || !('value' in descriptors[key as string])) {
        throw invalid();
      }
    }
    try {
      signalAborted?.call(signal);
    } catch {
      throw invalid();
    }
  }
  return record as NikaCompileOptions;
}

/** `timeoutMs`, when given, is a positive safe integer the platform's timers can hold. */
export function checkTimeout(timeoutMs: unknown): void {
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new NikaConfigurationError(
      `compile: timeoutMs must be a positive safe integer between 1 and ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
}

/**
 * Run one compile under the caller's signal and an optional deadline, and
 * stop waiting the moment the deadline fires, even while the transport is
 * inside a step shared with other callers that takes no signal (the
 * resident's health probe): the call rejects at once, the signal the
 * transport holds is aborted so it sends nothing new, and the shared step is
 * left to finish for whoever else waits on it. The timer and the listener on
 * the caller's signal are released when the call ends, whichever way it ends.
 *
 * `callerStops` (the published door) gives a caller's abort the same
 * immediacy and the published words; otherwise a caller's abort keeps the
 * transport's own error, as the typed door always has, and disarms the
 * deadline so a later timer never renames it.
 */
export async function withDeadline<T>(
  options: NikaCompileOptions,
  transport: NikaTransportKind,
  compile: (signal: AbortSignal | undefined) => Promise<T>,
  callerStops = false,
): Promise<T> {
  const { signal: caller, timeoutMs } = options;
  if (timeoutMs === undefined && !(callerStops && caller)) return compile(caller);
  const controller = new AbortController();
  let stopWaiting!: (error: NikaTransportError) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stopWaiting = reject;
  });
  stopped.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: NikaTransportError) => {
    clearTimeout(timer);
    stopWaiting(error);
    controller.abort(error);
  };
  const abort = () => {
    if (callerStops) {
      stop(new NikaTransportError(transport, 'compile aborted by caller', {
        cause: caller?.reason instanceof Error ? caller.reason : undefined,
      }));
      return;
    }
    clearTimeout(timer);
    controller.abort(caller?.reason);
  };
  if (caller) {
    if (signalAborted?.call(caller)) abort();
    else caller.addEventListener('abort', abort, { once: true });
  }
  try {
    if (callerStops && controller.signal.aborted) return await stopped;
    if (timeoutMs !== undefined && !controller.signal.aborted) {
      timer = setTimeout(() => {
        stop(new NikaTransportError(transport, `compile timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    }
    const operation = compile(controller.signal);
    // Once the wait stopped, a later failure of the abandoned step has no reader.
    operation.catch(() => {});
    return await Promise.race([operation, stopped]);
  } finally {
    clearTimeout(timer);
    if (caller) removeSignalListener.call(caller, 'abort', abort);
  }
}

function wireChange(change: unknown): NonNullable<NikaCompileRequest['change']> {
  if (typeof change === 'string' && change.length > 0) return { text: change };
  if (change === undefined || change === '') {
    throw new NikaConfigurationError('compile: an edit needs a non-empty change request');
  }
  const encoded = encodeLiteralInputs({ change }, 'compile({ change })');
  const object = machineObject((JSON.parse(encoded.json) as { change: unknown }).change);
  const constant = machineObject(object?.set_constant);
  if (!object || Object.keys(object).length !== 1 || !constant || Object.keys(constant).length !== 2
    || !('value' in constant) || typeof constant.name !== 'string' || !/^[A-Za-z0-9_]+$/.test(constant.name)) {
    throw new NikaConfigurationError(
      'compile: an edit needs a non-empty change string or set_constant with a bare name and JSON value',
    );
  }
  return object as unknown as NikaCompileSetConstant;
}

function dataRecord(value: unknown, label: 'request' | 'options'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new NikaConfigurationError(
      `compile: ${label} must be ${label === 'request' ? 'an intent string or ' : ''}a plain object with own data fields`,
    );
  }
  const result = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string];
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) {
      throw new NikaConfigurationError(`compile: ${label} must contain only enumerable string data fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}
