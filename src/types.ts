// Preview wire types for the intended workflow HTTP + SSE service contract.

// ── Config ─────────────────────────────────────────────────

export interface NikaLogger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export interface NikaConfig {
  /** URL of a compatible workflow service (e.g. https://api.example.test) */
  url: string;
  /** Bearer token for authentication */
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
  /** Max concurrent HTTP requests to the workflow service. Default: 24 */
  concurrency?: number;
  /** Custom fetch function. Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Logger for request/response tracing. Default: silent */
  logger?: NikaLogger;
}

// ── Run ─────────────────────────────────────────────────────

export interface RunRequest {
  workflow: string;
  inputs?: Record<string, unknown>;
  resume_from?: string;
}

/** POST /v1/run response */
export interface RunResponse {
  job_id: string;
  status: string;
}

export interface RunOptions {
  resumeFrom?: string;
  signal?: AbortSignal;
}

// ── Status ──────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** GET /v1/status/{id} response */
export interface NikaJob {
  job_id: string;
  status: JobStatus;
  workflow: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  output?: string;
}

// ── Cancel ──────────────────────────────────────────────────

export interface CancelResponse {
  job_id: string;
  status: string;
  message?: string;
}

// ── Artifacts ───────────────────────────────────────────────

export interface NikaArtifact {
  name: string;
  size: number;
  format: string;
  content_type: string;
  checksum?: string;
}

/** GET /v1/jobs/{id}/artifacts response */
export interface ArtifactsResponse {
  job_id: string;
  count: number;
  artifacts: NikaArtifact[];
}

// ── Health ──────────────────────────────────────────────────

/** GET /health response */
export interface NikaHealth {
  status: 'ok';
  version: string;
  service: string;
}

// ── Workflows ───────────────────────────────────────────────

export interface WorkflowInfo {
  name: string;
  size: number;
}

/** GET /v1/workflows response */
export interface ListWorkflowsResponse {
  workflows: WorkflowInfo[];
  count: number;
  /** Whether more results exist (present when `limit` is set). */
  has_more?: boolean;
}

// ── SSE Events (discriminated union matching Rust ServeEvent) ──

export type NikaEvent =
  | { type: 'started'; job_id: string }
  | { type: 'task_start'; job_id: string; task_id: string; verb: string }
  | { type: 'task_complete'; job_id: string; task_id: string; duration_ms: number }
  | { type: 'task_failed'; job_id: string; task_id: string; error: string; duration_ms: number }
  | { type: 'artifact_written'; job_id: string; task_id: string; path: string; size: number }
  | { type: 'completed'; job_id: string; output: string | null }
  | { type: 'failed'; job_id: string; error: string | null }
  | { type: 'cancelled'; job_id: string };

export type NikaEventType = NikaEvent['type'];

// ── Stream options ──────────────────────────────────────────

export interface StreamOptions {
  signal?: AbortSignal;
  /** Max ms without any event before treating connection as dead. Default: 60_000 */
  idleTimeout?: number;
  /** Max reconnection attempts on stream drop. Default: 3 */
  maxReconnects?: number;
  /** Initial reconnect delay in ms (multiplied by attempt). Default: 1000 */
  reconnectDelay?: number;
}

// ── Poll options (internal) ─────────────────────────────────

export interface PollOptions {
  interval: number;
  timeout: number;
  backoff: number;
  signal?: AbortSignal;
}
