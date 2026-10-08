import type {
  NikaOperation,
  NikaOperationFinding,
  NikaSessionSnapshot,
  NikaTransportKind,
} from './types.js';

export class NikaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NikaError';
  }
}

export class NikaConfigurationError extends NikaError {
  constructor(message: string) {
    super(message);
    this.name = 'NikaConfigurationError';
  }
}

export class NikaTransportError extends NikaError {
  readonly transport: NikaTransportKind;

  constructor(transport: NikaTransportKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NikaTransportError';
    this.transport = transport;
  }
}

/** A typed engine/adapter capability gap, not a workflow failure. */
export class NikaCompatibilityError extends NikaError {
  readonly capability: string;
  readonly transport: NikaTransportKind;

  constructor(
    capability: string,
    transport: NikaTransportKind,
    message: string,
  ) {
    super(message);
    this.name = 'NikaCompatibilityError';
    this.capability = capability;
    this.transport = transport;
  }
}

export class NikaProtocolError extends NikaTransportError {
  constructor(transport: NikaTransportKind, message: string, options?: ErrorOptions) {
    super(transport, message, options);
    this.name = 'NikaProtocolError';
  }
}

/**
 * Observation broke before terminal settlement and the final durable read
 * stayed non-terminal. The cursor feeds attachRun(id, { lastEventId }).
 *
 * This is about the client's view, never about the run: the run may still be
 * running on the resident. It is not the engine's own `interrupted` state,
 * which arrives as a `run.interrupted` event and as `result.status`.
 */
export class NikaObservationInterrupted extends NikaTransportError {
  readonly runId: string;
  readonly lastSequence: number;
  readonly attempts: number;

  constructor(
    transport: NikaTransportKind,
    runId: string,
    lastSequence: number,
    attempts: number,
  ) {
    super(
      transport,
      `HTTP observation interrupted after ${attempts} retries; `
      + `run ${runId} last acknowledged sequence ${lastSequence}`,
    );
    this.name = 'NikaObservationInterrupted';
    this.runId = runId;
    this.lastSequence = lastSequence;
    this.attempts = attempts;
  }
}

/** One taxonomy for engine refusals returned by an SDK operation. */
export class NikaOperationError extends NikaError {
  readonly operation: NikaOperation;
  readonly code: string;
  readonly transport: NikaTransportKind;
  readonly status: number;
  readonly findings?: readonly NikaOperationFinding[];
  readonly currentRevision?: string | null;
  readonly machineCode?: string;

  constructor(
    operation: NikaOperation,
    transport: NikaTransportKind,
    code: string,
    message: string,
    details: {
      status: number;
      findings?: readonly NikaOperationFinding[];
      currentRevision?: string | null;
      machineCode?: string;
    },
  ) {
    super(message);
    this.name = 'NikaOperationError';
    this.operation = operation;
    this.code = code;
    this.transport = transport;
    this.status = details.status;
    this.findings = details.findings;
    this.currentRevision = details.currentRevision;
    this.machineCode = details.machineCode;
  }
}

/**
 * An event view would have had to skip frames, so it refused instead. The SDK
 * never silently omits a frame. Two different bounds can be exceeded, and
 * `reason` says which. Neither is about the run: it keeps running or stays
 * settled, and `run.result()` is unaffected.
 *
 * - `live_backpressure`: a view that was observing live fell more than
 *   `limit` frames behind the stream. Read faster, or give it a larger
 *   `bufferSize`. Other views are unaffected.
 * - `replay_truncated`: a view was opened after the run had already produced
 *   more frames than it can be given. `observed` is how many the session saw
 *   and `retained` how many it still holds. When `retained === observed`
 *   nothing is lost and a view with `bufferSize >= observed` replays them
 *   all; when `retained < observed` the earlier frames are gone from this
 *   process, so raise `eventBufferSize` to at least `observed` for the next
 *   run, or observe it live.
 */
