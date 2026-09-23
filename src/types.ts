interface NikaSharedConfig {
  /**
   * How many of a run's most recent frames a session retains, and therefore
   * the most a view opened after the fact can be given, and the largest
   * `bufferSize` a view may ask for. Default: 4096 frames. For scale, one
   * measured fixture (a clean native run of 90 independent mock/echo infer
   * tasks) wrote 273 frames; other shapes write more, so count your own.
   *
   * It is a finite bound, never a promise about the run. A run longer than it
   * still succeeds and `run.result()` still resolves; only a late view is
   * refused, with `NikaEventBufferOverflowError` whose `reason` is
   * `replay_truncated` and whose `observed` says what to set. An explicit
   * value is kept exactly as given. Each frame is bounded by
   * `machineBufferBytes`, so the retained history holds at most
   * `eventBufferSize * machineBufferBytes` of frame text per run. That bounds
   * the history only: frames already handed to a consumer, other views and
   * other runs are not counted in it.
   */
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
 * The terminal settlement frame of a native engine process: the one frame
 * that carries the run's outputs, receipt, and final status together. Its
 * HTTP peer is `execution.settled`; one guard narrows both.
 */
export interface NikaRunSettledEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> extends NikaEventFields {
  kind: 'run_settled';
  status?: NikaRunStatus;
  /** Why the run settled this way (engine 0.118+ · flattened on this frame). */
  cause?: NikaRunCause;
  elapsed_ms?: number;
  tasks?: NikaTaskTally;
  spend?: NikaSpend;
  outputs?: Outputs;
  receipt?: NikaReceipt;
  /**
   * The cause of a `failed` settlement (engine 0.117+): the first failed
   * task's code, message and task id. Absent on a succeeded or paused run,
   * and on engines that only name the cause on their `task_failed` frame.
   */
  error?: NikaMachineError;
}

/** The run's trace chain was sealed. */
export interface NikaRunSealedEvent extends NikaEventFields {
  kind: 'run_sealed';
  receipt?: NikaReceipt;
}

/**
 * A journal delivery loss the resident reported, exactly as its contract
 * closes it: the run's journal mirror stopped recording. It is independent of
 * the execution: a run can settle `succeeded` and still carry it. It is never
 * a verdict and never changes a status; it says the trace may be incomplete
 * before `traceVerify` is trusted. Its absence is only absence: it never
 * claims that a journal exists.
 *
 * Engine main, ahead of the contract this package pins: no released engine
 * writes it yet, and a resident that predates it simply never sends it.
 */
export interface NikaJournalEvidence {
  status: 'mirror_lost';
  /** The mirror's first error, classified: never OS text, never a path. */
  reason: 'write_failed' | 'record_refused';
}

/**
 * Fields only the resident's frames carry, both from engine main, ahead of the
 * contract this package pins. Both are optional on the wire and absent on a
 * resident that predates them.
 */
interface NikaResidentEventFields extends NikaEventFields {
  /** When the resident admitted the event: RFC 3339, UTC. Outside the event's hash chain. */
  at?: string;
  /** A reported journal delivery loss, on the terminal frame. */
  evidence?: NikaJournalEvidence;
}

/**
 * The HTTP transport admitted the execution and it is running. This is the
 * first lifecycle frame `nika serve --bind` streams for a durable job.
 */
export interface NikaExecutionStartedEvent extends NikaResidentEventFields {
  kind: 'execution.started';
}

/**
 * The terminal settlement frame of the HTTP transport, and the peer of
 * `run_settled`: the one frame that carries the run's outputs, receipt, and
 * final status together.
 */
export interface NikaExecutionSettledEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> extends NikaResidentEventFields {
  kind: 'execution.settled';
  status?: NikaRunStatus;
  outputs?: Outputs;
  receipt?: NikaReceipt;
  /** The settlement the resident nests whole on this frame (engine 0.118+ · ADR-128). */
  settlement?: NikaSettlement;
}

/**
 * The resident cancelled the execution: a queued job cancelled before it was
 * claimed, or a running one whose owner settled the request as a
 * cancellation. It carries the settlement when the runtime built one.
 */
export interface NikaExecutionCancelledEvent extends NikaResidentEventFields {
  kind: 'execution.cancelled';
  settlement?: NikaSettlement;
}

/** The server refused the execution. */
export interface NikaExecutionRefusedEvent extends NikaResidentEventFields {
  kind: 'execution.refused';
}

/**
 * The execution was interrupted before settling. A resident that restarts
 * marks an orphaned running job with either word, so both are one variant.
 */
export interface NikaExecutionInterruptedEvent extends NikaResidentEventFields {
  kind: 'execution.interrupted' | 'interrupted';
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
 * One engine-owned run event, from either transport: the native process emits
 * the `workflow_*` / `task_*` / `run_*` kinds, `nika serve` emits the
 * `execution.*` kinds. Known kinds discriminate on `kind`; unknown kinds fall
 * back to `NikaUnknownEvent`. Future fields stay open on every variant.
 * `Outputs` types the terminal frames' outputs and defaults to the transport
 * shape, so untyped callers see no change.
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
  | NikaExecutionStartedEvent
  | NikaExecutionSettledEvent<Outputs>
  | NikaExecutionCancelledEvent
  | NikaExecutionRefusedEvent
  | NikaExecutionInterruptedEvent
  | NikaUnknownEvent;

/**
 * The SDK's one lifecycle vocabulary, identical on both transports. Each word
 * names a fact an engine wrote; the protocol word that carried it stays on
 * `raw.kind`. Transports differ in cardinality, never in these names.
 *
 * A frame that speaks of the run's state earns its name only for a
 * (kind, status) pair a producer defines. The engine's state word decides and
 * is never defaulted: an absent, null, future, or still-running status, or
 * one that contradicts its kind, stays an `engine.event`.
 *
 * - `run.started`: `workflow_started` · `execution.started`.
 * - `task.scheduled` · `task.started` · `task.completed` · `task.failed`: the
 *   native `task_*` frames. `nika serve` streams no per-task frame, so an HTTP
 *   run yields none; the SDK never synthesizes one.
 * - `run.waiting`: the settlement frame (`run_settled` · `execution.settled`)
 *   carrying `paused`. A human gate holds the run: it is not failed, not a
 *   completed execution, and stays resumable.
 * - `run.settled`: exactly these pairs, and no other. The settlement frame
 *   (`run_settled` · `execution.settled`) carrying `succeeded`, `failed`, or
 *   `cancelled`; `execution.cancelled` carrying `cancelled`;
 *   `execution.refused` carrying `failed`. A dedicated end kind with another
 *   terminal word (a refusal that `succeeded`, a cancellation that `failed`)
 *   contradicts itself and stays an `engine.event`.
 * - `run.interrupted`: `workflow_interrupted` · `execution.interrupted` ·
 *   `interrupted` carrying `interrupted`. The engine lost the execution and
 *   its settlement is unknown: an evidence state, never a settlement. This is
 *   an engine-reported frame, distinct from the thrown
 *   `NikaObservationInterrupted`, which means this client lost its
 *   observation of a run that may still be running.
 * - `run.sealed`: `run_sealed`, native only.
 * - `engine.event`: every other frame, including kinds this SDK version does
 *   not know yet. Nothing is dropped; read `raw`.
 *
 * The projection keeps no state between frames and deduplicates nothing. The
 * set is additive: keep a `default` branch.
 */
export type NikaRunEventKind =
  | 'run.started'
  | 'task.scheduled'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'run.waiting'
  | 'run.settled'
  | 'run.interrupted'
  | 'run.sealed'
  | 'engine.event';

/**
 * One run event in the SDK's lifecycle vocabulary, as `run.events()` yields
 * it. It is a projection of exactly one protocol frame: `raw` is that frame,
 * untouched, and every other field is present only when the frame stated it.
 * An `engine.event` is given no lifecycle meaning: it carries no `status`,
 * `task` or `error`, only its cursor and `raw`.
 */
export interface NikaRunEvent<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: NikaRunEventKind;
  /** The transport whose protocol `raw` speaks. */
  readonly transport: NikaTransportKind;
  /** The engine's own state word, never renamed: a waiting run reads `paused`. */
  readonly status?: NikaRunStatus;
  /**
   * HTTP only: the SSE sequence of this frame, the cursor to persist for
   * `attachRun(id, { lastEventId })`. A native process has no durable replay,
   * so a native event never carries one.
   */
  readonly sequence?: number;
  /** The task a `task.*` frame named. */
  readonly task?: string;
  /** The failure the frame named: a failed task, or a failed settlement. */
  readonly error?: NikaMachineError;
  /** The exact protocol frame the engine wrote. */
  readonly raw: NikaEvent<Outputs>;
}

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

/** Why a run settled the way it did (engine 0.118+ · ADR-128). */
export type NikaRunCause =
  | 'normal'
  | 'human_gate'
  | 'task_failed'
  | 'output_contract'
  | 'budget'
  | 'operator'
  | 'refused'
  | (string & {});

/**
 * How much of the spend is priced (engine 0.118+): `unmetered` = no metered
 * call · `unpriced` = a local or subscription seat, never free · `partially_priced`
 * · `priced`.
 */
export type NikaCostQualifier =
  | 'priced'
  | 'partially_priced'
  | 'unpriced'
  | 'unmetered'
  | (string & {});

/** How the run's tasks ended (engine 0.118+): `recovered` is a tally, never a state. */
export interface NikaTaskTally {
  total?: number;
  ok?: number;
  failed?: number;
  recovered?: number;
  skipped?: number;
  cancelled?: number;
  never_started?: number;
  [key: string]: unknown;
}

/** What the run spent and how much of it is priced (engine 0.118+). */
export interface NikaSpend {
  /** Present only when at least one call metered real spend; unknown cost is never zero. */
  total_cost_usd?: number | null;
  priced_calls?: number;
  unpriced_calls?: number;
  qualifier?: NikaCostQualifier;
  pricing_as_of?: string | null;
  /** Spend per pricing source, when the engine broke it down. */
  by_source?: Record<string, number>;
  [key: string]: unknown;
}

/**
 * The run's settlement as the engine built it once (ADR-128): the state's
 * cause, the task tally, the spend and its qualifier, the elapsed time.
 * Absent on engines before 0.118; never derived from an exit code.
 */
export interface NikaSettlement {
  /**
   * The state word the settlement itself carries (`succeeded` · `failed` ·
   * `paused` · `cancelled`) on the resident's nested projection; the native
   * `run_settled` frame states it on the frame instead.
   */
  status?: NikaRunStatus;
  cause?: NikaRunCause;
  elapsed_ms?: number;
  tasks?: NikaTaskTally;
  spend?: NikaSpend;
  /** The failure named on a `failed` settlement: code, message and the task, when one failed. */
  error?: NikaMachineError;
  [key: string]: unknown;
}

/**
 * The engine's result of observing an admitted run, including a paused run.
 * Admitted workflow failure resolves with `status: 'failed'`; configuration,
 * transport, protocol, and compatibility errors reject instead. Use
 * `isNikaRunSucceeded(result)` before treating an observation as success.
 * Outputs are optional even on success, and status stays forward-compatible.
 */
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
  /** The settlement's cause, tally and spend (engine 0.118+), when the terminal frame carried them. */
  settlement?: NikaSettlement;
  /**
   * HTTP only: the journal delivery loss the resident reported on the terminal
   * frame or the durable job that settled this run. Copied, never inferred:
   * absent when the resident reported none, which claims nothing about a
   * journal. It never changes `status`. A native process reports none.
   */
  evidence?: NikaJournalEvidence;
  [key: string]: unknown;
}

