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

export interface NikaTraceVerifyResult {
  verified: boolean;
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
