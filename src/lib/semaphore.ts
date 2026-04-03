/**
 * Simple counting semaphore for limiting in-flight HTTP requests.
 * Zero dependencies — uses native Promise.
 */
export class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // transfer permit directly (current stays same)
    } else {
      this.current--;
    }
  }
}