/**
 * An admitted run and its whole lifecycle. `run()` and `attachRun()` return
 * one only after admission: a workflow the engine refuses rejects there and
 * never yields a handle. Every member is bound to the run, so a method may be
 * extracted (`const { events, result } = run`) and still works.
 *
 * The handle owns observation, settlement, status and cancellation, nothing
 * else: checking, proof, catalogs and authoring stay on `Nika`. It is
 * process-bound. To continue in another process, persist `id` and the last
 * `event.sequence` you fully processed, then call
 * `nika.attachRun(id, { lastEventId })`, the one recovery door.
 *
 * `id` is what differs by transport, and the type cannot show it:
 * - HTTP: the resident's durable job id. This is the identity to store.
 * - native: an ephemeral correlation id of this SDK process. It appears in no
 *   journal and cannot be recovered after the process ends; `attachRun`
 *   refuses it. Resume a native run through the engine's own trace.
 */
export interface NikaRun<
  Outputs extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: NikaRunId;
  /**
   * A bounded view of the run's events in the SDK's lifecycle vocabulary;
   * each event keeps its protocol frame on `raw`. Transports differ in how
   * many facts they emit, never in their names. The iterator throws for a
   * broken observation (`NikaObservationInterrupted` carries the cursor); an
   * admitted workflow failure ends it normally and is read from `result()`.
   */
  readonly events: (options?: NikaEventsOptions) => AsyncIterable<NikaRunEvent<Outputs>>;
  /**
   * The engine's result of observing this run, settled once. One failure law:
   * - rejects: a transport, protocol, or compatibility fault, or a broken
   *   observation (`NikaObservationInterrupted`, which carries the cursor).
   *   None of them says the run failed; it may still be running.
   * - resolves with `status: 'failed'`: an admitted failure is result data,
   *   with the engine's `error.code` when the engine named one. `cancelled`
   *   and the engine-reported `interrupted` resolve the same way.
   * - resolves with `status: 'paused'`: a human gate holds the run. It is
   *   neither a failure nor a completed execution.
   * Read `isNikaRunSucceeded(result)` before treating it as success.
   */
  readonly result: () => Promise<NikaRunResult<Outputs>>;
  /**
   * The current durable status, without waiting for settlement. Only a
   * resident owns one: a native run rejects with a typed
   * `NikaCompatibilityError` instead of inventing a status.
   */
  readonly status: () => Promise<NikaRunStatus>;
  /**
   * Ask the engine to cancel. Idempotent: every call returns the one request.
   * Acceptance is not a result; read what the engine recorded from `result()`.
   */
  readonly cancel: () => Promise<NikaCancelResult>;
  /** Compatibility alias of `result()`: the same promise, kept while code migrates. */
  readonly done: Promise<NikaRunResult<Outputs>>;
}

