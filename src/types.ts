interface NikaSharedConfig {
  /** Bound for each event subscriber. Default: 256 events. */
  eventBufferSize?: number;
  /** Bound for buffered diagnostics and one machine frame. Default: 64 KiB. */
  machineBufferBytes?: number;
}

/** The default configuration drives a native `nika` process. */
export interface NikaLocalConfig extends NikaSharedConfig {
  /** Working directory used by the native process transport. */
  cwd?: string;
  /** Binary resolution: this value, then NIKA_BIN, then the host payload package. */
  bin?: string;
  url?: never;
  token?: never;
  allowInsecureHttp?: never;
  requestTimeout?: never;
  fetch?: never;
}

/** Supplying a URL selects the authenticated HTTP transport. */
export interface NikaRemoteConfig extends NikaSharedConfig {
  /** A `nika serve --bind` base URL. */
  url: string;
  /** Bearer token matching the server's `--token-file`. */
  token: string;
  /** Plain HTTP is refused unless this is explicitly true. */
  allowInsecureHttp?: boolean;
  /** Bound for HTTP admission. Default: 30 seconds. */
  requestTimeout?: number;
  /** Fetch implementation used by the HTTP transport. */
  fetch?: typeof globalThis.fetch;
  /** Working directory used while capturing the immutable snapshot locally. */
  cwd?: string;
  /** Local engine used to capture the immutable snapshot before HTTP admission. */
  bin?: string;
}

/** Public configuration for the one Nika client surface. */
export type NikaConfig = NikaLocalConfig | NikaRemoteConfig;

export type NikaTransportKind = 'native-process' | 'http';

/**
 * Brand carrier for engine-issued identities. The SDK brands an identity
 * only where the engine (or its durable record) issues it; it never invents
 * one itself.
 */
declare const NikaIdentityBrand: unique symbol;

interface NikaIdentity<Name extends string> {
  readonly [NikaIdentityBrand]: Name;
}

/** A run identity issued by `run()` or `attachRun()`. Assignable to `string`. */
export type NikaRunId = string & NikaIdentity<'NikaRunId'>;

/** An engine execution identity carried by terminal settlements and receipts. */
export type NikaExecutionId = string & NikaIdentity<'NikaExecutionId'>;

/** A durable `nika serve` job identity accepted by `attachRun()`. */
export type NikaJobId = string & NikaIdentity<'NikaJobId'>;

/** Machine vocabulary is additive. Known words aid completion without closing the set. */
export type NikaRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | (string & {});

/** A machine check report. Unknown engine fields deliberately ride through. */
export interface NikaCheckResult {
  report_version?: number;
  clean?: boolean;
  exitCode?: number;
  [key: string]: unknown;
}

