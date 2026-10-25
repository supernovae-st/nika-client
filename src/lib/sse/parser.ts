import { OVERFLOW_MEASURE_LIMIT_BYTES, type MeasuredSize } from '../machine-buffer.js';

export interface SseLimits {
  maxLineBytes: number;
  maxFrameBytes: number;
  maxBufferBytes: number;
}

export interface SseFrame {
  data?: string;
  id?: string;
  retry?: number;
}

export class SseParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SseParseError';
  }
}

/**
 * A frame past one of the parser's bounds. `size` is the whole frame as the
 * parser counts it (every line and its line feed, the blank line included), so
 * a frame fits exactly when every bound is at least `size.bytes`. It is exact
 * when the parser read to the frame's blank line, a lower bound when the
 * stream ended first or counting reached its limit.
 */
export class SseFrameOverflowError extends SseParseError {
  readonly bound: 'line' | 'frame' | 'buffer';
  readonly limit: number;
  readonly size: MeasuredSize;

  constructor(bound: 'line' | 'frame' | 'buffer', limit: number, size: MeasuredSize) {
    super(`SSE ${bound} exceeded ${limit} bytes: the frame is `
      + `${size.exact ? '' : 'at least '}${size.bytes} bytes`);
    this.name = 'SseFrameOverflowError';
    this.bound = bound;
    this.limit = limit;
    this.size = size;
  }
}

/** The oversized frame being counted, never stored. */
interface Overflow {
  readonly bound: 'line' | 'frame' | 'buffer';
  readonly limit: number;
  /** Raw bytes of the frame so far, line feeds included. */
  bytes: number;
  /** Raw bytes of the current, unterminated line. */
  lineBytes: number;
  /** The last byte of the current line, to tell a blank `\r` line from content. */
  lastByte: number;
}

/**
 * A bounded byte-oriented SSE parser. It never buffers more than one line.
 *
 * A frame past a bound is refused, and first measured: the parser keeps
 * reading it, counting and discarding its bytes, to its blank line, so the
 * refusal says how large the frame is. Frames that completed before it are
 * still returned; the refusal is raised by `throwIfFailed()`, the next
 * `push()` or `finish()`.
 */
export class SseParser {
  private pending = new Uint8Array(0);
  private pendingBytes = 0;
  private frameBytes = 0;
  private dataLines: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;
  private firstLine = true;
  private overflow: Overflow | undefined;
  private failure: SseParseError | undefined;

  constructor(private readonly limits: SseLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  push(chunk: Uint8Array): SseFrame[] {
    this.throwIfFailed();
    const frames: SseFrame[] = [];
    let offset = 0;
    while (offset < chunk.length && !this.failure) {
      if (this.overflow) {
        this.measure(chunk.subarray(offset));
        break;
      }
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.append(chunk.subarray(offset, end))) {
        // The line outgrew its bound: from its line feed on, the frame is counted.
        offset = end;
        continue;
      }
      if (newline < 0) break;
      const frame = this.processPendingLine();
      if (frame) frames.push(frame);
      offset = newline + 1;
    }
    return frames;
  }

  /** Raise a refusal a completed measurement left, before any later frame. */
  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  finish(): SseFrame[] {
    this.throwIfFailed();
    if (this.overflow) {
      // The stream ended inside the oversized frame: its size is a lower bound.
      const { bound, limit, bytes } = this.overflow;
      throw new SseFrameOverflowError(bound, limit, { bytes, exact: false });
    }
    if (this.pendingBytes > 0) this.processPendingLine(false);
    this.throwIfFailed();
    if (this.dataLines.length > 0) {
      throw new SseParseError('SSE stream ended with an incomplete data frame');
    }
    // Comments and id/retry-only control fields have no Nika event to lose at
    // EOF. They are deliberately discarded instead of advancing a cursor.
    this.resetFrame();
    return [];
  }

  /** Buffer a line segment, or start counting the frame when it would outgrow a bound. */
  private append(bytes: Uint8Array): boolean {
    const length = this.pendingBytes + bytes.length;
    const bound = length > this.limits.maxBufferBytes
      ? 'buffer'
      : length > this.limits.maxLineBytes ? 'line' : undefined;
    if (bound) {
      this.startOverflow(bound, bound === 'buffer' ? this.limits.maxBufferBytes : this.limits.maxLineBytes, {
        bytes: this.frameBytes + length,
        lineBytes: length,
        lastByte: bytes.length > 0 ? bytes[bytes.length - 1]! : this.pending[this.pendingBytes - 1] ?? -1,
      });
      return false;
    }
    if (bytes.length === 0) return true;
    this.ensurePendingCapacity(length);
    this.pending.set(bytes, this.pendingBytes);
    this.pendingBytes = length;
    return true;
  }