export interface NikaCancelResult {
  runId: NikaRunId;
  accepted: boolean;
  /**
   * `cancelled`: the job settled cancelled on the cancel reply itself.
   * `already_settled`: the run had already ended, nothing was cancelled.
   * `cancellation_requested`: the request was accepted while the execution
   * owner had not settled yet (a native SIGTERM, or the resident's 202); the
   * run then settles on its own terminal, read from `run.result()`, which may
   * be `cancelled`, `succeeded`, `failed`, or `interrupted` once the
   * resident's grace expired. Open to the engine's future words.
   */
  status: 'cancelled' | 'already_settled' | 'cancellation_requested' | (string & {});
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
  /**
   * Engine-owned trace verdict. The native path answers `verified` or
   * `invalid`; the resident's door answers `unavailable` while it has no
   * trace-journal authority (engine 0.118), and will speak the CLI's tiers
   * (`OK` · `SEALED` · `ANCHORED` · `REPLAYED` hold · `INCOMPLETE` ·
   * `TAMPERED` do not) once it does. Open to additive future vocabulary.
   */
  verdict?:
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | 'OK'
    | 'SEALED'
    | 'ANCHORED'
    | 'REPLAYED'
    | 'INCOMPLETE'
    | 'TAMPERED'
    | (string & {});
  /** Engine-owned explanation for a negative or unavailable verdict; a verdict that holds carries none. */
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
  /**
   * Literal values for the workflow's declared `inputs:`, by name, with the
   * same meaning on both transports. Values are strict JSON and stay literal:
   * a string is never read as `@env:NAME`, an expression or a number, and
   * nothing is coerced to the declared type. The engine validates the map
   * (unknown key, type mismatch, missing required input) and refuses before
   * any run exists. A value JSON cannot carry (`undefined`, a function, a
   * symbol, a bigint, a non-finite number, a cycle, a class instance, a
   * custom prototype, an array hole, an accessor, a Proxy) rejects `run()`
   * with `NikaConfigurationError` instead of being dropped, and the
   * serialized map is bounded at 1 MiB. No caller code runs while it is
   * judged: no getter is invoked, and a Proxy is refused before it is read.
   *
   * Needs an engine that advertises the literal channel: `inputsLiteral`
   * natively (values ride stdin, never argv), `jobInputs` over HTTP by served
   * name. An engine without it rejects with `NikaCompatibilityError`; the SDK
   * never falls back to `--var`. An execution snapshot freezes its inputs, so
   * an HTTP run of a local path refuses `inputs`. Never put a secret here.
   */
  inputs?: Record<string, unknown>;
  /**
   * @deprecated Use `inputs`. `vars` is the native `--var KEY=VALUE` operator
   * channel: the engine reads `@env:NAME` from its environment and coerces
   * text to the declared type, so it cannot carry literal API values and has
   * no HTTP form. Combining it with `inputs` rejects `run()`.
   */
  vars?: Record<string, string | number | boolean>;
  model?: string;
  maxCostUsd?: number;
  /**
   * Required for HTTP admission; reuse the same key and request after an
   * uncertain response. Direct native runs reject this option.
   */
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
  /**
   * Per-view queue bound, capped by the client eventBufferSize, which is also
   * its default. A live view that falls further behind than this fails with
   * `reason: 'live_backpressure'`; a view opened after more frames than this
   * is refused with `reason: 'replay_truncated'`. Neither skips a frame.
   */
  bufferSize?: number;
}

