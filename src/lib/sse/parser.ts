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

/** A bounded byte-oriented SSE parser. It never buffers more than one line. */
export class SseParser {
  private pending = new Uint8Array(0);
  private pendingBytes = 0;
  private frameBytes = 0;
  private dataLines: string[] = [];
  private id: string | undefined;
  private retry: number | undefined;
  private firstLine = true;

  constructor(private readonly limits: SseLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  push(chunk: Uint8Array): SseFrame[] {
    const frames: SseFrame[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        this.append(chunk.subarray(offset));
        break;
      }
      this.append(chunk.subarray(offset, newline));
      const frame = this.processPendingLine();
      if (frame) frames.push(frame);
      offset = newline + 1;
    }
    return frames;
  }

  finish(): SseFrame[] {
    if (this.pendingBytes > 0) this.processPendingLine(false);
    if (this.dataLines.length > 0) {
      throw new SseParseError('SSE stream ended with an incomplete data frame');
    }
    // Comments and id/retry-only control fields have no Nika event to lose at
    // EOF. They are deliberately discarded instead of advancing a cursor.
    this.resetFrame();
    return [];
  }

  private append(bytes: Uint8Array): void {
    const length = this.pendingBytes + bytes.length;
    if (length > this.limits.maxBufferBytes) {
      throw new SseParseError(`SSE buffer exceeded ${this.limits.maxBufferBytes} bytes`);
    }
    if (length > this.limits.maxLineBytes) {
      throw new SseParseError(`SSE line exceeded ${this.limits.maxLineBytes} bytes`);
    }
    if (bytes.length === 0) return;
    this.ensurePendingCapacity(length);
    this.pending.set(bytes, this.pendingBytes);
    this.pendingBytes = length;
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
      throw new SseParseError(`SSE frame exceeded ${this.limits.maxFrameBytes} bytes`);
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
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const parser = new SseParser(limits);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(value)) yield frame;
    }
    for (const frame of parser.finish()) yield frame;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
