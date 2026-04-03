import type { NikaConfig, NikaHealth } from './types.js';
import { NikaAPIError } from './errors.js';
import { ApiClient } from './lib/api-client.js';
import { Jobs } from './resources/jobs.js';
import { Workflows } from './resources/workflows.js';
import { verifyWebhookSignature } from './webhook.js';

export class Nika {
  /** Job operations: submit, status, cancel, run, stream, artifacts. */
  readonly jobs: Jobs;
  /** Workflow operations: list, reload. */
  readonly workflows: Workflows;

  private readonly api: ApiClient;

  constructor(config: NikaConfig) {
    if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
      throw new TypeError(`NikaConfig.url must be an http(s) URL, got: ${config.url}`);
    }
    if (!config.token) {
      throw new TypeError('NikaConfig.token must not be empty');
    }

    this.api = new ApiClient(
      config.url.replace(/\/$/, ''),
      config.token,
      config.timeout ?? 30_000,
      config.retries ?? 2,
      config.fetch ?? globalThis.fetch.bind(globalThis),
      config.logger,
    );

    this.jobs = new Jobs(this.api, {
      pollInterval: config.pollInterval ?? 2_000,
      pollTimeout: config.pollTimeout ?? 300_000,
      pollBackoff: config.pollBackoff ?? 1.5,
    });

    this.workflows = new Workflows(this.api);
  }

  /** Health check (no auth required, uses timeout). */
  async health(): Promise<NikaHealth> {
    const res = await this.api.fetchHealth();
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new NikaAPIError(
        `Health check failed: ${res.status} ${body}`.trim(),
        res.status,
        body,
      );
    }
    return res.json() as Promise<NikaHealth>;
  }

  /**
   * Verify a webhook signature from nika serve.
   *
   * @param payload — raw request body string
   * @param signature — value of X-Nika-Signature header
   * @param secret — shared webhook secret (NIKA_WEBHOOK_SECRET)
   * @param tolerance — max age in seconds (default: 300)
   */
  static verifyWebhook = verifyWebhookSignature;
}

// ── Re-exports ──────────────────────────────────────────────

export { Jobs } from './resources/jobs.js';
export { Workflows } from './resources/workflows.js';
export { verifyWebhookSignature } from './webhook.js';

export {
  NikaError,
  NikaAPIError,
  NikaConnectionError,
  NikaTimeoutError,
  NikaJobError,
  NikaJobCancelledError,
} from './errors.js';

export type {
  NikaConfig,
  NikaLogger,
  NikaJob,
  NikaArtifact,
  NikaEvent,
  NikaEventType,
  NikaHealth,
  JobStatus,
  RunRequest,
  RunResponse,
  RunOptions,
  CancelResponse,
  ArtifactsResponse,
  WorkflowInfo,
  ListWorkflowsResponse,
  StreamOptions,
  PollOptions,
} from './types.js';
