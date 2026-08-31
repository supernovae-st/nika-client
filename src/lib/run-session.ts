import { NikaEventBufferOverflowError } from '../errors.js';
import type {
  NikaCancelResult,
  NikaEvent,
  NikaEventsOptions,
  NikaRun,
  NikaRunResult,
  NikaRunStatus,
} from '../types.js';
import type { TransportRun } from './transport.js';

/** Owns the eager transport pump and every bounded observer view. */
export class RunSession {
  readonly run: NikaRun;

  private readonly history: NikaEvent[] = [];
  private readonly subscribers = new Set<EventSubscription>();
  private readonly done: Promise<NikaRunResult>;
  private resolveDone!: (result: NikaRunResult) => void;
  private rejectDone!: (error: Error) => void;
  private terminal = false;
  private cancelPromise?: Promise<NikaCancelResult>;
  private historyOverflowed = false;

  constructor(
    private readonly source: TransportRun,
    private readonly eventBufferSize: number,
  ) {
    this.done = new Promise<NikaRunResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A caller is allowed to observe only events; a transport failure must not
    // become a process-level unhandled rejection.
    this.done.catch(() => {});
    this.run = Object.freeze({ id: source.id, done: this.done });
    void this.observeSettlement();
    void this.pump();
  }

  events(options: NikaEventsOptions = {}): AsyncIterable<NikaEvent> {
    const requested = options.bufferSize ?? this.eventBufferSize;
    if (!Number.isInteger(requested) || requested < 1 || requested > this.eventBufferSize) {
      throw new RangeError(
        `events bufferSize must be an integer from 1 to ${this.eventBufferSize}`,
      );
    }
    if (this.historyOverflowed || this.history.length > requested) {
      throw new NikaEventBufferOverflowError(this.source.id, requested);
    }
    const subscription = new EventSubscription(
      this.source.id,
      requested,
      this.history.slice(-requested),
      options.signal,
      () => this.subscribers.delete(subscription),
    );
    if (this.terminal || options.signal?.aborted) subscription.close();
    else this.subscribers.add(subscription);
    return subscription;
  }

  cancel(): Promise<NikaCancelResult> {
    this.cancelPromise ??= this.cancelAndSettle();
    return this.cancelPromise;
  }

  status(): Promise<NikaRunStatus> {
    return this.source.status();
  }

  private async cancelAndSettle(): Promise<NikaCancelResult> {
    const cancellation = await this.source.cancel();
    const result = await this.source.done;
    if (!this.terminal) {
      this.terminal = true;
      this.resolveDone(result);
      for (const subscriber of [...this.subscribers]) subscriber.close();
      this.subscribers.clear();
      await this.source.cleanup().catch(() => {});
    }
    return cancellation;
  }

  private async observeSettlement(): Promise<void> {
    try {
      this.resolveDone(await this.source.done);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.rejectDone(error);
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source.events) {
        this.history.push(event);
        if (this.history.length > this.eventBufferSize) {
          this.history.shift();
          this.historyOverflowed = true;
        }
        for (const subscriber of [...this.subscribers]) subscriber.push(event);
      }
      this.resolveDone(await this.source.done);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.rejectDone(error);
      for (const subscriber of [...this.subscribers]) subscriber.fail(error);
    } finally {
      this.terminal = true;
      for (const subscriber of [...this.subscribers]) subscriber.close();
      this.subscribers.clear();
      await this.source.cleanup().catch(() => {});
    }
  }
}

class EventSubscription implements AsyncIterableIterator<NikaEvent> {
  private readonly queue: NikaEvent[];
  private waiter?: {
    resolve: (result: IteratorResult<NikaEvent>) => void;
    reject: (error: Error) => void;
  };
  private closed = false;
  private error?: Error;
  private readonly abort: () => void;
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly runId: string,
    private readonly limit: number,
    initial: NikaEvent[],
    signal: AbortSignal | undefined,
    private readonly detach: () => void,
  ) {
    this.queue = [...initial];
    this.signal = signal;
    this.abort = () => this.close();
    if (signal?.aborted) this.closed = true;
    else signal?.addEventListener('abort', this.abort, { once: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<NikaEvent> {
    return this;
  }

  next(): Promise<IteratorResult<NikaEvent>> {
    const event = this.queue.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    if (this.waiter) {
      return Promise.reject(new Error('Concurrent next() calls are not supported'));
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<NikaEvent>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  push(event: NikaEvent): void {
    if (this.closed || this.error) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.queue.length >= this.limit) {
      this.fail(new NikaEventBufferOverflowError(this.runId, this.limit));
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.detach();
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.closed || this.error) return;
    this.error = error;
    this.queue.length = 0;
    this.signal?.removeEventListener('abort', this.abort);
    this.detach();
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    }
  }
}