/** Fields every engine event can carry, whether its kind is known or not. */
interface NikaEventFields {
  status?: NikaRunStatus;
  sequence?: number;
  receipt?: NikaReceipt;
  outputs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The workflow graph started executing. */
export interface NikaWorkflowStartedEvent extends NikaEventFields {
  kind: 'workflow_started';
}

/** A task was scheduled for execution. */
export interface NikaTaskScheduledEvent extends NikaEventFields {
  kind: 'task_scheduled';
}

/** A task started executing. */
export interface NikaTaskStartedEvent extends NikaEventFields {
  kind: 'task_started';
}

/** A task settled. Per-task payloads ride the open fields. */
export interface NikaTaskCompletedEvent extends NikaEventFields {
  kind: 'task_completed';
}

/**
 * The workflow graph settled. This is the terminal frame of a native-process
 * run and carries the run's outputs, receipt, and final status together.
 */
export interface NikaWorkflowCompletedEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> extends NikaEventFields {
  kind: 'workflow_completed';
  status?: NikaRunStatus;
  outputs?: Outputs;
  receipt?: NikaReceipt;
}

/** The workflow graph failed. */
export interface NikaWorkflowFailedEvent extends NikaEventFields {
  kind: 'workflow_failed';
  error?: NikaMachineError;
}

/** The workflow graph was interrupted before settling. */
export interface NikaWorkflowInterruptedEvent extends NikaEventFields {
  kind: 'workflow_interrupted';
}

/**
 * The terminal settlement frame of a durable `nika serve` job: the one frame
 * that carries the run's outputs, receipt, and final status together.
 */
export interface NikaRunSettledEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> extends NikaEventFields {
  kind: 'run_settled';
  status?: NikaRunStatus;
  outputs?: Outputs;
  receipt?: NikaReceipt;
}

/** The run's trace chain was sealed. */
export interface NikaRunSealedEvent extends NikaEventFields {
  kind: 'run_sealed';
  receipt?: NikaReceipt;
}

/**
 * Forward-compatibility variant: any kind this SDK version does not know
 * yet stays representable, so the event union is intentionally
 * non-exhaustive.
 */
export interface NikaUnknownEvent extends NikaEventFields {
  kind?: string;
}

/**
 * One engine-owned run event. Known kinds discriminate on `kind`; unknown
 * kinds fall back to `NikaUnknownEvent`. Future fields stay open on every
 * variant. `Outputs` types the terminal frames' outputs and defaults to the
 * transport shape, so untyped callers see no change.
 */
export type NikaEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> =
  | NikaWorkflowStartedEvent
  | NikaTaskScheduledEvent
  | NikaTaskStartedEvent
  | NikaTaskCompletedEvent
  | NikaWorkflowCompletedEvent<Outputs>
  | NikaWorkflowFailedEvent
  | NikaWorkflowInterruptedEvent
  | NikaRunSettledEvent<Outputs>
  | NikaRunSealedEvent
  | NikaUnknownEvent;

/**
 * Engine-issued proof material. The SDK transports it but never constructs,
 * reads a workflow to enrich it, or verifies its claims itself.
 */
export type NikaReceipt = Readonly<Record<string, unknown>>;

export interface NikaMachineError {
  code?: string;
  message?: string;
  /** The task that failed, when a native `task_failed` frame named it. */
  task?: string;
  [key: string]: unknown;
}

/** The only terminal value for a run. */
export interface NikaRunResult<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> {
  id: NikaRunId;
  status: NikaRunStatus;
  transport: NikaTransportKind;
  exitCode?: number;
  outputs?: Outputs;
  receipt?: NikaReceipt;
  error?: NikaMachineError;
  /** Engine execution identity, when the transport surface reports one. */
  execution_id?: NikaExecutionId;
  [key: string]: unknown;
}

/** A run identity plus its one terminal settlement. */
export interface NikaRun<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: NikaRunId;
  readonly done: Promise<NikaRunResult<Outputs>>;
}

export interface NikaCancelResult {
  runId: NikaRunId;
  accepted: boolean;
  status: string;
  transport: NikaTransportKind;
  [key: string]: unknown;
}

/** Server-owned metadata for one contained resident workflow. */
export interface NikaWorkflowMetadata {
  workflow: string;
  [key: string]: unknown;
}

export interface NikaTraceVerifyResult {
  verified: boolean;
  /** Engine-owned trace verdict. Open to additive future vocabulary. */
  verdict?: 'verified' | 'invalid' | 'unavailable' | (string & {});
  /** Engine-owned explanation for a negative or unavailable verdict. */
  reason?:
    | 'trace_invalid'
    | 'receipt_mismatch'
    | 'run_not_terminal'
    | 'trace_journal_unavailable'
    | (string & {});
  trace_id?: string;
  exitCode?: number;
  output?: string;
  [key: string]: unknown;
}

export interface NikaCheckOptions {
  model?: string;
  nativeStrict?: boolean;
  /** Stops only this check request/process. */
  signal?: AbortSignal;
}

export interface NikaRunOptions {
  vars?: Record<string, string | number | boolean>;
  model?: string;
  maxCostUsd?: number;
  /** Retained for HTTP admission deduplication. */
  idempotencyKey?: string;
}

/** Resume observation of an already-admitted durable HTTP job. */
export interface NikaAttachRunOptions {
  /** Last SSE sequence durably consumed by the caller. Default: 0. */
  lastEventId?: number;
}

export interface NikaEventsOptions {
  /** Stops this subscriber view. It never cancels the run. */
  signal?: AbortSignal;
  /** Per-view queue bound, capped by the client eventBufferSize. */
  bufferSize?: number;
}

export interface NikaTraceVerifyOptions {
  /** Stops only the verification request/process. */
  signal?: AbortSignal;
}

/** The two operations that can fail before returning an engine projection. */
export type NikaOperation = 'schedule' | 'scheduleStatus';