  private ensurePendingCapacity(length: number): void {
    if (this.pending.byteLength >= length) return;
    const ceiling = Math.min(this.limits.maxBufferBytes, this.limits.maxLineBytes);
    const capacity = Math.min(
      ceiling,
      Math.max(length, Math.max(1, this.pending.byteLength) * 2),
    );
    const pending = new Uint8Array(capacity);
    pending.set(this.pending.subarray(0, this.pendingBytes));
    this.pending = pending;
  }

  private processPendingLine(terminated = true): SseFrame | undefined {
    const rawLength = this.pendingBytes + (terminated ? 1 : 0);
    if (this.frameBytes + rawLength > this.limits.maxFrameBytes) {
      const blank = this.pendingBytes === 0
        || (this.pendingBytes === 1 && this.pending[0] === 0x0d);
      const bytes = this.frameBytes + rawLength;
      if (blank || !terminated) {
        // This line ends the frame (or the stream): nothing is left to count.
        this.failure = new SseFrameOverflowError('frame', this.limits.maxFrameBytes, {
          bytes,
          exact: terminated,
        });
        this.discardFrame();
        return undefined;
      }
      this.startOverflow('frame', this.limits.maxFrameBytes, { bytes, lineBytes: 0, lastByte: -1 });
      return undefined;
    }
    this.frameBytes += rawLength;
    let bytes = this.pending.subarray(0, this.pendingBytes);
    this.pendingBytes = 0;
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);

    let line: string;
    try {
      line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (cause) {
      throw new SseParseError('SSE line was not valid UTF-8', {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    if (this.firstLine) {
      this.firstLine = false;
      if (line.startsWith('\uFEFF')) line = line.slice(1);
    }
    if (line.length === 0) return this.dispatch();
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed)) this.retry = parsed;
        }
        break;
      default:
        break;
    }
    return undefined;
  }

  private startOverflow(
    bound: Overflow['bound'],
    limit: number,
    counted: Pick<Overflow, 'bytes' | 'lineBytes' | 'lastByte'>,
  ): void {
    this.discardFrame();
    this.overflow = { bound, limit, ...counted };
    if (counted.bytes > OVERFLOW_MEASURE_LIMIT_BYTES) this.stopMeasuring(false);
  }

  /** Count the oversized frame's bytes up to its blank line; store none of them. */
  private measure(chunk: Uint8Array): void {
    const overflow = this.overflow!;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = end - offset;
      if (segment > 0) {
        overflow.bytes += segment;
        overflow.lineBytes += segment;
        overflow.lastByte = chunk[end - 1]!;
      }
      if (overflow.bytes > OVERFLOW_MEASURE_LIMIT_BYTES) {
        this.stopMeasuring(false);
        return;
      }
      if (newline < 0) return;
      overflow.bytes += 1;
      const blank = overflow.lineBytes === 0
        || (overflow.lineBytes === 1 && overflow.lastByte === 0x0d);
      if (blank) {
        this.stopMeasuring(true);
        return;
      }
      overflow.lineBytes = 0;
      overflow.lastByte = -1;
      offset = newline + 1;
    }
  }

  private stopMeasuring(exact: boolean): void {
    const { bound, limit, bytes } = this.overflow!;
    this.overflow = undefined;
    this.failure = new SseFrameOverflowError(bound, limit, { bytes, exact });
  }

  /** Drop what the frame holds: its pending line and fields. */
  private discardFrame(): void {
    this.pending = new Uint8Array(0);
    this.pendingBytes = 0;
    this.resetFrame();
  }

  private dispatch(): SseFrame | undefined {
    const data = this.dataLines.join('\n');
    const frame: SseFrame = {
      ...(data.length > 0 ? { data } : {}),
      ...(this.id !== undefined ? { id: this.id } : {}),
      ...(this.retry !== undefined ? { retry: this.retry } : {}),
    };
    this.resetFrame();
    return Object.keys(frame).length > 0 ? frame : undefined;
  }

  private resetFrame(): void {
    this.frameBytes = 0;
    this.dataLines = [];
    this.id = undefined;
    this.retry = undefined;
  }
}

export async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
  limits: SseLimits,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const parser = new SseParser(limits);
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(value)) yield frame;
      // A frame refused inside this chunk is raised now, after the frames before it.
      parser.throwIfFailed();
    }
    for (const frame of parser.finish()) yield frame;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
