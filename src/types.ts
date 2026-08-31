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
  /** Binary resolution: this value, then NIKA_BIN, then `nika`. */
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

/** One engine-owned run event. Event kinds and future fields stay open. */
export interface NikaEvent {
  kind?: string;
  status?: NikaRunStatus;
  sequence?: number;
  receipt?: NikaReceipt;
  outputs?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Engine-issued proof material. The SDK transports it but never constructs,
 * reads a workflow to enrich it, or verifies its claims itself.
 */
export type NikaReceipt = Readonly<Record<string, unknown>>;

export interface NikaMachineError {
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/** The only terminal value for a run. */
export interface NikaRunResult {
  id: string;
  status: NikaRunStatus;
  transport: NikaTransportKind;
  exitCode?: number;
  outputs?: Record<string, unknown>;
  receipt?: NikaReceipt;
  error?: NikaMachineError;
  [key: string]: unknown;
}

/** A run identity plus its one terminal settlement. */
export interface NikaRun {
  readonly id: string;
  readonly done: Promise<NikaRunResult>;
}

export interface NikaCancelResult {
  runId: string;
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
