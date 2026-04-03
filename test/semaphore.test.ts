import { describe, it, expect } from 'vitest';
import { Semaphore } from '../src/lib/semaphore.js';

describe('Semaphore', () => {
  it('allows up to max concurrent', async () => {
    const sem = new Semaphore(2);

    // Acquire 2 — should resolve immediately
    await sem.acquire();
    await sem.acquire();

    // 3rd acquire should block
    let thirdResolved = false;
    const p = sem.acquire().then(() => { thirdResolved = true; });

    // Give microtasks a chance to flush
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    // Release one — 3rd should now resolve
    sem.release();
    await p;
    expect(thirdResolved).toBe(true);
  });

  it('releases wake next in queue (FIFO)', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => { order.push(1); });
    const p2 = sem.acquire().then(() => { order.push(2); });

    sem.release();
    await p1;

    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  it('handles rapid acquire/release', async () => {
    const sem = new Semaphore(5);
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 100 }, async () => {
      await sem.acquire();
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      // Simulate async work
      await Promise.resolve();
      current--;
      sem.release();
    });

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(current).toBe(0);
  });
});
