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

  /**
   * Create a Nika client from environment variables.
   * Reads `NIKA_URL` and `NIKA_TOKEN`. Throws if either is missing.
   *
   * @param overrides — optional config fields to override env values
   */
  static fromEnv(overrides?: Partial<NikaConfig>): Nika {
    const url = overrides?.url ?? process.env.NIKA_URL;
    const token = overrides?.token ?? process.env.NIKA_TOKEN;
    if (!url) {
      throw new TypeError(
        'NIKA_URL environment variable is not set. '
        + 'Set it or pass url explicitly: new Nika({ url: "http://localhost:3000", token: "..." })',
      );
    }
    if (!token) {
      throw new TypeError(
        'NIKA_TOKEN environment variable is not set. '
        + 'Set it or pass token explicitly: new Nika({ url: "...", token: "your-token" })',
      );
    }
    return new Nika({ ...overrides, url, token } as NikaConfig);
  }

  constructor(config: NikaConfig) {
    if (!config.url) {
      throw new TypeError(
        'NikaConfig.url is required — pass the nika serve URL.\n'
        + '  Example: new Nika({ url: "http://localhost:3000", token: "..." })\n'
        + '  Or use:  Nika.fromEnv() to read NIKA_URL and NIKA_TOKEN from environment',
      );
    }
    if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
      throw new TypeError(
        `NikaConfig.url must start with http:// or https://, got: "${config.url}"`,
      );
    }
    if (!config.token) {
      throw new TypeError(
        'NikaConfig.token is required — set NIKA_TOKEN env var or pass token in config.\n'
        + '  Or use:  Nika.fromEnv() to read both from environment',
      );
    }

    this.api = new ApiClient(
      config.url.replace(/\/$/, ''),
      config.token,
      config.timeout ?? 30_000,
      config.retries ?? 2,
      config.fetch ?? globalThis.fetch.bind(globalThis),
      config.concurrency ?? 24,
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
export type { ListPageOptions } from './resources/workflows.js';
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
