import type {
  NikaJob,
  NikaArtifact,
  NikaEvent,
  RunResponse,
  ArtifactsResponse,
  CancelResponse,
  RunOptions,
  StreamOptions,
} from '../types.js';
import type { ApiClient } from '../lib/api-client.js';
import { NikaError } from '../errors.js';
import { pollUntilDone } from '../lib/polling.js';
import { streamEvents } from '../lib/streaming.js';

export interface JobsPollConfig {
  pollInterval: number;
  pollTimeout: number;
  pollBackoff: number;
}

export class Jobs {
  constructor(
    private readonly api: ApiClient,
    private readonly poll: JobsPollConfig,
  ) {}

  /** Submit a workflow and return immediately with job ID. */
  async submit(
    workflow: string,
    inputs?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<RunResponse> {
    return this.api.json<RunResponse>('/v1/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow,
        ...(inputs !== undefined ? { inputs } : {}),
        ...(options?.resumeFrom ? { resume_from: options.resumeFrom } : {}),
      }),
      signal: options?.signal,
    });
  }

  /** Get current job status. */
  async status(jobId: string): Promise<NikaJob> {
    return this.api.json<NikaJob>(`/v1/status/${jobId}`);
  }

  /** Cancel a running job. */
  async cancel(jobId: string): Promise<CancelResponse> {
    return this.api.json<CancelResponse>(`/v1/cancel/${jobId}`, { method: 'POST' });
  }

  /** Run a workflow and wait for completion (polling). */
  async run(
    workflow: string,
    inputs?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<NikaJob> {
    const { job_id } = await this.submit(workflow, inputs, options);
    return pollUntilDone(
      () => this.status(job_id),
      {
        interval: this.poll.pollInterval,
        timeout: this.poll.pollTimeout,
        backoff: this.poll.pollBackoff,
        signal: options?.signal,
      },
    );
  }

  /** Stream job events via SSE (AsyncIterable). */
  stream(jobId: string, options?: StreamOptions): AsyncIterable<NikaEvent> {
    return streamEvents(this.api, jobId, options);
  }

  /** List artifacts for a job. */
  async artifacts(jobId: string): Promise<NikaArtifact[]> {
    const res = await this.api.json<ArtifactsResponse>(`/v1/jobs/${jobId}/artifacts`);
    return res.artifacts;
  }

  /** Download a specific artifact as string. */
  async artifact(jobId: string, name: string): Promise<string> {
    const res = await this.api.request(
      `/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`,
    );
    return res.text();
  }

  /** Download a specific artifact as parsed JSON. */
  async artifactJson<T = unknown>(jobId: string, name: string): Promise<T> {
    const res = await this.api.request(
      `/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`,
    );
    return res.json() as Promise<T>;
  }

  /** Download a specific artifact as raw bytes. */
  async artifactBinary(jobId: string, name: string): Promise<Uint8Array> {
    const res = await this.api.request(
      `/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`,
    );
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /** Stream an artifact as a ReadableStream (for large files). */
  async artifactStream(jobId: string, name: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.api.request(
      `/v1/jobs/${jobId}/artifacts/${encodeURIComponent(name)}`,
    );
    if (!res.body) {
      throw new NikaError('Artifact response has no body');
    }
    return res.body;
  }

  /** Run workflow, wait, and collect all non-binary artifacts into a map. */
  async runAndCollect(
    workflow: string,
    inputs?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<Record<string, unknown>> {
    const job = await this.run(workflow, inputs, options);
    const artifactList = await this.artifacts(job.job_id);

    const downloadable = artifactList.filter(art => art.format !== 'binary');

    // Download in batches of 6 to avoid overwhelming the server
    const batchSize = 6;
    const entries: [string, unknown][] = [];

    for (let i = 0; i < downloadable.length; i += batchSize) {
      const batch = downloadable.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (art): Promise<[string, unknown]> => {
          if (art.format === 'json') {
            return [art.name, await this.artifactJson(job.job_id, art.name)];
          }
          return [art.name, await this.artifact(job.job_id, art.name)];
        }),
      );
      entries.push(...results);
    }

    return Object.fromEntries(entries);
  }
}
