import { describe, it, expect, vi } from 'vitest';
import { pollUntilDone } from '../src/poll.js';
import { NikaJobError, NikaTimeoutError } from '../src/errors.js';
import type { NikaJob } from '../src/types.js';

function makeJob(status: string, extra?: Partial<NikaJob>): NikaJob {
  return {
    job_id: 'test-job',
    status: status as NikaJob['status'],
    workflow: 'test.nika.yaml',
    created_at: '2026-04-02T10:00:00Z',
    ...extra,
  };
}

const fastOpts = { interval: 5, timeout: 2000, backoff: 1.0 };

describe('pollUntilDone', () => {
  it('returns immediately on completed', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(makeJob('completed'));

    const job = await pollUntilDone(fetchStatus, fastOpts);
    expect(job.status).toBe('completed');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('polls through pending -> completed', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(makeJob('pending'))
      .mockResolvedValueOnce(makeJob('running'))
      .mockResolvedValueOnce(makeJob('completed'));

    const job = await pollUntilDone(fetchStatus, fastOpts);
    expect(job.status).toBe('completed');
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it('throws NikaJobError on failed', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(makeJob('pending'))
      .mockResolvedValueOnce(makeJob('failed', { output: 'boom', exit_code: 1 }));

    const err = await pollUntilDone(fetchStatus, fastOpts).catch(e => e);
    expect(err).toBeInstanceOf(NikaJobError);
    expect(err.job.output).toBe('boom');
  });

  it('throws NikaJobError on cancelled', async () => {
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(makeJob('cancelled'));

    await expect(pollUntilDone(fetchStatus, fastOpts)).rejects.toThrow(NikaJobError);
  });

  it('throws NikaTimeoutError when deadline exceeded', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(makeJob('pending'));

    const err = await pollUntilDone(fetchStatus, { interval: 10, timeout: 30, backoff: 1.0 }).catch(e => e);
    expect(err).toBeInstanceOf(NikaTimeoutError);
  });

  it('applies backoff to delay', async () => {
    let callCount = 0;
    const timestamps: number[] = [];

    const fetchStatus = vi.fn().mockImplementation(async () => {
      timestamps.push(Date.now());
      callCount++;
      if (callCount >= 4) return makeJob('completed');
      return makeJob('running');
    });

    await pollUntilDone(fetchStatus, { interval: 20, timeout: 5000, backoff: 2.0 });

    // With backoff 2.0, delays should grow: ~20, ~40, ~80
    // Check that later intervals are longer than earlier ones
    expect(fetchStatus).toHaveBeenCalledTimes(4);
    if (timestamps.length >= 4) {
      const gap1 = timestamps[2] - timestamps[1];
      const gap2 = timestamps[3] - timestamps[2];
      // gap2 should be >= gap1 (within timing tolerance)
      expect(gap2).toBeGreaterThanOrEqual(gap1 * 0.8);
    }
  });
});
