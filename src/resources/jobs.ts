import type {
  NikaJob,
  NikaEvent,
  JobStatusOnly,
  RunOptions,
  StreamOptions,
} from '../types.js';
import type { ApiClient } from '../lib/api-client.js';
import { NikaError, NikaUnavailableError } from '../errors.js';
import { pollUntilDone } from '../lib/polling.js';
import { streamEvents } from '../lib/streaming.js';

export interface JobsPollConfig {
  pollInterval: number;
  pollTimeout: number;
  pollBackoff: number;
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export class Jobs {
  constructor(
    private readonly api: ApiClient,
    private readonly poll: JobsPollConfig,
  ) {}

  /**
   * Admit a workflow. The live body is `{ workflow }` only.
   * Passing `inputs` throws — the server deny_unknown_fields that object.
   */
  async submit(
    workflow: string,
    inputs?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<NikaJob> {
    if (inputs !== undefined) {
      throw new NikaError(
        'nika serve POST /v1/jobs accepts { workflow } only. '
        + 'Inputs stay on LocalNika / the workflow file defaults. '
        + 'Sending them is a 422 on the live server.',
      );
    }
    const key = options?.idempotencyKey ?? newIdempotencyKey();
    if (key.length < 1 || key.length > 255) {
      throw new NikaError('Idempotency-Key must be 1–255 bytes');
    }
    return this.api.json<NikaJob>('/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ workflow }),
      signal: options?.signal,
    });
  }

  /** GET /v1/jobs/{id} — identity and status. */
  async status(jobId: string): Promise<NikaJob> {
    return this.api.json<NikaJob>(`/v1/jobs/${jobId}`);
  }

  /** GET /v1/jobs/{id}/status — status only. */
  async statusOnly(jobId: string): Promise<JobStatusOnly> {
    return this.api.json<JobStatusOnly>(`/v1/jobs/${jobId}/status`);
  }

  /** Cancel is not on the live HTTP surface (W08 keep 404). */
  async cancel(_jobId: string): Promise<never> {
    throw new NikaUnavailableError('POST /v1/jobs/{id}/cancel');
  }

  /** Admit and poll until succeeded, failed, or interrupted. */
  async run(
    workflow: string,
    inputs?: Record<string, unknown>,
    options?: RunOptions,
  ): Promise<NikaJob> {
    const { id } = await this.submit(workflow, inputs, options);
    return pollUntilDone(
      () => this.status(id),
      {
        interval: this.poll.pollInterval,
        timeout: this.poll.pollTimeout,
        backoff: this.poll.pollBackoff,
        signal: options?.signal,
      },
    );
  }

  /** GET /v1/jobs/{id}/events as an AsyncIterable. */
  stream(jobId: string, options?: StreamOptions): AsyncIterable<NikaEvent> {
    return streamEvents(this.api, jobId, options);
  }

  async artifacts(_jobId: string): Promise<never> {
    throw new NikaUnavailableError('GET /v1/jobs/{id}/artifacts');
  }

  async artifact(_jobId: string, _name: string): Promise<never> {
    throw new NikaUnavailableError('GET /v1/jobs/{id}/artifacts/{name}');
  }

  async artifactJson<T = unknown>(_jobId: string, _name: string): Promise<T> {
    throw new NikaUnavailableError('GET /v1/jobs/{id}/artifacts/{name}');
  }

  async artifactBinary(_jobId: string, _name: string): Promise<Uint8Array> {
    throw new NikaUnavailableError('GET /v1/jobs/{id}/artifacts/{name}');
  }

  async artifactStream(
    _jobId: string,
    _name: string,
  ): Promise<ReadableStream<Uint8Array>> {
    throw new NikaUnavailableError('GET /v1/jobs/{id}/artifacts/{name}');
  }

  async runAndCollect(
    _workflow: string,
    _inputs?: Record<string, unknown>,
    _options?: RunOptions,
  ): Promise<Record<string, unknown>> {
    throw new NikaUnavailableError('job artifacts');
  }
}
