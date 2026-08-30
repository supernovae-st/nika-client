import { randomUUID } from 'node:crypto';
import {
  NikaCompatibilityError,
  NikaProtocolError,
  NikaTransportError,
} from '../errors.js';
import type {
  NikaCancelResult,
  NikaCheckOptions,
  NikaCheckResult,
  NikaEvent,
  NikaReceipt,
  NikaRunOptions,
  NikaRunResult,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
} from '../types.js';
import { eventError, eventOutputs, eventReceipt, machineObject } from './machine.js';
import type { Transport, TransportRun } from './transport.js';

export interface HttpTransportOptions {
  url: string;
  token: string;
  fetch: typeof globalThis.fetch;
  requestTimeout: number;
  machineBufferBytes: number;
}

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;

  constructor(private readonly options: HttpTransportOptions) {}

  async check(_workflow: string, _options: NikaCheckOptions): Promise<NikaCheckResult> {
    throw this.gap('check', 'nika serve does not expose a check route');
  }

  async startRun(workflow: string, options: NikaRunOptions): Promise<TransportRun> {
    if (
      (options.vars && Object.keys(options.vars).length > 0)
      || options.model !== undefined
      || options.maxCostUsd !== undefined
    ) {
      throw this.gap(
        'runOptions',
        'nika serve admission accepts { workflow } only; vars, model, and maxCostUsd are native options',
      );
    }
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    if (Buffer.byteLength(idempotencyKey) < 1 || Buffer.byteLength(idempotencyKey) > 255) {
      throw new NikaTransportError(this.kind, 'Idempotency-Key must be 1-255 bytes');
    }
    const admitted = await this.json('/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ workflow }),
    });
    const id = typeof admitted.id === 'string' ? admitted.id : undefined;
    if (!id) {
      throw new NikaProtocolError(this.kind, 'Job admission response omitted its id');
    }
    return this.httpRun(id);
  }

  async traceVerify(
    _receipt: NikaReceipt,
    _options: NikaTraceVerifyOptions,
  ): Promise<NikaTraceVerifyResult> {
    throw this.gap('traceVerify', 'nika serve does not expose trace verification');
  }

  private httpRun(id: string): TransportRun {
    const controller = new AbortController();
    let terminal = false;
    let resolveDone!: (result: NikaRunResult) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<NikaRunResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});

    const events: AsyncIterable<NikaEvent> = {
      [Symbol.asyncIterator]: async function* (this: HttpTransport) {
        try {
          let after = 0;
          while (!terminal) {
            const headers = new Headers({ Accept: 'text/event-stream' });
            if (after > 0) headers.set('Last-Event-ID', String(after));
            const response = await this.fetchResponse(
              `/v1/jobs/${encodeURIComponent(id)}/events`,
              { headers, signal: controller.signal },
              false,
            );
            if (!response.body) {
              throw new NikaProtocolError(this.kind, 'Event response has no body');
            }
            let advanced = false;
            for await (const event of decodeSse(
              response.body,
              this.options.machineBufferBytes,
              this.kind,
            )) {
              const sequence = event.sequence;
              if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
                throw new NikaProtocolError(this.kind, 'SSE event omitted a positive integer sequence');
              }
              if ((sequence as number) <= after) continue;
              after = sequence as number;
              advanced = true;
              yield event;
              if (isTerminal(event.status)) {
                terminal = true;
                const receipt = eventReceipt(event);
                const outputs = eventOutputs(event);
                const error = eventError(event);
                resolveDone({
                  id,
                  status: event.status!,
                  transport: this.kind,
                  ...(outputs ? { outputs } : {}),
                  ...(receipt ? { receipt } : {}),
                  ...(error ? { error } : {}),
                });
                return;
              }
            }
            if (!advanced) {
              throw new NikaProtocolError(
                this.kind,
                `Event stream for run ${id} closed without progress or terminal settlement`,
              );
            }
          }
        } catch (cause) {
          const error = cause instanceof Error
            ? cause
            : new NikaTransportError(this.kind, String(cause));
          if (!terminal) rejectDone(error);
          throw error;
        }
      }.bind(this),
    };

    return {
      id,
      events,
      done,
      cancel: async (): Promise<NikaCancelResult> => {
        throw this.gap('cancel', 'nika serve intentionally has no cancel route');
      },
      cleanup: async () => {
        if (!terminal) controller.abort();
      },
    };
  }

  private gap(capability: string, message: string): NikaCompatibilityError {
    return new NikaCompatibilityError(capability, this.kind, message);
  }

  private async json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetchResponse(path, init, true);
    let value: unknown;
    try {
      value = await response.json();
    } catch (cause) {
      throw new NikaProtocolError(this.kind, `HTTP ${path} did not return JSON`, {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    const object = machineObject(value);
    if (!object) throw new NikaProtocolError(this.kind, `HTTP ${path} did not return an object`);
    return object;
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
    withTimeout: boolean,
  ): Promise<Response> {
    const controller = withTimeout ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.options.requestTimeout)
      : undefined;
    const callerSignal = init.signal;
    const abort = () => controller?.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.options.token}`);
    try {
      const response = await this.options.fetch(`${this.options.url}${path}`, {
        ...init,
        headers,
        signal: controller?.signal ?? callerSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new NikaTransportError(
          this.kind,
          `HTTP ${response.status} for ${path}${body ? `: ${body}` : ''}`,
        );
      }
      return response;
    } catch (cause) {
      if (cause instanceof NikaTransportError) throw cause;
      if (controller?.signal.aborted && !callerSignal?.aborted) {
        throw new NikaTransportError(
          this.kind,
          `HTTP request timed out after ${this.options.requestTimeout}ms`,
          { cause: cause instanceof Error ? cause : undefined },
        );
      }
      throw new NikaTransportError(this.kind, 'HTTP transport failed', {
        cause: cause instanceof Error ? cause : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  }
}

function isTerminal(status: unknown): status is string {
  return status === 'succeeded' || status === 'failed' || status === 'interrupted';
}

async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  transport: 'http',
): AsyncGenerator<NikaEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch (cause) {
          throw new NikaProtocolError(transport, 'SSE data was not valid JSON', {
            cause: cause instanceof Error ? cause : undefined,
          });
        }
        const event = machineObject(value);
        if (!event) throw new NikaProtocolError(transport, 'SSE data was not an object');
        yield event as NikaEvent;
      }
      if (Buffer.byteLength(buffer) > limit) {
        throw new NikaProtocolError(transport, `SSE frame exceeded ${limit} bytes`);
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
