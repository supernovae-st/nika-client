import type { NikaJob } from './types.js';

/** Base error for all SDK errors. Catch this to handle any nika-client error. */
export class NikaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NikaError';
  }
}

/** HTTP error from nika serve (non-2xx response). */
export class NikaAPIError extends NikaError {
  public readonly status: number;
  public readonly body: string;
  public readonly requestId?: string;

  constructor(message: string, status: number, body: string, requestId?: string) {
    super(message);
    this.name = 'NikaAPIError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

/** Network or connection error (DNS, TCP reset, refused). */
export class NikaConnectionError extends NikaError {
  public override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'NikaConnectionError';
    this.cause = cause;
  }
}

/** Request or poll timeout exceeded. */
export class NikaTimeoutError extends NikaError {
  constructor(message: string) {
    super(message);
    this.name = 'NikaTimeoutError';
  }
}

/** Job terminated with status 'failed' or 'interrupted'. */
export class NikaJobError extends NikaError {
  public readonly job: NikaJob;
  public readonly exitCode: number | undefined;

  constructor(job: NikaJob) {
    const diagnosis = job.error
      ? `${job.error.code} · ${job.error.message}`
      : job.status;
    super(`Job ${job.id} ${diagnosis}`);
    this.name = 'NikaJobError';
    this.job = job;
    this.exitCode = undefined;
  }
}

/**
 * Kept for the exported hierarchy. Live HTTP has no cancel route and no
 * `cancelled` status — poll never throws this.
 */
export class NikaJobCancelledError extends NikaJobError {
  constructor(job: NikaJob) {
    super(job);
    this.name = 'NikaJobCancelledError';
  }
}

/** A helper that would hit a route the live server keeps 404. */
export class NikaUnavailableError extends NikaError {
  public readonly surface: string;

  constructor(surface: string) {
    super(
      `${surface} is not on the live nika serve HTTP surface. `
      + 'Cancel and artifacts stay 404 until those authorities exist.',
    );
    this.name = 'NikaUnavailableError';
    this.surface = surface;
  }
}
