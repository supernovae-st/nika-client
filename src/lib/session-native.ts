import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  NikaConfigurationError,
  NikaProtocolError,
  NikaSessionWaitError,
  NikaTransportError,
} from '../errors.js';
import type {
  NikaSessionClosed,
  NikaSessionDetails,
  NikaSessionEvent,
  NikaSessionOpened,
  NikaSessionResult,
  NikaSessionSnapshot,
} from '../types.js';
import {
  SESSION_FRAME_MAX_BYTES,
  SESSION_HOST_CONTRACT,
  sessionFrame,
  sessionRefusal,
  type SessionChannel,
  type SessionCommand,
} from './session-host.js';

/**
 * The native door of the authoring Session: one `nika session --json`
 * process in the project's directory, one Session. Commands and reads go to
 * its stdin as NDJSON; its stdout carries NDJSON frames. A frame with an
 * `event` number is an event (a command's first result arrives as one); a
 * frame without one is a direct reply: `refused` and a replayed `result`
 * name their command, `snapshot` and `details` answer the reads in the order
 * they were sent. The engine reads stdin on its own thread, so a read or a
 * Stop never waits for the turn under way.
 */

const transport = 'native-process' as const;
const STDERR_BYTES = 64 * 1024;
const CLOSE_GRACE_MS = 5_000;

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

interface Read {
  readonly kind: 'snapshot' | 'details';
  /** A read whose caller stopped waiting keeps its place, so later replies stay aligned. */
  abandoned: boolean;
  resolve(frame: Record<string, unknown>): void;
  reject(error: Error): void;
}

interface Waiter {
  readonly op: string;
  readonly line?: string;
  resolve(frame: NikaSessionResult | NikaSessionClosed): void;
  reject(error: Error): void;
}

interface Subscriber {
  push(event: NikaSessionEvent): void;
  end(error?: Error): void;
}

export interface NativeSessionOptions {
  bin: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Events the handle retains for a view opened after them (the client's `eventBufferSize`). */
  retention: number;
}

export async function openNativeSession(options: NativeSessionOptions): Promise<SessionChannel> {
  options.signal?.throwIfAborted();
  const child = spawn(options.bin, ['session', '--json'], {
    cwd: options.cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const channel = new NativeSessionChannel(child, options.retention);
  try {
    await channel.open(options.signal);
  } catch (error) {
    await channel.terminate();
    throw error;
  }
  return channel;
}

class NativeSessionChannel implements SessionChannel {
  readonly transport = transport;
  session = '';
  opened!: NikaSessionOpened;

  readonly #child: Child;
  readonly #retention: number;
  readonly #reads: Read[] = [];
  readonly #waiters = new Map<string, Waiter[]>();
  readonly #events: NikaSessionEvent[] = [];
  readonly #subscribers = new Set<Subscriber>();
  readonly #exited: Promise<number | null>;
  #pending = Buffer.alloc(0);
  #stderr = '';
  #ended: Error | 'closed' | undefined;
  #opening?: { resolve(frame: NikaSessionOpened): void; reject(error: Error): void };

  constructor(child: Child, retention: number) {
    this.#child = child;
    this.#retention = retention;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => this.#data(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.#stderr.length < STDERR_BYTES) this.#stderr += chunk.toString('utf8').slice(0, STDERR_BYTES);
    });
    this.#exited = new Promise((resolve) => {
      child.once('error', (cause) => {
        this.#fail(new NikaTransportError(transport, `Cannot spawn the Session engine: ${cause.message}`, { cause }));
        resolve(null);
      });
      child.once('close', (code) => {
        this.#fail(this.#ended === 'closed' ? 'closed' : new NikaTransportError(transport,
          `The Session engine exited (${code ?? 'signal'}) before the Session closed`
          + (this.#stderr.trim() ? `: ${excerpt(this.#stderr)}` : '')));
        resolve(code);
      });
    });
  }

