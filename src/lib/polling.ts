import type { NikaJob, PollOptions } from '../types.js';
import { NikaTimeoutError, NikaJobError, NikaJobCancelledError, NikaConnectionError } from '../errors.js';

export async function pollUntilDone(
  fetchStatus: () => Promise<NikaJob>,
  opts: PollOptions,
): Promise<NikaJob> {
  const deadline = Date.now() + opts.timeout;
  let delay = opts.interval;

  while (true) {
    // Check caller abort
    if (opts.signal?.aborted) {
      throw new NikaConnectionError('Poll aborted by caller');
    }

    const job = await fetchStatus();

    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new NikaJobError(job);
    if (job.status === 'cancelled') throw new NikaJobCancelledError(job);

    // Check deadline BEFORE sleeping — prevents overshoot
    if (Date.now() + delay > deadline) {
      throw new NikaTimeoutError(`Job ${job.job_id} timed out after ${opts.timeout}ms`);
    }

    await sleep(delay, opts.signal);
    delay = Math.min(delay * opts.backoff, 10_000); // cap at 10s
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NikaConnectionError('Poll aborted by caller'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new NikaConnectionError('Poll aborted by caller'));
    }, { once: true });
  });
}
