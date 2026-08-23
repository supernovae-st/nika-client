// Live wire types for nika serve HTTP + SSE (W06/W07).
// Pin: ./openapi.json · generated: src/generated/openapi.d.ts

export interface NikaLogger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export interface NikaConfig {
  /** URL of a nika serve listener (e.g. http://127.0.0.1:8787) */
  url: string;
  /** Bearer token matching the server --token-file */
  token: string;
  /** Global HTTP request timeout in ms. Default: 30_000 */
  timeout?: number;
  /** Retries on 429/5xx. Default: 2 */
  retries?: number;
  /** Initial polling interval in ms. Default: 2_000 */
  pollInterval?: number;
  /** Max polling timeout in ms. Default: 300_000 (5 min) */
  pollTimeout?: number;
  /** Backoff multiplier for polling. Default: 1.5 */
  pollBackoff?: number;
  /** Max concurrent HTTP requests. Default: 24 */
  concurrency?: number;
  /** Custom fetch function. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Logger for request/response tracing. Default: silent */
  logger?: NikaLogger;
}

/** POST /v1/jobs body. The live server deny_unknown_fields this object. */
export interface CreateJobRequest {
  workflow: string;
}

/** Live JobStatus enum from OpenAPI. */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'paused'
  | 'succeeded'
  | 'failed';

/** POST /v1/jobs and GET /v1/jobs/{id} body. */
export interface NikaJob {
  id: string;
  status: JobStatus;
}

/** GET /v1/jobs/{id}/status body. */
export interface JobStatusOnly {
  status: JobStatus;
}

export interface RunOptions {
  /** Caller-supplied Idempotency-Key (1–255 bytes). Default: a random UUID. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** GET /health — public process identity, no Bearer. */
export interface NikaHealth {
  status: 'ok';
  service: string;
  engine_version?: string;
  build_sha?: string;
  spec_sha?: string;
  api_version?: string;
}

/** GET /v1/workflows — contained relative names. */
export interface ListWorkflowsResponse {
  workflows: string[];
}

/** GET /v1/workflows/{name} */
export interface WorkflowMetadata {
  workflow: string;
}

/**
 * SSE data payload from GET /v1/jobs/{id}/events.
 * Allowlisted to {sequence, kind, status} — never a rich task log.
 */
export interface NikaEvent {
  sequence: number;
  kind?: string;
  status?: JobStatus | string;
}

export type NikaEventType = string;

export interface StreamOptions {
  signal?: AbortSignal;
  /** Max ms without any event before treating connection as dead. Default: 60_000 */
  idleTimeout?: number;
  /** Max reconnection attempts on stream drop. Default: 3 */
  maxReconnects?: number;
  /** Initial reconnect delay in ms (multiplied by attempt). Default: 1000 */
  reconnectDelay?: number;
}

export interface PollOptions {
  interval: number;
  timeout: number;
  backoff: number;
  signal?: AbortSignal;
}

/** @deprecated Preview-dialect leftover. Cancel is not on the live HTTP surface. */
export interface CancelResponse {
  id: string;
  status: string;
  message?: string;
}

/** @deprecated Preview-dialect leftover. Artifacts are not on the live HTTP surface. */
export interface NikaArtifact {
  name: string;
  size: number;
  format: string;
  content_type: string;
  checksum?: string;
}

/** @deprecated Preview-dialect leftover. */
export interface ArtifactsResponse {
  id: string;
  count: number;
  artifacts: NikaArtifact[];
}

/** @deprecated Use NikaJob. Kept as an alias so existing imports compile. */
export type RunResponse = NikaJob;