  /** Wait for the `opened` event (or the host's refusal). */
  open(signal?: AbortSignal): Promise<NikaSessionOpened> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new NikaTransportError(transport, 'openSession aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      this.#opening = {
        resolve: (frame) => { signal?.removeEventListener('abort', abort); resolve(frame); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); },
      };
    });
  }

  snapshot(signal?: AbortSignal): Promise<NikaSessionSnapshot> {
    return this.#read('snapshot', signal).then((frame) => frame.snapshot as NikaSessionSnapshot);
  }

  details(signal?: AbortSignal): Promise<NikaSessionDetails> {
    return this.#read('details', signal) as Promise<NikaSessionDetails>;
  }

  send(command: SessionCommand, signal?: AbortSignal): Promise<NikaSessionResult | NikaSessionClosed> {
    return new Promise((resolve, reject) => {
      if (this.#ended !== undefined) {
        reject(this.#ended === 'closed'
          ? new NikaConfigurationError('session: this Session is closed')
          : this.#ended);
        return;
      }
      if (signal?.aborted) {
        reject(new NikaSessionWaitError(transport, command.command, 'session: the wait was aborted before sending'));
        return;
      }
      const waiters = this.#waiters.get(command.command) ?? [];
      const abort = () => {
        const kept = (this.#waiters.get(command.command) ?? []).filter((entry) => entry !== waiter);
        if (kept.length === 0) this.#waiters.delete(command.command);
        else this.#waiters.set(command.command, kept);
        reject(new NikaSessionWaitError(transport, command.command,
          `session: stopped waiting for command ${command.command}; the engine keeps the turn, stop() stops it`));
      };
      const waiter: Waiter = {
        op: command.op,
        ...(command.line === undefined ? {} : { line: command.line }),
        resolve: (frame) => { signal?.removeEventListener('abort', abort); resolve(frame); },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error); },
      };
      waiters.push(waiter);
      this.#waiters.set(command.command, waiters);
      signal?.addEventListener('abort', abort, { once: true });
      this.#write(command.body);
    });
  }

  events(after: string | undefined, signal?: AbortSignal): AsyncIterable<NikaSessionEvent> {
    const from = this.#cursor(after);
    const retention = this.#retention;
    const channel = this;
    return {
      [Symbol.asyncIterator]: () => {
        const queue: NikaSessionEvent[] = channel.#events.filter((event) => (event.event ?? 0) > from);
        let ended: { error?: Error } | undefined;
        let wake: (() => void) | undefined;
        const subscriber: Subscriber = {
          push: (event) => {
            if (queue.length >= retention) {
              subscriber.end(new NikaTransportError(transport,
                `session: this event view fell ${retention} events behind; open another with events({ after })`));
              return;
            }
            queue.push(event);
            wake?.();
          },
          end: (error) => {
            ended ??= error === undefined ? {} : { error };
            channel.#subscribers.delete(subscriber);
            wake?.();
          },
        };
        if (channel.#ended === undefined) channel.#subscribers.add(subscriber);
        else subscriber.end(channel.#ended === 'closed' ? undefined : channel.#ended);
        const abort = () => subscriber.end();
        signal?.addEventListener('abort', abort, { once: true });
        return {
          next: async (): Promise<IteratorResult<NikaSessionEvent>> => {
            while (queue.length === 0 && ended === undefined) {
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = undefined;
            }
            const event = queue.shift();
            if (event !== undefined) return { value: event, done: false };
            signal?.removeEventListener('abort', abort);
            if (ended?.error) throw ended.error;
            return { value: undefined, done: true };
          },
          return: async (): Promise<IteratorResult<NikaSessionEvent>> => {
            subscriber.end();
            signal?.removeEventListener('abort', abort);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  /** End the process: EOF first (the engine closes), then signals if it lingers. */
  async terminate(): Promise<void> {
    this.#child.stdin.end();
    if (await within(this.#exited, CLOSE_GRACE_MS)) return;
    this.#child.kill('SIGTERM');
    if (await within(this.#exited, CLOSE_GRACE_MS)) return;
    this.#child.kill('SIGKILL');
    await this.#exited;
  }

  #read(kind: 'snapshot' | 'details', signal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.#ended !== undefined) {
        reject(this.#ended === 'closed' ? new NikaConfigurationError('session: this Session is closed') : this.#ended);
        return;
      }
      signal?.throwIfAborted();
      const abort = () => {
        read.abandoned = true;
        reject(new NikaTransportError(transport, `session: the ${kind} read was aborted`));
      };
      const read: Read = {
        kind,
        abandoned: false,
        resolve: (frame) => { signal?.removeEventListener('abort', abort); if (!read.abandoned) resolve(frame); },
        reject: (error) => { signal?.removeEventListener('abort', abort); if (!read.abandoned) reject(error); },
      };
      this.#reads.push(read);
      signal?.addEventListener('abort', abort, { once: true });
      this.#write(JSON.stringify({ contract: SESSION_HOST_CONTRACT, op: kind }));
    });
  }

  #write(line: string): void {
    this.#child.stdin.write(`${line}\n`);
  }

  #cursor(after: string | undefined): number {
    if (after === undefined) return (this.#events.at(-1)?.event ?? 0);
    const [session, number] = typeof after === 'string' ? after.split(':') : [];
    const event = Number(number);
    if (session !== this.session || !Number.isSafeInteger(event) || event < 0) {
      throw new NikaConfigurationError('session: events({ after }) takes a cursor this Session issued');
    }
    const oldest = this.#events[0]?.event ?? 1;
    if (event < oldest - 1) {
      throw new NikaConfigurationError(
        `session: the events after ${after} are no longer retained; read snapshot() and observe from now`);
    }
    return event;
  }

  #data(chunk: Buffer): void {
    let buffer = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    let newline: number;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > 0) this.#line(line);
      if (this.#ended instanceof Error) return;
    }
    if (buffer.length > SESSION_FRAME_MAX_BYTES) {
      this.#protocol(`a Session frame exceeded ${SESSION_FRAME_MAX_BYTES} bytes`);
      return;
    }
    this.#pending = Buffer.from(buffer);
  }

  #line(bytes: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      // No cause: a JSON parse error quotes the line it read.
      this.#protocol('a Session line was not one UTF-8 JSON frame');
      return;
    }
    let frame: Record<string, unknown> & { frame: string };
    try {
      frame = sessionFrame(value, transport);
    } catch (error) {
      // A frame of another contract generation stays the compatibility gap it is.
      this.#fail(error as Error);
      this.#child.kill('SIGTERM');
      return;
    }
    if (this.#opening) {
      const opening = this.#opening;
      this.#opening = undefined;
      if (frame.frame === 'opened' && typeof frame.event === 'number') {
        this.session = frame.session as string;
        this.opened = frame as unknown as NikaSessionOpened;
        this.#event(frame);
        opening.resolve(this.opened);
      } else if (frame.frame === 'refused') {
        opening.reject(sessionRefusal(frame, transport, 0));
      } else {
        this.#protocol('the Session did not open with its opened event');
        opening.reject(this.#ended as Error);
      }
      return;
    }
    if (frame.session !== undefined && frame.session !== this.session) {
      this.#protocol('a frame named another Session');
      return;
    }
    if (typeof frame.event === 'number') {
      this.#event(frame);
      if (frame.frame === 'result') this.#settle(frame.command as string, frame as unknown as NikaSessionResult);
      if (frame.frame === 'closed') this.#closed(frame as unknown as NikaSessionClosed);
      return;
    }
    switch (frame.frame) {
      case 'result':
        this.#settle(frame.command as string, frame as unknown as NikaSessionResult);
        return;
      case 'refused': {
        const command = frame.command;
        if (typeof command === 'string') {
          // A command's refusal; its caller may have stopped waiting already.
          const waiters = this.#waiters.get(command) ?? [];
          this.#waiters.delete(command);
          for (const waiter of waiters) waiter.reject(sessionRefusal(frame, transport, 0, waiter.line));
          return;
        }
        const read = this.#reads.shift();
        if (read) read.reject(sessionRefusal(frame, transport, 0));
        else this.#protocol('the host refused something this handle never sent');
        return;
      }
      case 'snapshot':
      case 'details': {
        const read = this.#reads.shift();
        if (!read || read.kind !== frame.frame) {
          this.#protocol(`a ${frame.frame} reply answered no ${frame.frame} read`);
          return;
        }
        read.resolve(frame);
        return;
      }
      default:
        // A direct reply this contract version does not name: carried nowhere, acted upon never.
        return;
    }
  }

  #event(frame: Record<string, unknown>): void {
    const event = { ...frame, cursor: `${this.session}:${frame.event as number}` } as NikaSessionEvent;
    this.#events.push(event);
    if (this.#events.length > this.#retention) this.#events.shift();
    for (const subscriber of this.#subscribers) subscriber.push(event);
  }

  #settle(command: string, frame: NikaSessionResult | NikaSessionClosed): void {
    const waiters = this.#waiters.get(command);
    if (!waiters) return;
    this.#waiters.delete(command);
    for (const waiter of waiters) waiter.resolve(frame);
  }

  #closed(frame: NikaSessionClosed): void {
    if (typeof frame.command === 'string') this.#settle(frame.command, frame);
    for (const [command, waiters] of this.#waiters) {
      const closing = waiters.filter((waiter) => waiter.op === 'close');
      if (closing.length === 0) continue;
      for (const waiter of closing) waiter.resolve(frame);
      const others = waiters.filter((waiter) => waiter.op !== 'close');
      if (others.length === 0) this.#waiters.delete(command);
      else this.#waiters.set(command, others);
    }
    this.#ended = 'closed';
    this.#child.stdin.end();
    this.#fail('closed');
  }

  #protocol(message: string, cause?: unknown): void {
    this.#fail(new NikaProtocolError(transport, `session: ${message}`,
      cause instanceof Error ? { cause } : undefined));
    this.#child.kill('SIGTERM');
  }

  /** Settle everything still waiting: the Session closed, or its door broke. */
  #fail(ended: Error | 'closed'): void {
    if (this.#ended instanceof Error) return;
    this.#ended = ended;
    const error = ended === 'closed' ? undefined : ended;
    this.#opening?.reject(error ?? new NikaTransportError(transport, 'The Session closed before it opened'));
    this.#opening = undefined;
    for (const read of this.#reads.splice(0)) {
      read.reject(error ?? new NikaConfigurationError('session: this Session is closed'));
    }
    for (const [command, waiters] of this.#waiters) {
      for (const waiter of waiters) {
        waiter.reject(new NikaSessionWaitError(transport, command,
          `session: the native door ended before command ${command} settled`, error ? { cause: error } : undefined));
      }
    }
    this.#waiters.clear();
    for (const subscriber of this.#subscribers) subscriber.end(error);
  }
}

function within(settling: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    settling.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function excerpt(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= 240 ? flat : `${flat.slice(0, 240)}…`;
}