export class NikaEventBufferOverflowError extends NikaError {
  readonly runId: string;
  /** The bound that was exceeded: the view's `bufferSize`. */
  readonly limit: number;
  readonly reason: 'live_backpressure' | 'replay_truncated';
  // `declare`: a live refusal names no history, so these keys must be absent
  // from it, not present and undefined as a defined class field would be.
  /** `replay_truncated` only: frames the session had observed when it refused. */
  declare readonly observed?: number;
  /** `replay_truncated` only: frames the session still held when it refused. */
  declare readonly retained?: number;

  constructor(
    runId: string,
    limit: number,
    replay?: { observed: number; retained: number },
  ) {
    super(replay === undefined
      ? `Event subscriber for run ${runId} exceeded its ${limit}-event buffer`
      : `Run ${runId} had produced ${replay.observed} events when this view was opened, more `
        + `than the ${limit} it can replay (${replay.retained} still retained). The run and its `
        + 'result are unaffected. '
        + (replay.retained === replay.observed
          ? `Open the view with bufferSize >= ${replay.observed}`
          : `Set eventBufferSize >= ${replay.observed} for the next run`)
        + ', or observe the run live');
    this.name = 'NikaEventBufferOverflowError';
    this.runId = runId;
    this.limit = limit;
    this.reason = replay === undefined ? 'live_backpressure' : 'replay_truncated';
    if (replay !== undefined) {
      this.observed = replay.observed;
      this.retained = replay.retained;
    }
  }
}

/**
 * The Session's host refused a command or an opening, with its own word
 * (`code`): `busy`, `stale_snapshot`, `unknown_snapshot`,
 * `command_conflict`, `malformed`, `session_not_found`, `session_live`,
 * `session_unavailable`; the vocabulary stays open. Nothing reached the
 * runtime, so nothing is to undo: the refused `line` is returned to its
 * owner, never retried or re-targeted by the SDK. `snapshot`, when the host
 * sent one, is the current snapshot to show before anything is sent again.
 *
 * `line` and `snapshot` carry what a person wrote and the Session's work, so
 * they are not enumerable: logging or serializing the error never prints
 * them; read them by name.
 */
export class NikaSessionRefusedError extends NikaOperationError {
  /** The command refused, when the refusal names one. */
  declare readonly command?: string;
  /** The line a refused submit carried, kept for its owner. */
  declare readonly line?: string;
  /** The current snapshot the host sent with the refusal. */
  declare readonly snapshot?: NikaSessionSnapshot;
  /** `session_live`: the live Session to attach to instead. */
  declare readonly session?: string;

  constructor(
    transport: NikaTransportKind,
    code: string,
    message: string,
    details: {
      status: number;
      command?: string;
      line?: string;
      snapshot?: NikaSessionSnapshot;
      session?: string;
    },
  ) {
    super('session', transport, code, message, { status: details.status, machineCode: code });
    this.name = 'NikaSessionRefusedError';
    if (details.command !== undefined) this.command = details.command;
    if (details.session !== undefined) this.session = details.session;
    // Content stays off the enumerable surface every logger and serializer reads.
    for (const key of ['line', 'snapshot'] as const) {
      if (details[key] !== undefined) {
        Object.defineProperty(this, key, {
          value: details[key], enumerable: false, writable: false, configurable: false,
        });
      }
    }
  }
}

/**
 * This wait for a command's result stopped (`signal`, a cut connection, the
 * native door closing) before the result arrived. The engine may still be
 * running the turn: send the same `command` with the same bytes again to
 * read its result, `stop()` to stop it.
 */
export class NikaSessionWaitError extends NikaTransportError {
  readonly command: string;

  constructor(transport: NikaTransportKind, command: string, message: string, options?: ErrorOptions) {
    super(transport, message, options);
    this.name = 'NikaSessionWaitError';
    this.command = command;
  }
}

export class NikaRunOwnershipError extends NikaError {
  constructor() {
    super('The NikaRun was not created by this Nika client');
    this.name = 'NikaRunOwnershipError';
  }
}
