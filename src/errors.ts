import type { NikaJob } from './types.js';

export class NikaError extends Error {
  public readonly status: number;
  public readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'NikaError';
    this.status = status;
    this.code = code;
  }
}

export class NikaJobError extends Error {
  public readonly job: NikaJob;
  public readonly exitCode: number | undefined;

  constructor(job: NikaJob) {
    super(`Job ${job.job_id} ${job.status}: ${job.output ?? 'unknown error'}`);
    this.name = 'NikaJobError';
    this.job = job;
    this.exitCode = job.exit_code;
  }
}

export class NikaTimeoutError extends NikaError {
  public readonly jobId: string;

  constructor(jobId: string, timeout: number) {
    super(`Job ${jobId} timed out after ${timeout}ms`, 408);
    this.name = 'NikaTimeoutError';
    this.jobId = jobId;
  }
}