export interface NikaTraceVerifyOptions {
  /** Stops only the verification request/process. */
  signal?: AbortSignal;
}

/** The SDK operations whose engine refusal can be returned as a typed error. */
export type NikaOperation =
  | 'check'
  | 'run'
  | 'attachRun'
  | 'status'
  | 'cancel'
  | 'listWorkflows'
  | 'workflow'
  | 'traceVerify'
  | 'schedule'
  | 'scheduleStatus'
  | 'compile';

/** One engine-owned schedule finding. The vocabulary remains additive. */
export interface NikaScheduleFinding {
  code: string;
  detail: string;
  [key: string]: unknown;
}

/**
 * One engine-owned check finding, exactly as the engine's check report
 * carries it. `code` is absent when the engine's failure class names none (an
 * unreadable workflow file); the SDK never supplies one. The vocabulary
 * remains additive.
 */
export interface NikaCheckFinding {
  code?: string;
  message?: string;
  severity?: string;
  gate?: string;
  kind?: string;
  /** The task the finding judges, when it judges one. */
  task?: string;
  docs_url?: string;
  [key: string]: unknown;
}

/**
 * Findings carried by the one operation-error taxonomy: a schedule refusal
 * carries schedule findings (`detail`), a refused `run()` carries the check
 * findings that refused it (`message`).
 */
