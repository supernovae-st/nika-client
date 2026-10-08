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
  | 'compile'
  | 'session';

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
/* authoring capability. Field names mirror the engine's wire          */
/* (`compile_version` 1 and 2) verbatim; the SDK invents none of them. */
/* Wire fields keep their wire spelling (`workflow_id`, `limits`,      */
/* `replay_token`); native-only fields are named after the CLI flag    */
/* they become (`authoringModel` is `--authoring-model`).              */
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
 * request carrying everything the engine needs. `nextCompileRequest()` builds
 * the request of an answer round from the previous request and its outcome.
 *
 * Who makes a provider call is explicit and per request, never ambient:
 * `cognition: 'explicitProvider'` over HTTP (the server's operator seated the
 * model), `authoringModel` on a local engine (the model you name). Without
 * either, compile is deterministic and contacts no provider.
 */
export type NikaCompileRequest = NikaCompileCreateRequest | NikaCompileEditRequest;

/**
 * The cognition a compile request names (wire `cognition`, HTTP only):
 *
 * - `explicitProvider`: one fresh generation-2 round under the server's
 *   seated authoring model (it may spend). Needs `compileNativeV2`. With a
 *   kept round's `replay_token` it is that round's judged answer round: the
 *   kept plan replayed with the answers, the seat asked only to judge the
 *   replayed bytes (judge calls, never an authoring call); needs an engine
 *   with the judged answer round (integration commit 158a961cd, not yet
 *   released).
 * - `deterministicOnly`: with `replay_token`, a zero-call generation-2 replay
 *   of a round the server kept (no judge); without it, the generation-1 door
 *   with its explicit (and only) cognition word.
 */
export type NikaCompileRequestCognition = 'explicitProvider' | 'deterministicOnly';

/** How `nextCompileRequest()` builds the next round of a kept round. */
export interface NikaNextCompileOptions {
  /**
   * The cognition of the next round when it answers a kept round (a
   * `replay_token` came back, or the previous request carried one):
   * `explicitProvider` is its judged answer round (the server's seat judges
   * the replayed bytes: judge calls, no authoring call, it may spend);
   * `deterministicOnly` is its zero-call replay (no call, no judge, so a
   * model-authored candidate stays a preview). By default, after an
   * `explicitProvider` round: the judged answer round where the server serves
   * it (`outcome.judged_answer_round_available`), else a new fresh round
   * carrying the answers (it may spend); after a zero-call replay: another
   * one. Refused when no kept round is involved.
   */
  cognition?: NikaCompileRequestCognition;
}

/**
 * The caller's narrowing of one provider round's bounds (wire `limits`). Over
 * HTTP each value may only narrow the operator's bound (above it the server
 * answers 422 `compile_limit`, never a clamp); on a local engine the values
 * become the `--authoring-*` flags. Integers only.
 */
export interface NikaCompileLimits {
  /** Physical requests and model invocations of the round, 1–4294967295 (`--authoring-max-calls`). */
  max_calls?: number;
  /** Repair rounds, 0–4294967295; zero disables repairs (`--authoring-repairs`). */
  repairs?: number;
  /** Output tokens per completion, 1–4294967295 (`--authoring-max-tokens`). */
  max_tokens?: number;
  /**
   * The wait for one model invocation, in milliseconds (≥ 1). A local engine
   * takes whole seconds (`--authoring-timeout`), so a value that is not a
   * multiple of 1000 is refused there.
   */
  call_timeout_ms?: number;
  /**
   * The whole round's deadline, in milliseconds (≥ 1), absolute from the
   * server's admission; past it the server answers 408
   * `compile_deadline_exceeded`. Without it (and without an operator
   * deadline) nothing bounds the round on the server. The client then waits
   * for it plus the server's 5 s handoff and one `requestTimeout`, unless
   * `timeoutMs` says otherwise. HTTP only: the local engine has no such flag.
   */
  deadline_ms?: number;
}

/** Fields both request shapes may carry. */
interface NikaCompileRequestFields {
  /**
   * Answers to engine questions, by stable question key (`const.request`),
   * as strict JSON values — never pre-serialized text. Natively each value is
   * serialized exactly once onto the argv `--answer=KEY=JSON` channel; over
   * HTTP it rides `answers` with its type preserved. A value JSON cannot
   * carry refuses with `NikaConfigurationError` before any spawn or request.
   */
  answers?: Record<string, unknown>;
  /** HTTP only: the wire's cognition word (see `NikaCompileRequestCognition`). */
  cognition?: NikaCompileRequestCognition;
  /**
   * The bounds of a provider round: over HTTP with `cognition:
   * 'explicitProvider'` (a fresh round or a judged answer round), natively with
   * `authoringModel`. A zero-call replay (`deterministicOnly`) refuses limits.
   */
  limits?: NikaCompileLimits;
  /**
   * HTTP only: the `Nika-Compile-Replay` token a round of the same server run
   * answered (`outcome.replay_token`), sent with the round's exact input: with
   * `cognition: 'explicitProvider'` it is the judged answer round, with
   * `'deterministicOnly'` the zero-call replay. A held judged round forgets it.
   * Not an execution grant.
   */
  replay_token?: string;
  /**
   * Local engine only (`--authoring-model provider/name`): the model that
   * interprets free intent. Its key comes from the engine's environment,
   * never from the SDK. Over HTTP the server's operator seats the model.
   */
  authoringModel?: string;
  /**
   * Local engine only (`--decision-model`): one bounded-decision seat
   * (`typesafe/<jev>` or `provider/name`) for finite ambiguities and the
   * verifier's judgment. A revision (`workflow` + `change`) takes it from the
   * 0.123 integration line (engine `ae6845939`); an earlier engine refuses
   * `--decision-model` beside `--base` with its usage error. Over HTTP the
   * server's operator seats it (`compileDecisionSeat`).
   */
  decisionModel?: string;
  /**
   * Local engine only (`--output`): where the engine writes a READY
   * candidate, atomically; relative paths resolve against the client's
   * `cwd`. The engine never writes anything that is not ready. The outcome
   * then carries `written` (and `existing_destination` when a file was left
   * in place).
   */
  output?: string;
}

export interface NikaCompileCreateRequest extends NikaCompileRequestFields {
  /** Intent text, or an exact embedded skeleton name (`hello`, `chain`…). */
  intent: string;
  /** HTTP only (wire `workflow_id`): names the created workflow. */
  workflow_id?: string;
  /**
   * Local engine only (`--fresh`): ignore the plan an earlier round recorded
   * for this intent under `.nika/compile/` and read or sample it again.
   * Create only. `nextCompileRequest()` drops it so an answer round replays.
   */
  fresh?: boolean;
  workflow?: never;
  change?: never;
  original_intent?: never;
}

