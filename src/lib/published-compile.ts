import { addAbortListener } from 'node:events';
import { types as utilTypes } from 'node:util';
import { NikaConfigurationError, NikaTransportError } from '../errors.js';
import type { NikaCompileOptions, NikaCompileWireRequest, NikaPublishedCompileRequest, NikaTransportKind } from '../types.js';

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const removeSignalListener = EventTarget.prototype.removeEventListener;

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
export function refuseHybridRequest(request: NikaCompileWireRequest): void {
  const change = Object.getOwnPropertyDescriptor(request, 'change');
  if (Object.hasOwn(request, 'workflow') || typeof change?.value === 'string') {
    throw new NikaConfigurationError(
      'compile: a request with compile_version is the V9 wire; workflow and a text change belong to the '
      + 'published request shape, and the two are never mixed or reinterpreted',
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
 */
export async function withDeadline<T>(
  options: NikaCompileOptions,
  transport: NikaTransportKind,
  compile: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const { signal: caller, timeoutMs } = options;
  if (timeoutMs === undefined && !caller) return compile(caller);
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
    stop(new NikaTransportError(transport, 'compile aborted by caller', {
      cause: caller?.reason instanceof Error ? caller.reason : undefined,
    }));
  };
  if (caller) {
    if (signalAborted?.call(caller)) abort();
    else addAbortListener(caller, abort);
  }
  try {
    if (controller.signal.aborted) return await stopped;
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