export type NikaOperationFinding = NikaScheduleFinding | NikaCheckFinding;

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

/* ------------------------------------------------------------------ */
/* Compile (issue #128) — the SDK projection of the engine's one       */
/* authoring capability. Field names mirror the engine's               */
/* Compile wire v1/v2 verbatim; the SDK invents none of them.         */
/* ------------------------------------------------------------------ */

/**
 * One stateless authoring request. Exactly one shape:
 *
 * - CREATE: `{ intent }` (or the bare-string shorthand), optionally with
 *   `answers` to the engine's stable question keys.
 * - EDIT: `{ workflow, change }` — the accepted workflow's SOURCE plus the
 *   change request — optionally with `answers`.
 *
 * The two shapes never mix, and there is no session: every call is a fresh
 * request carrying everything the engine needs.
 */
export type NikaCompileRequest = NikaCompileCreateRequest | NikaCompileEditRequest;

export interface NikaCompileCreateRequest {
  /** Intent text, or an exact embedded skeleton name in this foundation. */
  intent: string;
  /**
   * Answers to engine questions, by stable question key (`const.request`),
   * as strict JSON values — never pre-serialized text. The SDK serializes
   * each value exactly once onto the argv `KEY=JSON` channel; a value JSON
   * cannot carry refuses with `NikaConfigurationError` before any spawn.
   */
  answers?: Record<string, unknown>;
  workflow?: never;
  change?: never;
  originalIntent?: never;
}

