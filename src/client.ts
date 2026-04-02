import type {
  NikaConfig,
  NikaJob,
  NikaArtifact,
  NikaEvent,
  NikaHealth,
  RunResponse,
  ArtifactsResponse,
  CancelResponse,
} from './types.js';
import { NikaError, NikaJobError } from './errors.js';
import { pollUntilDone } from './poll.js';
import { streamEvents } from './stream.js';

const DEFAULTS = {
  timeout: 30_000,
  retries: 2,
  pollInterval: 2_000,
  pollTimeout: 300_000,
  pollBackoff: 1.5,
};

export class Nika {
  private readonly url: string;
  private readonly token: string;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly pollInterval: number;
  private readonly pollTimeout: number;
  private readonly pollBackoff: number;

  constructor(config: NikaConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
    this.timeout = config.timeout ?? DEFAULTS.timeout;
    this.retries = config.retries ?? DEFAULTS.retries;
    this.pollInterval = config.pollInterval ?? DEFAULTS.pollInterval;
    this.pollTimeout = config.pollTimeout ?? DEFAULTS.pollTimeout;
    this.pollBackoff = config.pollBackoff ?? DEFAULTS.pollBackoff;
  }

  // ── Internal fetch with retry + auth ──────────────────────

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.url}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      ...(init?.headers as Record<string, string> ?? {}),
    };

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        if (res.ok) return res;

        if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
          const retryAfter = res.headers.get('Retry-After');
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : 1000 * (attempt + 1);
          await sleep(delay);
          continue;
        }

        const body = await res.text().catch(() => '');
        throw new NikaError(
          `${res.status} ${res.statusText}: ${body}`.trim(),
          res.status,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    throw new NikaError('Max retries exceeded', 503);
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    return res.json() as Promise<T>;
  }

  // ── Public API ────────────────────────────────────────────

  /** Health check (no auth required). */
  async health(): Promise<NikaHealth> {
    const res = await globalThis.fetch(`${this.url}/health`);
    if (!res.ok) {
      throw new NikaError(`Health check failed: ${res.status}`, res.status);
    }
    return res.json() as Promise<NikaHealth>;
  }

  /** Submit a workflow and return immediately with job ID. */
  async submit(
    workflow: string,
    inputs?: Record<string, unknown>,
    resumeFrom?: string,
  ): Promise<RunResponse> {
    return this.json<RunResponse>('/v1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow,
        inputs: inputs ?? {},
        ...(resumeFrom ? { resume_from: resumeFrom } : {}),
      }),
    });
  }

  /** Get current job status. */
  async status(jobId: string): Promise<NikaJob> {
    return this.json<NikaJob>(`/v1/status/${jobId}`);
  }

  /** Cancel a running job. */
  async cancel(jobId: string): Promise<CancelResponse> {
    return this.json<CancelResponse>(`/v1/cancel/${jobId}`, { method: 'POST' });
  }

  /** Run a workflow and wait for completion (polling). */
  async run(
    workflow: string,
    inputs?: Record<string, unknown>,
    resumeFrom?: string,
  ): Promise<NikaJob> {
    const { job_id } = await this.submit(workflow, inputs, resumeFrom);
    return pollUntilDone(
      () => this.status(job_id),
      {
        interval: this.pollInterval,
        timeout: this.pollTimeout,
        backoff: this.pollBackoff,
      },
    );
  }

  /** Stream job events via SSE (AsyncIterable). */
  stream(jobId: string): AsyncIterable<NikaEvent> {
    return streamEvents(
      `${this.url}/v1/events/${jobId}`,
      { 'Authorization': `Bearer ${this.token}` },
    );
  }

  /** List artifacts for a job. */
  async artifacts(jobId: string): Promise<NikaArtifact[]> {
    const res = await this.json<ArtifactsResponse>(`/v1/jobs/${jobId}/artifacts`);
    return res.artifacts;
  }

  /** Download a specific artifact as string. */
  async artifact(jobId: string, name: string): Promise<string> {
    const res = await this.fetch(
      `/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`,
    );
    return res.text();
  }

  /** Download a specific artifact as parsed JSON. */
  async artifactJson<T = unknown>(jobId: string, name: string): Promise<T> {
    const res = await this.fetch(
      `/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`,
    );
    return res.json() as Promise<T>;
  }

  /** Run workflow, wait, and collect all non-binary artifacts into a map. */
  async runAndCollect(
    workflow: string,
    inputs?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const job = await this.run(workflow, inputs);

    if (job.status === 'failed') {
      throw new NikaJobError(job);
    }

    const result: Record<string, unknown> = {};
    const artifactList = await this.artifacts(job.job_id);

    for (const art of artifactList) {
      if (art.format === 'json') {
        result[art.name] = await this.artifactJson(job.job_id, art.name);
      } else if (art.format !== 'binary') {
        result[art.name] = await this.artifact(job.job_id, art.name);
      }
    }

    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
