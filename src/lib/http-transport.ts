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
import { verifyNikaEngine, type ResolvedNikaEngine } from './binary/index.js';
import { captureEngine } from './engine-capture.js';
import {
  compatibleEngineIdentity,
  type NikaEngineIdentity,
} from './engine-identity.js';
import { eventError, eventOutputs, eventReceipt, machineObject } from './machine.js';
import type { Transport, TransportRun } from './transport.js';

export interface HttpTransportOptions {
  url: string;
  token: string;
  fetch: typeof globalThis.fetch;
  requestTimeout: number;
  machineBufferBytes: number;
  engine: ResolvedNikaEngine;
  cwd?: string;
}

interface CapturedSnapshot {
  report: NikaCheckResult;
  bytes: string;
}

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  private ready?: Promise<NikaEngineIdentity>;

  constructor(private readonly options: HttpTransportOptions) {}

  async check(workflow: string, options: NikaCheckOptions): Promise<NikaCheckResult> {
    if (options.model !== undefined || options.nativeStrict === true) {
      throw this.gap(
        'checkOptions',
        'Remote snapshot capture does not support model or nativeStrict overrides',
      );
    }
    const captured = await this.captureSnapshot(workflow, options.signal);
    const acknowledged = await this.json('/v1/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: captured.bytes,
      signal: options.signal,
    });
    if (
      acknowledged.status !== 'accepted'
      || typeof acknowledged.snapshot_digest !== 'string'
      || acknowledged.snapshot_digest.length === 0
      || typeof acknowledged.root !== 'string'
      || acknowledged.root.length === 0
      || !Number.isSafeInteger(acknowledged.units)
      || (acknowledged.units as number) < 1
    ) {
      throw new NikaProtocolError(this.kind, 'Check admission did not acknowledge the snapshot');
    }
    return captured.report;
  }

  async startRun(workflow: string, options: NikaRunOptions): Promise<TransportRun> {
    if (
      (options.vars && Object.keys(options.vars).length > 0)
      || options.model !== undefined
      || options.maxCostUsd !== undefined
    ) {
      throw this.gap(
        'runOptions',
        'nika serve snapshot admission has no request envelope for vars, model, or maxCostUsd',
      );
    }
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    if (Buffer.byteLength(idempotencyKey) < 1 || Buffer.byteLength(idempotencyKey) > 255) {
      throw new NikaTransportError(this.kind, 'Idempotency-Key must be 1-255 bytes');
    }
    const captured = await this.captureSnapshot(workflow);
    const admitted = await this.json('/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: captured.bytes,
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

  private ensureReady(): Promise<NikaEngineIdentity> {
    this.ready ??= this.verifyIdentities();
    return this.ready;
  }

  private async verifyIdentities(): Promise<NikaEngineIdentity> {
    // Verify local package integrity first: a modified capture engine must not
    // reach even the remote liveness probe.
    const local = await verifyNikaEngine(this.options.engine);
    const health = await this.json('/health', { method: 'GET' }, false);
    if (health.status !== 'ok' || health.service !== 'nika-serve') {
      throw new NikaCompatibilityError(
        'engineIdentity',
        this.kind,
        'GET /health did not identify a live nika-serve engine',
      );
    }
    compatibleEngineIdentity(health, this.kind, local);
    return local;
  }

  private async captureSnapshot(
    workflow: string,
    signal?: AbortSignal,
  ): Promise<CapturedSnapshot> {
    const identity = await this.ensureReady();
    const captured = await captureEngine(
      this.options.engine.bin,
      ['check', workflow, '--json', '--sdk-snapshot'],
      {
        cwd: this.options.cwd,
        signal,
        bufferBytes: this.options.machineBufferBytes,
        transport: this.kind,
        label: 'SDK snapshot capture',
      },
    );
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(captured.stdout.trim()) as unknown as Record<string, unknown>;
    } catch (cause) {
      throw new NikaCompatibilityError(
        'executionSnapshot',
        this.kind,
        `Local engine did not emit the required snapshot report (exit ${captured.exitCode})`,
      );
    }
    compatibleEngineIdentity(outer, this.kind, identity);
    if (
      outer.engineVersion !== identity.engineVersion
      || outer.report_version !== identity.checkReportVersion
    ) {
      throw this.gap(
        'executionSnapshot',
        'Local snapshot report identity changed after the engine probe',
      );
    }
    if (captured.stderr.trim()) {
      throw this.gap('executionSnapshot', 'Local snapshot capture wrote unexpected diagnostics');
    }
    if (captured.exitCode !== 0 || outer.clean !== true) {
      throw this.gap(
        'executionSnapshot',
        `Local snapshot capture was not clean (exit ${captured.exitCode})`,
      );
    }
    const bytes = outer.execution_snapshot;
    if (typeof bytes !== 'string' || bytes.length === 0) {
      throw this.gap('executionSnapshot', 'Local engine omitted execution_snapshot bytes');
    }
    const report: Record<string, unknown> = { ...outer, exitCode: captured.exitCode };
    delete report.execution_snapshot;
    return { report: report as NikaCheckResult, bytes };
  }

  private async json(
    path: string,
    init: RequestInit,
    authenticated = true,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchResponse(path, init, true, authenticated);
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
    authenticated = true,
  ): Promise<Response> {
    const controller = withTimeout ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.options.requestTimeout)
      : undefined;
    const callerSignal = init.signal;
    const abort = () => controller?.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', abort, { once: true });
    const headers = new Headers(init.headers);
    if (authenticated) headers.set('Authorization', `Bearer ${this.options.token}`);
    try {
      const response = await this.options.fetch(`${this.options.url}${path}`, {
        ...init,
        headers,
        signal: controller?.signal ?? callerSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const safeBody = redact(body, this.options.token);
        throw new NikaTransportError(
          this.kind,
          `HTTP ${response.status} for ${path}${safeBody ? `: ${safeBody}` : ''}`,
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

function redact(value: string, secret: string): string {
  if (!value) return value;
  return value.split(secret).join('[REDACTED]');
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