export interface NikaCompileEditRequest {
  /** The accepted workflow's exact source bytes (as a string). */
  workflow: string;
  /**
   * The requested change: free text in the engine's supported edit
   * vocabulary, or one structured constant edit mirroring the engine's
   * `set_constant` operation. The value is a strict JSON value, judged by
   * the same law as `answers`.
   */
  change: string | NikaCompileSetConstant;
  answers?: Record<string, unknown>;
  intent?: never;
  /** Local CLI only: the original intent the accepted workflow answered. */
  originalIntent?: string;
}

/** One structured constant edit, mirroring the engine's `set_constant`. */
export interface NikaCompileSetConstant {
  set_constant: {
    /** Bare constant name (no `const.` prefix, no path). */
    name: string;
    /** The new literal, as a strict JSON value. */
    value: unknown;
  };
}

export interface NikaCompileOptions {
  /**
   * Aborts this authoring process only. Compile owns no Run: this never
   * touches `run.cancel()` semantics (client#126), and no workflow effect
   * exists to interrupt.
   */
  signal?: AbortSignal;
  /** Positive integer milliseconds before the compile child or HTTP request is stopped. */
  timeoutMs?: number;
  /** Local CLI only. Explicit opt-in; answers and ambient credentials never select a model. */
  authoring?: NikaCompileAuthoringOptions;
}

/** A thin projection of the engine's explicit authoring CLI flags. */
export interface NikaCompileAuthoringOptions {
  /** Explicit provider/model or harness/model; resolved only by the engine. */
  model: string;
  /** Engine default: escalate after its plan cannot settle the request. */
  strategy?: 'escalate' | 'only' | 'sketch' | 'off';
  /** Native repair rounds, 0..5 (engine default 3). */
  repairs?: number;
  /** Output tokens per call, 1..32768 (engine default 8192). */
  maxTokens?: number;
  /** Seconds per call, 1..600; distinct from the whole-operation timeoutMs. */
  timeoutSeconds?: number;
  /** Local knowledge source; paths are passed literally to the engine. */
  knowledge?: NikaCompileKnowledge;
}

/** A snapshot directory with optional corpus exclusion, OR a composed request pack. */
export type NikaCompileKnowledge =
  | { snapshot: string; excludeCorpus?: string; pack?: never }
  | { pack: string; snapshot?: never; excludeCorpus?: never };

/** The engine's own completeness words; `ready` is never derived from confidence. */
export type NikaCompileStatus = 'ready' | 'incomplete' | 'refused';

