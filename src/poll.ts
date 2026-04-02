import type { NikaJob } from './types.js';
import { NikaTimeoutError, NikaJobError } from './errors.js';

export interface PollOptions {
  interval: number;
  timeout: number;
  backoff: number;
}

export async function pollUntilDone(
  fetchStatus: () => Promise<NikaJob>,
  opts: PollOptions,
): Promise<NikaJob> {
  const start = Date.now();
  let delay = opts.interval;

  while (true) {
    const job = await fetchStatus();

    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new NikaJobError(job);
    if (job.status === 'cancelled') throw new NikaJobError(job);

    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * opts.backoff, 10_000); // cap at 10s

    if (Date.now() - start > opts.timeout) {
      throw new NikaTimeoutError(job.job_id, opts.timeout);
    }
  }
}
