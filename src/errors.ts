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

export class NikaJobError extends NikaError {
  public readonly job: NikaJob;

  constructor(job: NikaJob) {
    super(
      `Job ${job.job_id} ${job.status}: ${job.output ?? 'unknown error'}`,
      job.exit_code ?? 1,
    );
    this.name = 'NikaJobError';
    this.job = job;
  }
}

export class NikaTimeoutError extends NikaError {
  constructor(jobId: string, timeout: number) {
    super(`Job ${jobId} timed out after ${timeout}ms`, 408);
    this.name = 'NikaTimeoutError';
  }
}