/** One authoring question, exactly as the engine emitted it. */
export interface NikaCompileQuestion {
  /** Stable semantic hole path (`const.request`), never a session id. */
  key: string;
  label: string;
  type: 'text' | 'literal' | 'choice';
  options?: { key: string; label: string; [key: string]: unknown }[];
  why: string;
  mandatory: boolean;
  [key: string]: unknown;
}

/** One structured authoring finding, exactly as the engine emitted it. */
export interface NikaCompileDiagnostic {
  kind: 'applied' | 'missed' | 'unknown' | 'requiresHuman' | 'refused';
  target: string;
  message: string;
  [key: string]: unknown;
}

/** Authoring provenance — not program identity (#1664), not execution Proof. */
export interface NikaCompileProvenance {
  compiler_version: string;
  spec_pin: string;
  skeleton: string | null;
  cognition: 'deterministicOnly' | 'explicitProvider' | 'explicitDecision';
  suggested_file?: string | null;
  strategy?: 'skeleton' | 'support' | 'hot' | 'warm' | 'cold' | 'native';
  /** Engine-owned JSON, preserved without reinterpretation. */
  plan?: unknown;
  decision?: unknown;
  /** Present on wire v2; authoring metadata grants no execution authority. */
  authoring?: NikaCompileAuthoringReceipt;
  [key: string]: unknown;
}

/** Exact wire v2 receipt. Missing provider usage remains null. */
export interface NikaCompileAuthoringReceipt {
  /** Requested model; not a claim about the model the backend actually used. */
  model: string;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  elapsed_ms: number;
  sampling: {
    temperature: null;
    seed: null;
    effective: 'providerDefaultUnknown';
    [key: string]: unknown;
  };
  /** Engine-owned per-call context and backend JSON, including knowledge identity. */
  context: unknown[];
  backend: unknown;
  [key: string]: unknown;
}

/** A requested trigger is a requirement, never an installed binding. */
export interface NikaCompileTrigger {
  kind: 'manual' | 'schedule' | 'webhook' | 'event';
  status: 'satisfied' | 'requires_binding' | 'unsupported';
  source_hint: string | null;
  event_hint: string | null;
  cadence: string | null;
  at: string | null;
  payload_input: string | null;
  timezone: string | null;
  missed: string | null;
  overlap: string | null;
  ceiling: string | null;
  [key: string]: unknown;
}

/** The candidate's pure Check judgment, with its deliberately limited scope. */
export interface NikaCompilePreview {
  /** `sourceOnly` in this foundation: no environment or admission claim. */
  scope: 'sourceOnly';
  report: NikaCheckResult;
  [key: string]: unknown;
}

/**
 * The reviewable authoring result. `candidate` is ordinary `.nika`
 * SOURCE in memory — it is not a `Workflow` handle, and `run()` does not
 * accept raw source: the caller materializes the candidate and `run(path)`
 * re-admits it. The SDK never writes the candidate for you in this slice
 * (no `dest`/`force`), and the engine never executes it.
 *
 * `incomplete` and `refused` are data, not exceptions: the SDK throws only
 * on transport, protocol, compatibility and engine-stamped failures.
 */
export interface NikaCompileOutcome {
  /** The engine's wire generation, validated without downgrading. */
  compile_version: 1 | 2;
  status: NikaCompileStatus;
  /** Exactly `status === 'ready'` — the engine's word, not a client judgment. */
  ready: boolean;
  /** The candidate source; may still carry unfilled holes when not ready. */
  candidate: string | null;
  questions: NikaCompileQuestion[];
  diagnostics: NikaCompileDiagnostic[];
  /** The boundary the candidate requests (from its pure report); never a grant. */
  requested_boundary: Record<string, unknown> | null;
  /** Absent on older v1 engines; otherwise the engine's trigger requirement. */
  requested_trigger?: NikaCompileTrigger | null;
  check_preview: NikaCompilePreview | null;
  provenance: NikaCompileProvenance;
}
