import { NikaEventBufferOverflowError } from '../errors.js';
import type {
  NikaCancelResult,
  NikaEvent,
  NikaEventsOptions,
  NikaRun,
  NikaRunEvent,
  NikaRunResult,
  NikaRunStatus,
  NikaTransportKind,
} from '../types.js';
import { semanticRunEvent } from './run-events.js';
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
  /** Every frame the pump delivered; `history` holds at most the last `eventBufferSize`. */
  private observed = 0;

  constructor(
    private readonly source: TransportRun,
    private readonly eventBufferSize: number,
    private readonly transport: NikaTransportKind,
  ) {
    this.done = new Promise<NikaRunResult>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A caller is allowed to observe only events; a transport failure must not
    // become a process-level unhandled rejection.
    this.done.catch(() => {});
    // The handle is this session's own lifecycle, as closures: a method a
    // caller extracts keeps working, and nothing here can reach another run.
    this.run = Object.freeze({
      id: source.id,
      events: (options?: NikaEventsOptions) => this.semanticEvents(options),
      result: () => this.done,
      status: () => this.status(),
      cancel: () => this.cancel(),
      done: this.done,
    });
    void this.observeSettlement();
    void this.pump();
  }

  /**
   * The lifecycle vocabulary over the same bounded view: one history, one
   * queue, and a pure per-frame projection at the edge. No second event bus.
   */
  semanticEvents(options: NikaEventsOptions = {}): AsyncIterableIterator<NikaRunEvent> {
    const view = this.events(options);
    const transport = this.transport;
    const lifecycle: AsyncIterableIterator<NikaRunEvent> = {
      [Symbol.asyncIterator]: () => lifecycle,
      next: async () => {
        const step = await view.next();
        if (step.done) return { value: undefined, done: true };
        return { value: semanticRunEvent(step.value, transport), done: false };
      },
      return: async () => {
        await view.return?.();
        return { value: undefined, done: true };
      },
    };
    return lifecycle;
  }

  /** The protocol frames, exactly as the transport delivered them. */
  events(options: NikaEventsOptions = {}): AsyncIterableIterator<NikaEvent> {
    const requested = options.bufferSize ?? this.eventBufferSize;
    if (!Number.isInteger(requested) || requested < 1 || requested > this.eventBufferSize) {
      throw new RangeError(
        `events bufferSize must be an integer from 1 to ${this.eventBufferSize}`,
      );
    }
    // A view opened late is seeded with everything it missed, or it is
    // refused: never a silently shortened replay. This is not backpressure
    // (no subscriber was slow), so the refusal names the history instead:
    // what was observed and what is still retained.
    if (this.observed > requested) {
      throw new NikaEventBufferOverflowError(this.source.id, requested, {
        observed: this.observed,
        retained: this.history.length,
      });
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
    this.cancelPromise ??= this.requestCancel().catch((error) => {
      // A refused or lost action response is retryable. Only an accepted
      // request is memoized; observation and its actual result stay alive.
      this.cancelPromise = undefined;
      throw error;
    });
    return this.cancelPromise;
  }

  status(): Promise<NikaRunStatus> {
    return this.source.status();
  }

  private async requestCancel(): Promise<NikaCancelResult> {
    const cancellation = await this.source.cancel();
    // An accepted signal is not an execution result. Observation continues
    // independently; callers await run.result() for the engine's actual verdict.
    if (cancellation.status === 'cancellation_requested') return cancellation;
    const result = await this.source.done;
    // An active observer owns the terminal event boundary. Let the transport
    // pump deliver that persisted frame before it closes the subscription.
    // With no observer, cancellation can still clean up immediately.
    if (!this.terminal && this.subscribers.size === 0) {
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
        this.observed += 1;
        this.history.push(event);
        // The retained history is bounded, never the run: past the capacity
        // the oldest frame goes, and a late view is refused rather than
        // handed a replay with a hole in it.
        if (this.history.length > this.eventBufferSize) this.history.shift();
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
