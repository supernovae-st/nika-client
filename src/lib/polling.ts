import type { NikaJob, PollOptions } from '../types.js';
import { NikaTimeoutError, NikaJobError, NikaConnectionError } from '../errors.js';

const TERMINAL_FAIL = new Set(['failed', 'interrupted']);

export async function pollUntilDone(
  fetchStatus: () => Promise<NikaJob>,
  opts: PollOptions,
): Promise<NikaJob> {
  const deadline = Date.now() + opts.timeout;
  let delay = opts.interval;

  while (true) {
    if (opts.signal?.aborted) {
      throw new NikaConnectionError('Poll aborted by caller');
    }

    const job = await fetchStatus();

    if (job.status === 'succeeded') return job;
    if (TERMINAL_FAIL.has(job.status)) throw new NikaJobError(job);

    if (Date.now() + delay > deadline) {
      throw new NikaTimeoutError(`Job ${job.id} timed out after ${opts.timeout}ms`);
    }

    await sleep(delay, opts.signal);
    delay = Math.min(delay * opts.backoff, 10_000);
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