export interface NikaCompileEditRequest extends NikaCompileRequestFields {
  /** The accepted workflow's exact source bytes (as a string). */
  workflow: string;
  /**
   * The requested change: free text in the engine's supported edit
   * vocabulary, or one structured constant edit mirroring the engine's
   * `set_constant` operation. The value is a strict JSON value, judged by
   * the same law as `answers`.
   */
  change: string | NikaCompileSetConstant;
  /**
   * The request the base answered (wire `original_intent`; natively the
   * intent positional beside `--base`). A text change is read against it.
   * Required with a text change on an HTTP generation-2 round, absent from
   * the generation-1 wire, refused beside `set_constant`.
   */
  original_intent?: string;
  intent?: never;
  workflow_id?: never;
  fresh?: never;
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
   * Aborts this authoring request or process only. Compile owns no Run: this
   * never touches `run.cancel()` semantics (client#126). Stopping an HTTP
   * provider round stops this client's wait, not the server's round or its
   * spend.
   */
  signal?: AbortSignal;
  /**
   * Positive integer milliseconds before the compile child or HTTP request is
   * stopped. Without it, an HTTP generation-1 request or replay is bounded by
   * the client's `requestTimeout`; an `explicitProvider` round by its
   * `limits.deadline_ms` plus the server's handoff and one `requestTimeout`,
   * or, without that limit, by nothing the SDK sets (Node's built-in fetch
   * still stops waiting for response headers after 300 s by default); a local
   * compile by `signal` alone.
   */
  timeoutMs?: number;
  /**
   * Over HTTP, whether a generation-2 request (a provider round, a kept
   * round's judged answer round or its replay) carries what the local engine
   * observes of the files the request states (`nika compile --observe-only`
   * in the client's `cwd`: headers, key sets, short categorical values and
   * kind counts, never a row) as `observed_world`, so the server's seat, its
   * grounding law and its judge read the real shape instead of asking for it.
   * Default: sent whenever the server lists `compileObservedWorld`; `true`
   * requires it (a server without it is a typed gap); `false` sends none. A
   * kept round's later requests must observe the same files: another
   * observation is another input (`409 compile_replay_input_changed`). Where
   * the server also lists `compileTrialInputs`, the text of the files the
   * observation read rides as `trial_inputs`, and the server tries each final
   * candidate on them before it can be ready. A local compile always observes
   * (and tries) its own working directory; this has no effect there.
   */
  observe?: boolean;
}

/** The engine's own completeness words; `ready` is never derived from confidence. */
export type NikaCompileStatus = 'ready' | 'incomplete' | 'refused';

/** One admissible answer of a `choice` question, spelled by the owning grammar. */
export interface NikaCompileQuestionOption {
  key: string;
  label: string;
  [key: string]: unknown;
}

/** One authoring question, exactly as the engine emitted it. */
export interface NikaCompileQuestion {
  /** Stable semantic hole path (`const.request`), never a session id. */
  key: string;
  label: string;
  /**
   * `text`: a JSON string · `literal`: one JSON value · `choice`: a JSON
   * string that is the `key` of one of `options`.
   */
  type: 'text' | 'literal' | 'choice';
  why: string;
  /**
   * `false`: the value belongs to a binding outside the program (a
   * schedule's timezone, missed-run and overlap policies, per-run ceiling)
   * and never blocks a ready candidate.
   */
  mandatory: boolean;
  /** Present on a `choice` question only. */
  options?: NikaCompileQuestionOption[];
  [key: string]: unknown;
}

/**
 * One structured authoring finding, exactly as the engine emitted it.
 * Compiler targets include `semantic_verification`, `verify_held` (the
 * verifier did not accept the candidate: it is a preview, see
 * `isNikaCompileHeld`) and `verify_resume` (no admitted judgment was made:
 * the candidate is withdrawn and the round's record kept).
 */
export interface NikaCompileDiagnostic {
  kind: 'applied' | 'missed' | 'unknown' | 'requiresHuman' | 'refused';
  target: string;
  /** For a reader; never parsed to recover compiler state. */
  message: string;
  [key: string]: unknown;
}

/**
 * The authoring cognition the engine records in provenance:
 * `explicitDecision` is a bounded decision seat (local `decisionModel`).
 */
export type NikaCompileCognition = 'deterministicOnly' | 'explicitProvider' | 'explicitDecision';

/** The internal strategy that settled the request: observational, never authority. */
export type NikaCompileStrategy =
  | 'skeleton'
  | 'support'
  | 'hot'
  | 'warm'
  | 'cold'
  | 'native'
  | (string & {});

/**
 * The receipt of a round's provider calls (`provenance.authoring`, present
 * exactly on a `compile_version: 2` outcome). It is never workflow authority
 * or run evidence, and token usage is not an invoice.
 */
export interface NikaCompileAuthoringReceipt {
  /** The seated authoring model (`provider/name`): what was asked for, not what answered. */
  model: string;
  /** LOGICAL calls of the round. */
  calls: number;
  /** Sum of reported counters; `null` when no call reported both counters. */
  input_tokens: number | null;
  output_tokens: number | null;
  elapsed_ms: number;
  sampling: Record<string, unknown>;
  /** What each logical call received, in call order. */
  context: Record<string, unknown>[];
  /**
   * The backend that answered, as the door that seated it states it; `null`
   * when that door said nothing.
   */
  backend: NikaCompileAuthoringBackend | null;
  [key: string]: unknown;
}

/**
 * The backend of one authoring round (`provenance.authoring.backend`), as
 * the seating door states it: a direct provider (`direct_api`) or an agent
 * harness (`harness_infer`, `acp_harness`). Every member is optional and the
 * record stays open: older engines omit members and the vocabulary grows.
 *
 * The model identities are separate facts and never stand in for one
 * another:
 *
 * - requested: `requested_model` (and the receipt's `model`), what the
 *   operator or caller asked for;
 * - transmitted: `forwarded_model`, what a harness was sent;
 * - configured: `decision_model`, `host`, `base_url_overridden` and
 *   `endpoint_basis`, the seats and endpoint the operator configured;
 * - reported: `observed_models` (with `unreported_models`, the responses
 *   that named no model) and a harness's per-call `observed` rows;
 * - attested: `served_model`, `null` when no response proved which model
 *   served.
 *
 * Usage completeness, the physical request account (`authority`) and the
 * cost basis are evidence of the round, never an invoice.
 */
export interface NikaCompileAuthoringBackend {
  /** `direct_api` · `harness_infer` · `acp_harness`; the vocabulary stays open. */
  kind?: 'direct_api' | 'harness_infer' | 'acp_harness' | (string & {});
  /** The provider the seat resolved; `null` when the door could not name one. */
  provider?: string | null;
  /** Requested: the model the operator or caller asked for; `null` when none was named. */
  requested_model?: string | null;
  /** Transmitted: the model a harness was sent. */
  forwarded_model?: string;
  /** Configured: the decision model seated beside the author. */
  decision_model?: string;
  /** Configured: the endpoint host (and port) only. It authenticates no peer. */
  host?: string | null;
  /** Configured: the endpoint differs from the provider's seed; `null` when not comparable. */
  base_url_overridden?: boolean | null;
  /** What the endpoint members describe: `operator_configuration`. */
  endpoint_basis?: string;
  /** Reported: the model identities the responses named. */
  observed_models?: string[];
  /** Reported: how many responses named no model; never assumed to be the requested one. */
  unreported_models?: number;
  /** Reported by a harness, one row per call. */
  observed?: Record<string, unknown>[];
  /** Attested: the model a response proved served; `null` when unknown. */
  served_model?: string | null;
  /** Whether every call reported its usage (or was refused before sending). */
  usage_complete?: boolean;
  /** Whether a harness reported numeric usage at all. */
  numeric_usage_reported?: boolean;
  /** How cost is known (`unpriced; billing_unverified`, `subscription-backed/unknown`). */
  cost_basis?: string;
  /** A billed amount, when one was established; `null` when not. */
  billed_cost_usd?: number | null;
  /** The request authority's account of the round. */
  authority?: NikaCompileAuthority;
  [key: string]: unknown;
}

/**
 * The request authority's account of one authoring round: logical
 * invocations and physical HTTP requests counted apart.
 */
export interface NikaCompileAuthority {
  /** The request bound the round ran under; `null` when none was configured. */
  max_calls?: number | null;
  /** Where that bound came from. */
  source?: string;
  /** Logical invocations sent and refused. */
  invocations?: { sent: number; refused: number; [key: string]: unknown };
  /**
   * Physical requests sent and refused; both `null`, with the reason in
   * `unknown`, for a seat that makes its own (an ACP harness).
   */
  http_requests?: {
    sent?: number | null;
    refused?: number | null;
    unknown?: string | null;
    [key: string]: unknown;
  };
  /** What the door configured. */
  configured?: Record<string, unknown>;
  /** What the receipt states about a seated decision model's own client. */
  decision_seat?: string;
  [key: string]: unknown;
}

/**
 * The record a round's plan carries (`provenance.plan`). A server keeps it
 * behind the round's replay token; a caller never sends it back as
 * authority. Its revision members, when present, bind the candidate bytes
 * the round produced. The engine drops the whole record (no replay) when its
 * verifier holds, withdraws or doubts the candidate: the decision record
 * then still states the revision that was made.
 */
export interface NikaCompilePlanRecord {
  /** The lineage of a revised source: which bytes it revised and which it wrote. */
  source_revision?: NikaCompileSourceRevision;
  /** The digest of the words the record answers (engine-normalized, not a plain hash of `intent`). */
  intent_sha256?: string;
  /** How the source was revised over its complete document. */
  document_revision?: NikaCompileDocumentRevision;
  /**
   * A created document's settled record: the final bytes it binds, the
   * request they answer and the receipts of what it composed. A ready round
   * of the complete-document door writes it once no mandatory question is
   * left; a continuation still waiting on one carries none. A later change
   * to these bytes is new work over them, never an answer round of the
   * creation.
   */
  document?: NikaCompileCreatedDocument;
  /** How the complete-document door made a created document, as its answer rounds replay it. */
  document_create?: NikaCompileDocumentCreateSection;
  [key: string]: unknown;
}

/**
 * The compiler's bounded decision records (`provenance.decision`): seats,
 * questions, verification attempts, the native conversation and, when a
 * revision or a qualification ran, its evidence.
 */
export interface NikaCompileDecisionRecord {
  /**
   * The document revision the round made: the plan's own when the plan is
   * kept. It stays when the plan is dropped, so it may describe a held
   * candidate (a preview) or a withdrawn one (`candidate` is `null` and its
   * digest names bytes no caller received): evidence of the attempt, never
   * an accepted result.
   */
  document_revision?: NikaCompileDocumentRevision;
  /**
   * How the complete-document door made a created document. It stays on
   * every outcome of that door, so it may describe a held candidate or a
   * withdrawn one (`candidate_sha256` is then `null`): evidence of the
   * attempt, never an accepted result.
   */
  document_create?: NikaCompileDocumentCreate;
  /** How recalled knowledge was qualified, and what of it the candidate's bytes hold. */
  knowledge_qualification?: NikaCompileKnowledgeQualification;
  [key: string]: unknown;
}

/**
 * The lineage a revision record states (`provenance.plan.source_revision`):
 * the digest of the bytes revised and of the bytes written. The base digest
 * names the source parent; it is no session sequence and does not prove that
 * any earlier revision is retained. A destination revision states more
 * (`edit`, `path`, `by`, `original`, `change`, `supersedes`, `adds`, `like`,
 * `slots`), kept as the engine wrote them.
 */
export interface NikaCompileSourceRevision {
  /** sha256 (lowercase hex) of the base source's UTF-8 bytes. */
  base_sha256: string;
  /** sha256 (lowercase hex) of the candidate source's UTF-8 bytes. */
  candidate_sha256: string;
  /** The words the revised bytes now answer. */
  resolved?: string;
  [key: string]: unknown;
}

/**
 * A revision applied over the complete base document (engine
 * `nika-compile-seats` `foundry/document.rs`). It states what the compiler
 * did and claims, never that the result is what the request meant: that is
 * the judge's and the run's to say.
 */
export interface NikaCompileDocumentRevision {
  /** The route that made it. */
  route?: string;
  /** `operations` (edits and component merges) or `replaced` (the whole source). */
  mode: 'operations' | 'replaced' | (string & {});
  /** sha256 (lowercase hex) of the base source's UTF-8 bytes. */
  base_sha256: string;
  /** sha256 (lowercase hex) of the candidate source's UTF-8 bytes. */
  candidate_sha256: string;
  /** The node paths and components changed, in the operations' order. */
  changed: string[];
  /** The preservation claimed, in words; none for a replacement. */
  preservation?: string;
  /** The receipts of the components the revised bytes hold: new, rebound or carried. */
  components: NikaCompileComponentReceipt[];
  [key: string]: unknown;
}

/**
 * How a created document was made: `written` (the author wrote the whole
 * document) or `composed` (operations applied over the author's own
 * document). The vocabulary stays open.
 */
export type NikaCompileDocumentCreateMode = 'written' | 'composed' | (string & {});

/**
 * The settled record of a created document (`provenance.plan.document`,
 * engine `nika-compile-cognition` `document_create.rs::bind`), written on a
 * ready outcome only, optional questions left or not. It binds the final
 * bytes, once answers, defaults and the model seating changed them:
 * `candidate_sha256` is their sha256, and the engine reads the record as the
 * program history of exactly those bytes. This SDK knows version `1`; a
 * record of another version is carried as written, its other members
 * unjudged, so read them only when `version` is `1`.
 */
export interface NikaCompileCreatedDocument {
  version: number;
  /** sha256 (lowercase hex) of the final candidate's UTF-8 bytes. */
  candidate_sha256: string;
  /**
   * The effective request the door read (a clarification's words when one
   * replaced the request); answers are never written into it.
   */
  request: string;
  /** `null`: a creation revises no program. */
  base_sha256: string | null;
  mode: NikaCompileDocumentCreateMode;
  /**
   * The receipts of the components the document holds. A receipt's own
   * `candidate_sha256` names the bytes right after its expansion, which may
   * precede later edits or answers; what the final bytes hold of it is
   * `decision.document_create.reuse`.
   */
  components: NikaCompileComponentReceipt[];
  [key: string]: unknown;
}

/**
 * The complete-document door's section on the native record its answer
 * rounds replay (`provenance.plan.document_create`): what the door made and
 * of what. It is there whenever the door's judge accepted a document, ready
 * or not.
 */
export interface NikaCompileDocumentCreateSection {
  /** The route that made it. */
  route?: string;
  mode: NikaCompileDocumentCreateMode;
  /** The request the door answered. */
  resolved?: string;
  /** sha256 of the document a `composed` answer's operations applied to inside the creation; `null` when written. */
  base_sha256?: string | null;
  /** How many operations the answer stated. */
  operations?: number;
  /** The node paths and components the operations changed, in their order; empty when written. */
  changed: string[];
  /** The preservation claimed, in words. */
  preservation?: string;
  /** The receipts of the components the document holds. */
  components: NikaCompileComponentReceipt[];
  [key: string]: unknown;
}

/**
 * How the complete-document door made a created document
 * (`provenance.decision.document_create`), with each component's receipt
 * and what the candidate holds of them. It is there whenever the door's
 * judge accepted a document: a ready outcome, a continuation waiting on a
 * mandatory question, a withdrawal. It states what the door did and claims,
 * never that the document is what the request meant.
 */
export interface NikaCompileDocumentCreate {
  /** The route that made it. */
  route?: string;
  mode: NikaCompileDocumentCreateMode;
  /**
   * sha256 (lowercase hex) of the document a `composed` answer's operations
   * applied to inside this creation (the author's own, or the door's last
   * one); `null` when the author wrote the whole document. It is never a
   * program base.
   */
  base_sha256: string | null;
  /** How many operations the answer stated. */
  operations: number;
  /** The node paths and components the operations changed, in their order. */
  changed: string[];
  /** The preservation claimed, in words. */
  preservation?: string;
  /** The receipts of the components the document holds: new, rebound or carried. */
  components: NikaCompileComponentReceipt[];
  /** What the candidate holds of each receipt, witnessed on its bytes. */
  reuse?: NikaCompileReuse;
  /**
   * sha256 (lowercase hex) of the outcome's candidate: on a ready outcome the
   * final bytes `plan.document` binds. `null` when the outcome holds none.
   */
  candidate_sha256: string | null;
  [key: string]: unknown;
}

/**
 * The receipt of one admitted component in a candidate: expanded into the
 * document, or invoked behind a child-workflow call (`invocation`, `child`).
 * Composing a component grants nothing: its permits, model and name are not
 * inherited.
 */
export interface NikaCompileComponentReceipt {
  /** The law the receipt states. */
  law?: string;
  /** The component's identity in its release: never its bytes again. */
  component: NikaCompileComponentIdentity;
  /** Each hole bound, in order. */
  bindings: NikaCompileComponentBinding[];
  /** The holes no binding closed. */
  open?: string[];
  /** What of the component the document does not inherit (`nika`, `model`, `permits`). */
  not_inherited?: Record<string, unknown>;
  /** The authority the component declares and the document needs: never granted. */
  authority?: Record<string, unknown>;
  /**
   * The digest of every node the expansion produced, by section and name:
   * sha256 (lowercase hex) of the node's compact JSON, `null` for a node the
   * expanded document did not hold.
   */
  nodes: Record<string, Record<string, string | null>>;
  /** sha256 (lowercase hex) of the candidate the receipt was made on. */
  candidate_sha256: string;
  /** The candidate's Check, as the receipt saw it. */
  check?: NikaCompileComponentCheck;
  /** The calling task and the child workflow path of an invoked component. */
  invocation?: { task: string; workflow: string; [key: string]: unknown };
  /** The child program's own receipt members, witnessed apart. */
  child?: Record<string, unknown>;
  /** The candidate digest a rebinding revised; `null` when the earlier receipt named none. */
  revises?: string | null;
  [key: string]: unknown;
}

/** A component's identity as a receipt names it. */
export interface NikaCompileComponentIdentity {
  /** `block:<name>`. */
  id: string;
  /** The admitted release it was resolved from. */
  release?: NikaCompileComponentRelease;
  /** The release row's canonical digest. */
  row_sha256?: string;
  /** The program file under the release root. */
  file?: string;
  /** The digest the release pins for that file. */
  file_sha256?: string;
  /** The row's status (`EXPERIMENTAL`, `QUALIFIED`, …). */
  status?: string;
  /** The row's proof level (`CHECKED`, …). */
  proof_level?: string;
  [key: string]: unknown;
}

/** The admitted release a component was resolved from. */
export interface NikaCompileComponentRelease {
  /** The release's knowledge version. */
  version?: string;
  /** The release's snapshot digest. */
  snapshot_sha256?: string;
  /** The admission profile that verified it. */
  profile?: string;
  [key: string]: unknown;
}

/** One hole bound in a component. */
export interface NikaCompileComponentBinding {
  /** The hole's key path in the component (`const.max_age_hours`). */
  path: string;
  /** The hole that covers the path; `null` when none does. */
  hole?: string | null;
  /** Who fills that hole; `null` when no hole covers the path. */
  owner?: string | null;
  /** The component's own literal at the path (any JSON value, `null` included). */
  component_literal?: unknown;
  /** The literal bound there (any JSON value, `null` included). */
  bound: unknown;
  [key: string]: unknown;
}

/** A Check summary a component receipt keeps. */
export interface NikaCompileComponentCheck {
  ready?: boolean;
  findings?: Record<string, unknown>[];
  diagnostics?: Record<string, unknown>[];
  [key: string]: unknown;
}

/**
 * How the knowledge recalled for a round was qualified
 * (`provenance.decision.knowledge_qualification`), and what of it the
 * candidate's bytes hold. Older engines record a lexical `trace` instead of
 * `reuse`: a measure of shared lines, never evidence of reuse.
 */
export interface NikaCompileKnowledgeQualification {
  /** What the candidate's bytes hold of each shown reference and composed component. */
  reuse?: NikaCompileReuse;
  [key: string]: unknown;
}

/**
 * The reuse witness of one candidate (engine `foundry/witness.rs`):
 * established from the candidate's own bytes, never from the knowledge an
 * author was shown or from lines the candidate shares with a reference.
 * The counts cover `expanded`, `invoked`, `revised`, `absent` and
 * `consulted`; a reference whose witness was `unreadable` is listed, not
 * counted.
 */
export interface NikaCompileReuse {
  /** The law the record states. */
  law?: string;
  expanded: number;
  invoked: number;
  revised: number;
  absent: number;
  consulted: number;
  references: NikaCompileReuseReference[];
  [key: string]: unknown;
}

/**
 * What the candidate holds of one reference: `consulted` (shown, its use
 * unobservable), `expanded`, `invoked`, `revised` (every node present, some
 * changed since), `absent` (a node missing) or `unreadable`.
 */
export type NikaCompileReuseUse =
  | 'consulted'
  | 'expanded'
  | 'invoked'
  | 'revised'
  | 'absent'
  | 'unreadable'
  | (string & {});

/** One shown reference or composed component, and its use. */
export interface NikaCompileReuseReference {
  /** The reference id, or the component id a receipt names (`null` when it names none). */
  id: string | null;
  /** The reference kind (`block` for a witnessed component). */
  kind?: string;
  use: NikaCompileReuseUse;
  /** The witness of a composed component, re-derived from the candidate's bytes. */
  witness?: NikaCompileReuseWitness;
  [key: string]: unknown;
}

/** What one candidate holds of one component receipt. */
export interface NikaCompileReuseWitness {
  /** The component id the receipt names; `null` when it names none. */
  component: string | null;
  verdict: 'expanded' | 'invoked' | 'revised' | 'absent' | 'unreadable' | (string & {});
  /** The release the receipt names; `null` when it names none (a child program). */
  release?: NikaCompileComponentRelease | null;
  /** The child workflow path of an invoked component; `null` otherwise. */
  workflow?: string | null;
  /** sha256 (lowercase hex) of the candidate witnessed. */
  candidate_sha256?: string;
  /** The candidate digest the receipt was made on; `null` when it names none. */
  receipt_candidate_sha256?: string | null;
  /** The receipt's nodes found as receipted, changed since, or missing. */
  nodes?: { kept: string[]; changed: string[]; missing: string[]; [key: string]: unknown };
  /** The bound literals the candidate no longer holds. */
  bindings_not_held?: string[];
  [key: string]: unknown;
}

/** Authoring provenance — not program identity (#1664), not execution Proof. */
export interface NikaCompileProvenance {
  compiler_version: string;
  spec_pin: string;
  skeleton: string | null;
  cognition: NikaCompileCognition;
  /** The strategy that settled a free intent, when one was engaged. */
  strategy?: NikaCompileStrategy;
  /** A file name for the candidate, never a path the compiler touched. */
  suggested_file?: string | null;
  /** The plan record the round produced; a server keeps it behind its replay token. */
  plan?: NikaCompilePlanRecord;
  /** Bounded decision records, `semantic_verification` attempts included. */
  decision?: NikaCompileDecisionRecord;
  /** The provider-call receipt: present exactly when `compile_version` is 2. */
  authoring?: NikaCompileAuthoringReceipt;
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
 * The trigger the request names, stated beside the candidate whose bytes
 * carry no cadence, host or event: a requirement an operator binds through
 * the schedule contract, never a grant or a schedule row.
 */
export interface NikaCompileTrigger {
  kind: 'manual' | 'schedule' | 'webhook' | 'event' | (string & {});
  status: 'satisfied' | 'requires_binding' | 'unsupported' | (string & {});
  source_hint?: string | null;
  event_hint?: string | null;
  cadence?: string | null;
  /** The exact five-field projection when supported; older engines omit it. */
  cron?: string | null;
  at?: string | null;
  payload_input?: string | null;
  timezone?: string | null;
  missed?: string | null;
  overlap?: string | null;
  ceiling?: string | null;
  [key: string]: unknown;
}

/** A local engine's failure to keep or remove one of its `.nika/compile/` records. */
export interface NikaCompileRecordError {
  path: string;
  message: string;
  [key: string]: unknown;
}

/**
 * The machine codes a compile refusal carries on `NikaOperationError.code`.
 * HTTP (`POST /v1/compile`): `unauthorized` (401) · `request_timeout`,
 * `compile_deadline_exceeded` (408) · `compile_replay_unavailable`,
 * `compile_replay_input_changed`, `compile_context_changed` (409) ·
 * `body_too_large` (413) · `unsupported_media_type`,
 * `unsupported_content_encoding` (415) · `malformed_compile_request`,
 * `compile_version_unsupported`, `compile_mode_unsupported`,
 * `compile_cognition_unsupported`, `compile_limit`,
 * `compile_new_intent_required` (422) · `internal_error`,
 * `compile_disclosure_refused` (500) · `compile_busy`,
 * `compile_replay_capacity`, `stopping` (503). Local engine (exit 2 or 3):
 * `destination_name`, `invalid_answer`, `authoring_authority`, `read_base`,
 * `knowledge`, `authoring_config`, `compile_error`, `destination`. The
 * vocabulary is the engine's and stays open.
 */
export type NikaCompileRefusalCode =
  | 'unauthorized'
  | 'request_timeout'
  | 'compile_deadline_exceeded'
  | 'compile_replay_unavailable'
  | 'compile_replay_input_changed'
  | 'compile_context_changed'
  | 'body_too_large'
  | 'unsupported_media_type'
  | 'unsupported_content_encoding'
  | 'malformed_compile_request'
  | 'compile_version_unsupported'
  | 'compile_mode_unsupported'
  | 'compile_cognition_unsupported'
  | 'compile_limit'
  | 'compile_new_intent_required'
  | 'internal_error'
  | 'compile_disclosure_refused'
  | 'compile_busy'
  | 'compile_replay_capacity'
  | 'stopping'
  | 'destination_name'
  | 'invalid_answer'
  | 'authoring_authority'
  | 'read_base'
  | 'knowledge'
  | 'authoring_config'
  | 'compile_error'
  | 'destination'
  | (string & {});

/**
 * The reviewable authoring result. `candidate` is ordinary `.nika`
 * SOURCE in memory — it is not a `Workflow` handle, and `run()` does not
 * accept raw source: the caller materializes the candidate and `run(path)`
 * re-admits it. The engine never executes it.
 *
 * A candidate is proposed only when `status` is `ready`. Under `incomplete`
 * a non-null `candidate` is a preview: it may still carry holes, or the
 * verifier held it (`isNikaCompileHeld(outcome)`); a preview is never to be
 * run or saved as an accepted result.
 *
 * `incomplete` and `refused` are data, not exceptions: the SDK throws only
 * on transport, protocol, compatibility and engine-stamped failures.
 */
export interface NikaCompileOutcome {
  /**
   * The wire generation of this payload: 2 exactly when a provider call
   * happened (`provenance.authoring` is its receipt), 1 otherwise — a
   * skeleton, a structured constant, a replay and every deterministic round.
   */
  compile_version: 1 | 2;
  status: NikaCompileStatus;
  /** Exactly `status === 'ready'` — the engine's word, not a client judgment. */
  ready: boolean;
  /**
   * The candidate source, exactly as the engine wrote it (comments, Unicode
   * and line endings included); may still carry unfilled holes when not ready.
   */
  candidate: string | null;
  questions: NikaCompileQuestion[];
  diagnostics: NikaCompileDiagnostic[];
  /** The boundary the candidate requests (from its pure report); never a grant. */
  requested_boundary: Record<string, unknown> | null;
  /** The trigger the request names; absent on engines before the field (0.120.x). */
  requested_trigger?: NikaCompileTrigger | null;
  check_preview: NikaCompilePreview | null;
  provenance: NikaCompileProvenance;
  /**
   * HTTP only: the `Nika-Compile-Replay` header of a provider round that left
   * a native plan the server keeps. Send it back with the round's exact input
   * (see `nextCompileRequest`): `cognition: 'explicitProvider'` for its judged
   * answer round, `'deterministicOnly'` for its zero-call replay. It is valid
   * only on that server run, until a judged round holds its candidate; do not
   * log it.
   */
  replay_token?: string;
  /**
   * HTTP only, beside a kept round (this outcome carries a `replay_token`, or
   * its request answered one): whether the server that answered serves that
   * round's judged answer round, as its `/health` lists
   * `compileJudgedAnswerRound`. An SDK fact, not part of the engine's
   * document; `nextCompileRequest()` reads it.
   */
  judged_answer_round_available?: boolean;
  /**
   * Local engine only, and only when the request named `output`: the
   * destination the engine wrote (`null` when nothing was written).
   */
  written?: string | null;
  /** Local engine only: the named `output` that already existed and was left untouched. */
  existing_destination?: string;
  /** Local engine only: the plan record under `.nika/compile/` could not be kept or removed. */
  plan_record_error?: NikaCompileRecordError;
  /** Local engine only: this round's rejections could not be kept under `.nika/compile/`. */
  declined_record_error?: NikaCompileRecordError;
}

/* ------------------------------------------------------------------ */
/* Authoring Session — the engine's own `SessionRuntime` through its   */
/* host doors (`nika session --json` natively, `/v1/sessions` over     */
/* HTTP), contract `nika/session-host@1`. The engine reads every line  */
/* and holds every identity: the SDK carries frames, never classifies  */
/* a line, never rebuilds the work and never answers for the human.    */
/* `NikaRun` stays the separate observer of an executing Run.          */
/* ------------------------------------------------------------------ */

/** Options of `openSession()` and `attachSession()`. */
export interface NikaSessionOptions {
  /** Stops waiting for the door to open or answer; it never closes or stops the Session. */
  signal?: AbortSignal;
  /**
   * `openSession()` only: the intelligence this conversation prepares with,
   * in the engine's own first-screen words (e.g. `2 deepseek/deepseek-v4-pro`
   * or `1 acp:claude-code/opus[1m]`), passed as written. It holds for this
   * conversation alone: the engine neither reads nor writes the operator's
   * kept choice, and `work.intelligence.selected.scope` reads `conversation`.
   * Words the engine does not read are a `session_unavailable` refusal in its
   * own words. Needs the engine's `sessionIntelligence` capability: without
   * it nothing is started or posted. `attachSession()` refuses it.
   */
  intelligence?: string;
}

/** Options of one command (`submit`, `stop`, `close`). */
export interface NikaSessionCommandOptions {
  /**
   * The command's identity, 1–128 characters of `[A-Za-z0-9._:-]`. Sending
   * the same identity with the same bytes again returns the recorded result
   * (`replayed: true`) and never runs the turn twice: that is how a caller
   * whose wait was cut reads the result of a turn the engine kept running.
   * The same identity with other bytes is refused (`command_conflict`).
   * Default: a fresh random identity.
   */
  command?: string;
  /**
   * Stops this wait only. The engine keeps the accepted turn running;
   * `stop()` is the command that stops it, `close()` the one that ends the
   * Session.
   */
  signal?: AbortSignal;
}

/** Options of `events()`. */
export interface NikaSessionEventsOptions {
  /**
   * Resume after this event cursor (`<session>:<event>`, a previous event's
   * `cursor`). Without it the view starts with every event the door still
   * holds (the server's whole log, the events a local handle retains). Over
   * HTTP, a cursor the server cannot resume (another incarnation, beyond its
   * log) yields one `resync` frame carrying the current snapshot, then live
   * events. Natively a cursor whose events the handle no longer retains is
   * refused when iteration starts.
   */
  after?: string;
  /** Ends the iteration; it never stops or closes the Session. */
  signal?: AbortSignal;
}

/**
 * The work a Session holds, exactly as the engine serializes it (contract
 * `nika/session-work@0`): carried verbatim, never re-derived. Over HTTP
 * `root` names the server's project world, never a path on the client;
 * candidate file paths stay relative to it.
 */
export interface NikaSessionWork {
  contract: string;
  /** The engine's proven project root (the server's, over HTTP). */
  root: string;
  /** The request as the Session keeps it: goal, decisions, open questions. */
  request: Record<string, unknown>;
  /** The compiler's last word on the request, when the Session holds one. */
  authoring: NikaSessionAuthoring | null;
  /**
   * The intelligence the Session prepares with, as selected and resolved on
   * the engine's machine: configured facts, never a receipt of what served a
   * call (that is `authoring.calls`). Absent on engines before the 0.123
   * integration.
   */
  intelligence?: NikaSessionIntelligence | null;
  /** What the next line answers, by the Session's own precedence. */
  waiting: NikaSessionWaiting;
  /** The candidate under review: the exact changes a consent lands. */
  candidate: NikaSessionCandidate | null;
  /** The workflow the last consent saved. Save is never a Run. */
  saved: Record<string, unknown> | null;
  /** The Run this Session requested last: a request, never an observation. */
  requested: Record<string, unknown> | null;
  /** The last observed Run, with only the identities its observation carried. */
  run: NikaSessionRun | null;
  /** The automation rail, each field at its own stage. */
  rail: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The compiler's last word on the request (`work.authoring`): its status,
 * questions and notes as the engine wrote them, the candidate it drafted and
 * the receipt of its authoring calls.
 */
export interface NikaSessionAuthoring {
  /**
   * The compiler's candidate bytes, proposed or not: what to show while a
   * question waits. Showing it consents to nothing; only `work.candidate` is
   * consentable. `null` when the compiler drafted nothing.
   */
  draft?: string | null;
  /**
   * What the compile's authoring calls reported, read from the compiler's
   * receipt: the snapshot's one actual-call evidence. `null` when the compile
   * made no authoring call.
   */
  calls?: NikaSessionAuthoringCalls | null;
  [key: string]: unknown;
}

/** The receipt of one compile's authoring calls, never re-derived. */
export interface NikaSessionAuthoringCalls {
  /** Requested: the model the calls asked for, never the one that served them. */
  requested_model: string;
  /** The provider calls attempted. */
  calls: number;
  /** Reported input tokens; `null` when the provider omitted usage (never `0` for unknown). */
  input_tokens?: number | null;
  /** Reported output tokens; `null` when the provider omitted usage. */
  output_tokens?: number | null;
  /** The wall time spent awaiting the provider. */
  elapsed_ms: number;
  /**
   * Reported: the backend that answered as its transport named it
   * (`direct_api`, or `acp_harness` with the model it observed); `null` when
   * the transport said nothing.
   */
  backend?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * The intelligence a Session prepares with (`work.intelligence`): the
 * selection, the authoring seat, the decision seat selected and the explicit
 * reasoning effort. Configured facts only: a selected seat is not one that
 * answered, and a selection is never the model that served a call.
 */
export interface NikaSessionIntelligence {
  /** The person's selection as the engine's machine resolved it; `null` before one was made. */
  selected?: NikaSessionSelectedIntelligence | null;
  /** The seat that authors under that selection. */
  author: NikaSessionAuthor;
  /** The decision seat selected for finite choices; whether it answered is the compile's record. */
  decision?: { model: string; refusal?: string | null; [key: string]: unknown } | null;
  /** The explicit reasoning effort (`low`, `high`, `max`); `null` keeps each route's default. */
  effort?: string | null;
  [key: string]: unknown;
}

/** A person's selection, as the engine's machine resolved it. */
export interface NikaSessionSelectedIntelligence {
  /** `harness` (an AI app the person has), `api` (a metered provider), `local` or `none`. */
  kind: 'harness' | 'api' | 'local' | 'none' | (string & {});
  /** The harness seat or the provider; `null` for `none`. */
  via?: string | null;
  /** How a harness seat is reached (`native`, `acp`); `null` for every other kind. */
  transport?: string | null;
  /** The model the selection names; `null` lets the provider choose. */
  model?: string | null;
  /** Where the context goes, in the words the person read before the first turn. */
  locus?: string;
  /** Whether that machine can serve the selection now. */
  ready?: boolean;
  /** Why it cannot, with the fix, when it cannot. */
  refusal?: string | null;
  /**
   * Whose choice it is: `conversation` when this conversation's own (named
   * by `openSession({ intelligence })`, chosen in it or kept by its history),
   * held for it alone; `operator_default` when the operator's kept choice.
   * Absent on engines before the conversation-scoped selection.
   */
  scope?: 'conversation' | 'operator_default' | (string & {});
  [key: string]: unknown;
}

/** The seat that authors: a provider model, a harness seat, the deterministic reading, or none. */
export interface NikaSessionAuthor {
  /** `provider`, `harness`, `deterministic` or `unavailable`. */
  kind: 'provider' | 'harness' | 'deterministic' | 'unavailable' | (string & {});
  /** The model it authors with, when one is named (`<provider>/<name>`). */
  model?: string | null;
  /** The harness seat, for a harness (`codex`, `claude-code`). */
  seat?: string | null;
  /** How the harness seat is reached (`native`, `acp`). */
  transport?: string | null;
  /** Why no model authors, or why the selection cannot be honored. */
  why?: string | null;
  [key: string]: unknown;
}

/** The candidate under review (`work.candidate`): the exact changes a consent lands. */
export interface NikaSessionCandidate {
  files: NikaSessionCandidateFile[];
  /**
   * How the workflow it lands was revised over its complete document, bound
   * to these exact bytes (never an earlier candidate's); `null` when it was
   * not a revision. A compact projection: the compile's own record is fuller.
   */
  revision?: NikaSessionDocumentRevision | null;
  [key: string]: unknown;
}

/** The revision a Session candidate carries (`work.candidate.revision`). */
export interface NikaSessionDocumentRevision {
  /** `operations` (literal edits and component merges) or `replaced` (the whole source). */
  mode: 'operations' | 'replaced' | (string & {});
  /** sha256 (lowercase hex) of the bytes revised; `null` when none was named. */
  base_sha256: string | null;
  /** sha256 (lowercase hex) of the candidate's bytes, the ones the record binds. */
  candidate_sha256: string;
  /** The node paths and components the operations changed, in order. */
  changed: string[];
  /** The preservation claimed, in words. */
  preservation?: string;
  /** The admitted components the bytes hold. */
  components: NikaSessionComponentUse[];
  [key: string]: unknown;
}

/** One admitted component a revised candidate holds. */
export interface NikaSessionComponentUse {
  /** `block:<name>`. */
  id: string;
  /** The release version it resolved in. */
  version?: string | null;
  /** The release snapshot it resolved in. */
  release?: string | null;
  /** sha256 of the admitted bytes it was expanded from. */
  file_sha256?: string | null;
  /** Each hole bound, with its literal (any JSON value). */
  bindings: { path: string; value: unknown; [key: string]: unknown }[];
  /** What the bytes show of it now: `expanded`, `revised`, `absent` or `unwitnessed`. */
  witness: string;
  [key: string]: unknown;
}

/**
 * The last Run a Session observed (`work.run`), with only the identities its
 * observation carried and nothing re-derived. A `null` member is unknown, never
 * guessed: a Run whose `workflow_sha256` is `null` ran bytes the snapshot does
 * not name (both session-host doors of the 0.123 integration observe a Run
 * without that identity), so it does not prove the saved bytes ran.
 */
export interface NikaSessionRun {
  /**
   * The Run of the workflow this Session saved last. `false` for a Run kept
   * from an earlier session or observed before a later Save: evidence, never
   * the result of the bytes saved now.
   */
  current: boolean;
  /** The workflow the Run was asked of, relative to `work.root`. */
  workflow: string | null;
  /** How it ended, when its exit was observed. */
  end: NikaSessionRunEnd | null;
  /** The trace its settlement named, as the engine names it. */
  trace: string | null;
  /** The execution its frames and settlement carried. */
  execution: string | null;
  /** The source hash its start named: the exact bytes it ran. */
  workflow_sha256: string | null;
  /** The journal head its receipt named. */
  chain_head: string | null;
  /** The journal length its receipt named. */
  chain_len: number | null;
  [key: string]: unknown;
}

/**
 * How an observed Run ended, from the exit the host observed (`end`:
 * `succeeded`, `failed`, `refused_findings`, `refused_environment`, `paused`,
 * `interrupted`, or `unknown` with its `exit` code); the vocabulary stays open.
 */
export interface NikaSessionRunEnd {
  end:
    | 'succeeded'
    | 'failed'
    | 'refused_findings'
    | 'refused_environment'
    | 'paused'
    | 'interrupted'
    | 'unknown'
    | (string & {});
  /** The exit code, beside `unknown`. */
  exit?: number;
  [key: string]: unknown;
}

/** One file of a candidate. */
export interface NikaSessionCandidateFile {
  /** Relative to `work.root`. */
  path: string;
  /** The BLAKE3 witness (64 lowercase hex) of the exact bytes a consent lands; not a sha256. */
  bytes: string;
  /**
   * Those exact bytes, as the Session holds them: what to render, parse or
   * hash without reading anything else. Absent on engines before the 0.123
   * integration.
   */
  content?: string;
  /** `create` or `update`. */
  landing?: string;
  /** The BLAKE3 witness of the bytes an update replaces; `null` for a creation. */
  replaces?: string | null;
  /** Whether the file is a workflow. */
  workflow?: boolean;
  [key: string]: unknown;
}

/**
 * What the next line answers (`kind`: `free`, `run_review`, `cost_choice`,
 * `intelligence_choice`, `consent`, `gate`, `question`, `input`,
 * `activation`). The identity it carries (a question's witness, a proposal)
 * is data to show: the snapshot handle a line names is what binds an answer.
 */
export interface NikaSessionWaiting {
  kind: string;
  [key: string]: unknown;
}

/** The turn under way, when one is. */
export interface NikaSessionBusy {
  command: string;
  /** `preparing`, `running` or `settling`; the vocabulary stays open. */
  phase: string;
  stop_requested: boolean;
  [key: string]: unknown;
}

/** One published snapshot: the handle a line names, and the work it shows. */
export interface NikaSessionSnapshot {
  /** The opaque handle a submitted line names; resolvable only in its Session. */
  snapshot: string;
  /** The publish counter (not an event number). */
  seq: number;
  busy: NikaSessionBusy | null;
  work: NikaSessionWork;
  [key: string]: unknown;
}

/** One outcome of a settled turn, in order (`kind` names it; the vocabulary stays open). */
export interface NikaSessionOutcome {
  kind: string;
  text?: string;
  [key: string]: unknown;
}

/** Members every frame carries. */
interface NikaSessionFrameBase {
  contract: string;
  session: string;
  /** Present exactly on an event: its number in the Session. */
  event?: number;
  [key: string]: unknown;
}

export interface NikaSessionOpened extends NikaSessionFrameBase {
  frame: 'opened';
  snapshot: NikaSessionSnapshot;
  notices?: unknown[];
}

/** A settled command: its outcomes (submit), its receipt (stop), and the snapshot it published. */
export interface NikaSessionResult extends NikaSessionFrameBase {
  frame: 'result';
  command: string;
  op: 'submit' | 'stop' | 'close' | (string & {});
  /** `true` when the recorded result of an earlier identical command came back. */
  replayed: boolean;
  outcomes?: NikaSessionOutcome[];
  /** Stop only: `stop_requested`, `nothing_to_stop` or `run_underway`. A receipt is not a settlement. */
  receipt?: string;
  /** Stop only: the command it targeted, or `null`. */
  target?: string | null;
  snapshot: NikaSessionSnapshot;
}

export interface NikaSessionClosed extends NikaSessionFrameBase {
  frame: 'closed';
  snapshot: NikaSessionSnapshot;
}

export interface NikaSessionDetails extends NikaSessionFrameBase {
  frame: 'details';
  /** The handle of the snapshot whose details these are. */
  snapshot: string;
  /** The Session's details text, captured when that snapshot was published. */
  text: string;
}

/**
 * One event of the Session (`opened`, `accepted`, `activity`, `result`,
 * `closed`, and over HTTP `resync`), as the engine wrote it. `cursor` is the
 * resume point for `events({ after })`.
 */
export interface NikaSessionEvent extends NikaSessionFrameBase {
  frame: string;
  /** `<session>:<event>`; a `resync` carries the point it resynchronized to. */
  cursor?: string;
}
