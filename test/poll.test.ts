import { describe, it, expect, vi } from 'vitest';
import { pollUntilDone } from '../src/lib/polling.js';
import { NikaJobError, NikaTimeoutError } from '../src/errors.js';
import type { NikaJob } from '../src/types.js';

function makeJob(status: string, extra?: Partial<NikaJob>): NikaJob {
  return { id: 'test-job', status: status as NikaJob['status'], ...extra };
}

const fastOpts = { interval: 5, timeout: 2000, backoff: 1.0 };

describe('pollUntilDone', () => {
  it('returns immediately on succeeded', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(makeJob('succeeded'));
    const job = await pollUntilDone(fetchStatus, fastOpts);
    expect(job.status).toBe('succeeded');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('polls through queued -> succeeded', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(makeJob('queued'))
      .mockResolvedValueOnce(makeJob('running'))
      .mockResolvedValueOnce(makeJob('succeeded'));
    const job = await pollUntilDone(fetchStatus, fastOpts);
    expect(job.status).toBe('succeeded');
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it('keeps polling paused (human gate is not terminal)', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(makeJob('paused'))
      .mockResolvedValueOnce(makeJob('running'))
      .mockResolvedValueOnce(makeJob('succeeded'));
    const job = await pollUntilDone(fetchStatus, fastOpts);
    expect(job.status).toBe('succeeded');
  });

  it('throws NikaJobError on failed', async () => {
    const fetchStatus = vi.fn().mockResolvedValueOnce(makeJob('failed'));
    const err = await pollUntilDone(fetchStatus, fastOpts).catch(e => e);
    expect(err).toBeInstanceOf(NikaJobError);
  });

  it('throws NikaJobError on interrupted (not cancelled)', async () => {
    const fetchStatus = vi.fn().mockResolvedValueOnce(makeJob('interrupted'));
    const err = await pollUntilDone(fetchStatus, fastOpts).catch(e => e);
    expect(err).toBeInstanceOf(NikaJobError);
    expect(err.name).toBe('NikaJobError');
  });

  it('throws NikaTimeoutError when deadline exceeded', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(makeJob('queued'));
    const err = await pollUntilDone(fetchStatus, { interval: 10, timeout: 30, backoff: 1.0 }).catch(e => e);
    expect(err).toBeInstanceOf(NikaTimeoutError);
  });
});