/** One engine-owned schedule finding. The vocabulary remains additive. */
export interface NikaScheduleFinding {
  code: string;
  detail: string;
  [key: string]: unknown;
}

/** Findings carried by the one operation-error taxonomy. */
export type NikaOperationFinding = NikaScheduleFinding;

export type NikaScheduleWhen =
  | { kind: 'once'; at: string }
  | { kind: 'cadence'; expression: string };

/** Exact declarative input accepted by PUT /v1/schedules/{id}. */
export interface NikaScheduleOptions {
  /** Stable path identity for the resident schedule. */
  id: string;
  when: NikaScheduleWhen;
  maxCostUsd: number;
  missed: 'catch-up' | 'catch-up-once' | 'skip';
  maxLatenessSeconds?: number;
  overlap?: 'skip' | 'queue' | 'replace';
  afterSkip?: 'next_slot' | 'on_completion';
  jitter?: 'hash';
  tolerance?: string;
  active?: boolean;
  pauseReason?: string;
  /** ISO calendar date (`YYYY-MM-DD`) required when active is false. */
  pauseUntil?: string;
  /** Exact prior revision for an update. Omit for create-if-absent. */
  revision?: string;
}

export type NikaScheduleMissed =
  | 'catch-up'
  | 'catch-up-once'
  | 'skip'
  | (string & {});
export type NikaScheduleOverlap = 'skip' | 'queue' | 'replace' | (string & {});
export type NikaScheduleAfterSkip =
  | 'next_slot'
  | 'on_completion'
  | (string & {});

/** The engine-normalized schedule definition; the SDK never normalizes it. */
export interface NikaScheduleDefinition {
  id: string;
  workflow: string;
  when: NikaScheduleWhen | { kind: string; [key: string]: unknown };
  maxCostUsd: number;
  missed: NikaScheduleMissed;
  maxLatenessSeconds: number | null;
  overlap: NikaScheduleOverlap;
  afterSkip: NikaScheduleAfterSkip;
  jitter: 'hash' | (string & {}) | null;
  tolerance: string | null;
  active: boolean;
  pauseReason: string | null;
  pauseUntil: string | null;
  [key: string]: unknown;
}

export interface NikaScheduleSlot {
  slotId: string;
  scheduledFor: string;
  requestedCivil: string | null;
  shift: 'exact' | 'advanced_first_valid' | 'folded_first' | (string & {});
  [key: string]: unknown;
}

export type NikaScheduleDue =
  | { kind: 'scheduled'; slot: NikaScheduleSlot }
  | { kind: 'catch_up'; slot: NikaScheduleSlot; missedSlots: number }
  | { kind: 'skipped_missed'; slot: NikaScheduleSlot; missedSlots: number }
  | {
      kind: 'skipped_too_late';
      slot: NikaScheduleSlot;
      latenessSeconds: number;
      maximumSeconds: number;
    }
  | { kind: 'paused'; reason: string | null; pauseUntil: string | null }
  | { kind: 'once_consumed'; slotId: string; scheduledFor: string }
  | { kind: 'not_due' }
  | { kind: string & {}; [key: string]: unknown };

export interface NikaSchedulePause {
  reason: string | null;
  until: string | null;
}

export interface NikaScheduleClaim {
  runId: string;
  executionId: string;
  traceId: string;
  generation: string;
  [key: string]: unknown;
}

export interface NikaScheduleLastDecision {
  action: 'claimed' | 'skipped' | (string & {});
  decision: 'scheduled' | 'catch_up' | (string & {});
  revision: string;
  slotId: string;
  scheduledFor: string;
  decidedAt: string;
  reason: string | null;
  claim: NikaScheduleClaim | null;
  [key: string]: unknown;
}

/** Fresh engine planning facts. The SDK transports them without interpretation. */
export interface NikaScheduleStatus {
  definition: NikaScheduleDefinition;
  origin: 'api' | (string & {});
  revision: string;
  active: boolean;
  pause: NikaSchedulePause | null;
  due?: NikaScheduleDue;
  finding?: NikaScheduleFinding;
  next: NikaScheduleSlot[];
  earliestWakeHint: string | null;
  lastDecision: NikaScheduleLastDecision | null;
  [key: string]: unknown;
}

/** Durable apply acknowledgement. It does not wait for a scheduled fire. */
export interface NikaScheduleApplyResult {
  applied: true;
  changed: boolean;
  status: NikaScheduleStatus;
}
