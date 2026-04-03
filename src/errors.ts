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

/** Job terminated with status 'failed'. */
export class NikaJobError extends NikaError {
  public readonly job: NikaJob;
  public readonly exitCode: number | undefined;

  constructor(job: NikaJob) {
    super(`Job ${job.job_id} ${job.status}: ${job.output ?? 'unknown error'}`);
    this.name = 'NikaJobError';
    this.job = job;
    this.exitCode = job.exit_code;
  }
}

/** Job was cancelled. Extends NikaJobError — catch NikaJobError to get both. */
export class NikaJobCancelledError extends NikaJobError {
  constructor(job: NikaJob) {
    super(job);
    this.name = 'NikaJobCancelledError';
  }
}
