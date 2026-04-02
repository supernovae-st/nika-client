// Types aligned with nika-serve Rust source (routes/workflows.rs, routes/artifacts.rs, events.rs)

export interface NikaConfig {
  /** URL of nika serve (e.g. http://localhost:3000) */
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

// ── SSE Events ──────────────────────────────────────────────

export type NikaEventType =
  | 'started'
  | 'task_start'
  | 'task_complete'
  | 'task_failed'
  | 'artifact_written'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NikaEvent {
  type: NikaEventType;
  job_id: string;
  task_id?: string;
  verb?: string;
  duration_ms?: number;
  error?: string;
  output?: string;
  path?: string;
  size?: number;
}
