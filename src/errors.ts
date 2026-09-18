import type {
  NikaOperation,
  NikaOperationFinding,
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

export class NikaRunOwnershipError extends NikaError {
  constructor() {
    super('The NikaRun was not created by this Nika client');
    this.name = 'NikaRunOwnershipError';
  }
}
