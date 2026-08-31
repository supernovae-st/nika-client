import { randomUUID } from 'node:crypto';
import {
  NikaCompatibilityError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../errors.js';
import type {
  NikaCancelResult,
  NikaAttachRunOptions,
  NikaCheckOptions,
  NikaCheckResult,
  NikaEvent,
  NikaReceipt,
  NikaRunOptions,
  NikaRunResult,
  NikaRunStatus,
  NikaOperation,
  NikaOperationFinding,
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaWorkflowMetadata,
} from '../types.js';
import { verifyNikaEngine, type ResolvedNikaEngine } from './binary/index.js';
import { captureEngine } from './engine-capture.js';
import {
  compatibleEngineIdentity,
  type NikaEngineIdentity,
} from './engine-identity.js';
import { eventError, eventOutputs, eventReceipt, machineObject } from './machine.js';
import { decodeSse, SseParseError, type SseLimits } from './sse/parser.js';
import type { Transport, TransportRun } from './transport.js';

export interface HttpTransportOptions {
  url: string;
  token: string;
  fetch: typeof globalThis.fetch;
  requestTimeout: number;
  machineBufferBytes: number;
  engine: ResolvedNikaEngine;
  cwd?: string;
  retryDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface CapturedSnapshot {
  report: NikaCheckResult;
  bytes?: string;
}

interface ObservationState {
  lastSequence: number;
  lastData?: string;
  attempt: number;
  terminalObserved: boolean;
  serverRetryMilliseconds?: number;
}

interface DurableJob {
  id: string;
  status: string;
  execution_id?: string;
  trace_id?: string;
  outputs?: Record<string, unknown>;
  receipt?: NikaReceipt;
  error?: { code: string; message: string };
}

interface RetryObservation {
  retry: true;
  retryAfterMilliseconds?: number;
}

const JOB_STATUSES = new Set([
  'queued',
  'running',
  'interrupted',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);
const MAX_OBSERVATION_RETRIES = 5;
const RETRY_BASE_MILLISECONDS = 100;
const RETRY_MIN_MILLISECONDS = 25;
const RETRY_MAX_MILLISECONDS = 5_000;

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  private ready?: Promise<NikaEngineIdentity>;
  private remoteIdentity?: NikaEngineIdentity;

  constructor(private readonly options: HttpTransportOptions) {}

  async check(workflow: string, options: NikaCheckOptions): Promise<NikaCheckResult> {
    if (options.model !== undefined || options.nativeStrict === true) {
      throw this.gap(
        'checkOptions',
        'Remote snapshot capture does not support model or nativeStrict overrides',
      );
    }
    const captured = await this.captureSnapshot(workflow, options.signal);
    if (captured.bytes === undefined) return captured.report;
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
    if (captured.bytes === undefined) {
      throw this.gap('executionSnapshot', 'Local workflow check was not clean; run was not admitted');
    }
    const admitted = await this.json('/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: captured.bytes,
    }, true, [200, 202]);
    const id = typeof admitted.id === 'string' ? admitted.id : undefined;
    if (!id) {
      throw new NikaProtocolError(this.kind, 'Job admission response omitted its id');
    }
    return this.httpRun(id);
  }

  async attachRun(id: string, options: NikaAttachRunOptions): Promise<TransportRun> {
    await this.ensureReady();
    const object = await this.json(`/v1/jobs/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    durableJob(object, id, this.kind);
    return this.httpRun(id, options.lastEventId ?? 0);
  }

  async listWorkflows(): Promise<readonly string[]> {
    await this.ensureReady();
    const object = await this.json('/v1/workflows', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (
      !Array.isArray(object.workflows)
      || object.workflows.some((name) => typeof name !== 'string' || name.length === 0)
    ) {
      throw new NikaProtocolError(this.kind, 'Workflow catalog response was malformed');
    }
    return Object.freeze([...object.workflows]) as readonly string[];
  }

  async workflow(name: string): Promise<NikaWorkflowMetadata> {
    await this.ensureReady();
    const object = await this.json(`/v1/workflows/${workflowPath(name)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (typeof object.workflow !== 'string' || object.workflow.length === 0) {
      throw new NikaProtocolError(this.kind, 'Workflow metadata response was malformed');
    }
    return object as unknown as NikaWorkflowMetadata;
  }

  async schedule(
    workflow: string,
    options: NikaScheduleOptions,
  ): Promise<NikaScheduleApplyResult> {
    await this.ensureScheduleCapability();
    const path = `/v1/schedules/${encodeURIComponent(options.id)}`;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (options.revision === undefined) {
      headers.set('If-None-Match', '*');
    } else {
      headers.set('If-Match', `"${options.revision}"`);
    }
    const object = await this.operationJson('schedule', path, {
      method: 'PUT',
      headers,
      body: JSON.stringify(scheduleBody(workflow, options)),
    });
    if (
      object.applied !== true
      || typeof object.changed !== 'boolean'
      || !scheduleStatusProjection(object.status)
    ) {
      throw new NikaProtocolError(this.kind, 'Schedule apply response was not an acknowledgement');
    }
    return object as unknown as NikaScheduleApplyResult;
  }

  async scheduleStatus(id: string): Promise<NikaScheduleStatus> {
    await this.ensureScheduleCapability();
    const path = `/v1/schedules/${encodeURIComponent(id)}`;
    const object = await this.operationJson('scheduleStatus', path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!scheduleStatusProjection(object)) {
      throw new NikaProtocolError(this.kind, 'Schedule status response omitted machine fields');
    }
    return object as unknown as NikaScheduleStatus;
  }

  async traceVerify(
    receipt: NikaReceipt,
    options: NikaTraceVerifyOptions,
  ): Promise<NikaTraceVerifyResult> {
    await this.ensureReady();
    const jobId = receipt.job_id;
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw this.gap('traceVerify', 'The engine receipt does not carry a remote job_id');
    }
    const object = await this.json(
      `/v1/jobs/${encodeURIComponent(jobId)}/trace/verify`,
      { method: 'GET', signal: options.signal },
    );
    if (
      typeof object.verdict !== 'string'
      || typeof object.reason !== 'string'
      || (object.trace_id !== undefined && typeof object.trace_id !== 'string')
    ) {
      throw new NikaProtocolError(this.kind, 'Trace verification verdict was malformed');
    }
    const traceMatches = object.trace_id === undefined
      || receipt.trace_id === undefined
      || object.trace_id === receipt.trace_id;
    return {
      ...object,
      verified: object.verdict === 'verified' && traceMatches,
    } as NikaTraceVerifyResult;
  }

  private httpRun(id: string, initialSequence = 0): TransportRun {
    const controller = new AbortController();
    let terminalObserved = false;
    let resolveDone!: (result: NikaRunResult) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<NikaRunResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    done.catch(() => {});

    const settle = (source: NikaEvent | DurableJob) => {
      const event = 'sequence' in source ? source : undefined;
      const durable = event ? undefined : source as DurableJob;
      const receipt = event ? eventReceipt(event) : durable?.receipt;
      if (receipt) {
        assertReceiptIdentity(
          receipt,
          id,
          this.kind,
          durable?.execution_id,
          durable?.trace_id,
        );
      }
      terminalObserved = true;
      const outputs = event ? eventOutputs(event) : durable?.outputs;
      const error = event ? eventError(event) : durable?.error;
      resolveDone({
        id,
        status: source.status!,
        transport: this.kind,
        ...(durable?.execution_id ? { execution_id: durable.execution_id } : {}),
        ...(durable?.trace_id ? { trace_id: durable.trace_id } : {}),
        ...(outputs ? { outputs } : {}),
        ...(receipt ? { receipt } : {}),
        ...(error ? { error } : {}),
      });
    };

    const events: AsyncIterable<NikaEvent> = {
      [Symbol.asyncIterator]: async function* (this: HttpTransport) {
        try {
          for await (const event of this.observeJob(
            id,
            controller.signal,
            settle,
            initialSequence,
          )) {
            yield event;
          }
        } catch (cause) {
          const error = cause instanceof Error
            ? cause
            : new NikaTransportError(this.kind, String(cause));
          if (!terminalObserved) rejectDone(error);
          throw error;
        }
      }.bind(this),
    };

    return {
      id,
      events,
      done,
      status: async (): Promise<NikaRunStatus> => {
        const object = await this.json(`/v1/jobs/${encodeURIComponent(id)}/status`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (typeof object.status !== 'string' || !JOB_STATUSES.has(object.status)) {
          throw new NikaProtocolError(this.kind, 'Job status response was malformed');
        }
        return object.status;
      },
      cancel: async (): Promise<NikaCancelResult> => {
        const object = await this.json(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
        });
        const durable = durableJob(object, id, this.kind);
        if (!isTerminal(durable.status)) {
          throw new NikaProtocolError(this.kind, 'Cancellation did not return a terminal job');
        }
        settle(durable);
        const accepted = durable.status === 'cancelled';
        return {
          runId: id,
          accepted,
          status: accepted ? 'cancelled' : 'already_settled',
          transport: this.kind,
        };
      },
      cleanup: async () => {
        if (!terminalObserved) controller.abort();
      },
    };
  }

  private async *observeJob(
    id: string,
    signal: AbortSignal,
    settle: (source: NikaEvent | DurableJob) => void,
    initialSequence = 0,
  ): AsyncGenerator<NikaEvent> {
    const state: ObservationState = {
      lastSequence: initialSequence,
      attempt: 0,
      terminalObserved: false,
    };
    const jobPath = `/v1/jobs/${encodeURIComponent(id)}`;
    const eventsPath = `/v1/jobs/${encodeURIComponent(id)}/events`;

    while (!state.terminalObserved) {
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (state.lastSequence > 0) headers.set('Last-Event-ID', String(state.lastSequence));

      let response: Response;
      try {
        response = await this.observationRequest(eventsPath, { headers, signal });
      } catch {
        await this.retryObservation(state, signal, {
          retry: true,
        });
        continue;
      }

      if (response.status === 404) {
        await discardResponse(response);
        const durable = await this.inspectDurableJob(jobPath, id, signal);
        if (isRetryObservation(durable)) {
          await this.retryObservation(state, signal, durable);
          continue;
        }
        if (isTerminal(durable.status)) {
          state.terminalObserved = true;
          settle(durable);
          return;
        }
        await this.retryObservation(state, signal, { retry: true });
        continue;
      }

      if (isRetryableStatus(response.status)) {
        const retryAfterMilliseconds = retryAfter(response.headers.get('Retry-After'));
        await discardResponse(response);
        await this.retryObservation(state, signal, {
          retry: true,
          ...(retryAfterMilliseconds !== undefined ? { retryAfterMilliseconds } : {}),
        });
        continue;
      }

      this.assertObservationResponse(response, eventsPath, 'text/event-stream');
      const body = response.body;
      if (!body) {
        throw new NikaProtocolError(this.kind, 'SSE event response omitted its body');
      }

      try {
        const limits = this.sseLimits();
        for await (const frame of decodeSse(body, limits)) {
          if (frame.retry !== undefined) {
            state.serverRetryMilliseconds = boundedDelay(frame.retry);
          }
          if (frame.data === undefined) continue;
          const event = this.nikaEvent(frame.id, frame.data);
          const sequence = event.sequence as number;
          if (sequence === state.lastSequence) {
            if (frame.data === state.lastData) continue;
            throw new NikaProtocolError(
              this.kind,
              `SSE sequence ${sequence} replayed with different data`,
            );
          }
          if (sequence !== state.lastSequence + 1) {
            const relation = sequence > state.lastSequence ? 'gap' : 'out-of-order replay';
            throw new NikaProtocolError(
              this.kind,
              `SSE ${relation}: expected sequence ${state.lastSequence + 1}, received ${sequence}`,
            );
          }
          state.lastSequence = sequence;
          state.lastData = frame.data;
          state.attempt = 0;
          if (isTerminal(event.status)) {
            state.terminalObserved = true;
            settle(event);
          }
          yield event;
          if (state.terminalObserved) return;
        }
      } catch (cause) {
        if (cause instanceof SseParseError) {
          throw new NikaProtocolError(this.kind, cause.message, { cause });
        }
        if (cause instanceof NikaProtocolError) throw cause;
        // A body reset is recoverable, but durable state is authoritative
        // before any resume attempt.
      }

      const durable = await this.inspectDurableJob(jobPath, id, signal);
      if (isRetryObservation(durable)) {
        await this.retryObservation(state, signal, durable);
        continue;
      }
      if (isTerminal(durable.status)) {
        state.terminalObserved = true;
        settle(durable);
        return;
      }
      await this.retryObservation(state, signal, { retry: true });
    }
  }

  private nikaEvent(id: string | undefined, data: string): NikaEvent {
    if (!id || !/^[1-9]\d*$/.test(id)) {
      throw new NikaProtocolError(
        this.kind,
        'SSE event id must be a canonical positive decimal sequence',
      );
    }
    const sequence = Number(id);
    if (!Number.isSafeInteger(sequence)) {
      throw new NikaProtocolError(this.kind, 'SSE event id exceeded the safe integer range');
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (cause) {
      throw new NikaProtocolError(this.kind, 'SSE data was not valid JSON', {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    const event = machineObject(value);
    if (!event) throw new NikaProtocolError(this.kind, 'SSE data was not an object');
    if (event.sequence !== sequence) {
      throw new NikaProtocolError(
        this.kind,
        `SSE id ${id} did not equal JSON data.sequence`,
      );
    }
    if (event.kind !== undefined && event.kind !== null && typeof event.kind !== 'string') {
      throw new NikaProtocolError(this.kind, 'SSE data.kind was not a string or null');
    }
    if (
      event.status !== undefined
      && event.status !== null
      && (typeof event.status !== 'string' || !JOB_STATUSES.has(event.status))
    ) {
      throw new NikaProtocolError(this.kind, 'SSE data.status was not a known job status or null');
    }
    for (const field of ['code', 'message'] as const) {
      if (event[field] !== undefined && typeof event[field] !== 'string') {
        throw new NikaProtocolError(this.kind, `SSE data.${field} was not a string`);
      }
    }
    return event as NikaEvent;
  }

  private async inspectDurableJob(
    path: string,
    expectedId: string,
    signal: AbortSignal,
  ): Promise<DurableJob | RetryObservation> {
    let response: Response;
    try {
      response = await this.observationRequest(path, { headers: { Accept: 'application/json' }, signal });
    } catch {
      return { retry: true };
    }
    if (response.status === 404) {
      await discardResponse(response);
      throw new NikaTransportError(this.kind, `HTTP 404 for ${path}; job was durably absent`);
    }
    if (isRetryableStatus(response.status)) {
      const retryAfterMilliseconds = retryAfter(response.headers.get('Retry-After'));
      await discardResponse(response);
      return {
        retry: true,
        ...(retryAfterMilliseconds !== undefined ? { retryAfterMilliseconds } : {}),
      };
    }
    this.assertObservationResponse(response, path, 'application/json');
    try {
      const object = await this.readObservationObject(response, path);
      return durableJob(object, expectedId, this.kind);
    } catch (cause) {
      if (cause instanceof NikaTransportError && !(cause instanceof NikaProtocolError)) {
        return { retry: true };
      }
      throw cause;
    }
  }

  private assertObservationResponse(
    response: Response,
    path: string,
    contentType: string,
  ): void {
    if (response.status === 204) {
      void discardResponse(response);
      throw new NikaProtocolError(this.kind, `HTTP 204 permanently stopped observation for ${path}`);
    }
    if (response.status === 401 || response.status === 403) {
      void discardResponse(response);
      throw new NikaTransportError(this.kind, `HTTP ${response.status} authorization failure for ${path}`);
    }
    if (response.status !== 200) {
      void discardResponse(response);
      throw new NikaTransportError(this.kind, `HTTP ${response.status} permanently failed ${path}`);
    }
    const actual = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (actual !== contentType) {
      void discardResponse(response);
      throw new NikaProtocolError(
        this.kind,
        `HTTP ${path} returned an invalid content-type`,
      );
    }
  }

  private async readObservationObject(
    response: Response,
    path: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!response.body) {
      throw new NikaProtocolError(this.kind, `HTTP ${path} omitted its JSON body`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let rejectBoundary!: (error: Error) => void;
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject;
    });
    const abort = () => {
      rejectBoundary(new NikaTransportError(this.kind, `HTTP ${path} response body was aborted`));
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      rejectBoundary(new NikaTransportError(
        this.kind,
        `HTTP response body timed out after ${this.options.requestTimeout}ms`,
      ));
      void reader.cancel().catch(() => {});
    }, this.options.requestTimeout);
    try {
      if (signal?.aborted) abort();
      while (true) {
        const { done, value } = await Promise.race([reader.read(), boundary]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.options.machineBufferBytes) {
          throw new NikaProtocolError(
            this.kind,
            `HTTP ${path} JSON exceeded ${this.options.machineBufferBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    } catch (cause) {
      if (cause instanceof NikaProtocolError) throw cause;
      throw new NikaTransportError(this.kind, `HTTP ${path} response body reset`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (cause) {
      throw new NikaProtocolError(this.kind, `HTTP ${path} JSON was not valid UTF-8`, {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (cause) {
      throw new NikaProtocolError(this.kind, `HTTP ${path} did not return valid JSON`, {
        cause: cause instanceof Error ? cause : undefined,
      });
    }
    const object = machineObject(value);
    if (!object) throw new NikaProtocolError(this.kind, `HTTP ${path} did not return an object`);
    return object;
  }

  private async observationRequest(
    path: string,
    init: RequestInit,
    withTimeout = true,
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
      return await this.options.fetch(`${this.options.url}${path}`, {
        ...init,
        headers,
        signal: controller?.signal ?? callerSignal,
      });
    } catch {
      if (controller?.signal.aborted && !callerSignal?.aborted) {
        throw new NikaTransportError(
          this.kind,
          `HTTP observation timed out after ${this.options.requestTimeout}ms`,
        );
      }
      throw new NikaTransportError(this.kind, 'HTTP observation transport failed');
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  }

  private async retryObservation(
    state: ObservationState,
    signal: AbortSignal,
    retry: RetryObservation,
  ): Promise<void> {
    if (state.attempt >= MAX_OBSERVATION_RETRIES) {
      throw new NikaTransportError(
        this.kind,
        `HTTP observation exhausted ${MAX_OBSERVATION_RETRIES} retries`,
      );
    }
    state.attempt += 1;
    const exponential = Math.min(
      RETRY_BASE_MILLISECONDS * (2 ** (state.attempt - 1)),
      RETRY_MAX_MILLISECONDS,
    );
    const milliseconds = retry.retryAfterMilliseconds
      ?? state.serverRetryMilliseconds
      ?? exponential;
    await (this.options.retryDelay ?? abortableDelay)(boundedDelay(milliseconds), signal);
  }

  private sseLimits(): SseLimits {
    return {
      maxLineBytes: this.options.machineBufferBytes,
      maxFrameBytes: this.options.machineBufferBytes,
      maxBufferBytes: this.options.machineBufferBytes,
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
    this.remoteIdentity = compatibleEngineIdentity(health, this.kind, local);
    return local;
  }

  private async ensureScheduleCapability(): Promise<void> {
    await this.ensureReady();
    if (!this.remoteIdentity?.supportedCapabilities.includes('schedule')) {
      throw this.gap(
        'schedule',
        'The connected nika serve process did not advertise resident schedule authority',
      );
    }
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
    const report: Record<string, unknown> = { ...outer, exitCode: captured.exitCode };
    delete report.execution_snapshot;
    if (captured.exitCode !== 0 || outer.clean !== true) {
      report.clean = false;
      return { report: report as NikaCheckResult };
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
    const bytes = outer.execution_snapshot;
    if (typeof bytes !== 'string' || bytes.length === 0) {
      throw this.gap('executionSnapshot', 'Local engine omitted execution_snapshot bytes');
    }
    return { report: report as NikaCheckResult, bytes };
  }

  private async json(
    path: string,
    init: RequestInit,
    authenticated = true,
    acceptedStatuses: readonly number[] = [200],
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchResponse(path, init, true, authenticated, false);
    if (!acceptedStatuses.includes(response.status)) {
      await discardResponse(response);
      if (response.ok) {
        throw new NikaProtocolError(
          this.kind,
          `HTTP ${path} returned non-contract status ${response.status}`,
        );
      }
      throw new NikaTransportError(
        this.kind,
        `HTTP ${response.status} for ${path}: [REDACTED]`,
      );
    }
    const contentType = response.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      await discardResponse(response);
      throw new NikaProtocolError(this.kind, `HTTP ${path} returned an invalid content-type`);
    }
    return this.readObservationObject(response, path, init.signal ?? undefined);
  }

  private async operationJson(
    operation: NikaOperation,
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchResponse(path, init, true, true, false);
    const contentType = response.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      await discardResponse(response);
      throw new NikaProtocolError(this.kind, `HTTP ${path} returned an invalid content-type`);
    }
    const object = await this.readObservationObject(response, path);
    if (!response.ok) throw this.operationFailure(operation, response.status, object);
    return object;
  }

  private operationFailure(
    operation: NikaOperation,
    status: number,
    object: Record<string, unknown>,
  ): NikaOperationError {
    if (status === 412 && operation === 'schedule') {
      const machine = machineObject(object.error);
      const currentRevision = machine?.currentRevision;
      return new NikaOperationError(
        operation,
        this.kind,
        'schedule_conflict',
        typeof machine?.message === 'string' ? machine.message : 'Schedule revision conflict',
        {
          status,
          machineCode: typeof machine?.code === 'string' ? machine.code : undefined,
          ...(typeof currentRevision === 'string' || currentRevision === null
            ? { currentRevision }
            : {}),
        },
      );
    }

    if (Array.isArray(object.findings)) {
      const findings = operationFindings(object.findings);
      if (!findings) {
        throw new NikaProtocolError(this.kind, 'Schedule refusal findings were malformed');
      }
      return new NikaOperationError(
        operation,
        this.kind,
        'schedule_refused',
        'Schedule was refused by the resident authority',
        { status, findings },
      );
    }

    const machine = machineObject(object.error);
    if (typeof machine?.code !== 'string' || typeof machine.message !== 'string') {
      throw new NikaProtocolError(this.kind, `HTTP ${pathForOperation(operation)} error was malformed`);
    }
    return new NikaOperationError(
      operation,
      this.kind,
      machine.code,
      machine.message,
      { status, machineCode: machine.code },
    );
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
    withTimeout: boolean,
    authenticated = true,
    requireOk = true,
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
      if (requireOk && !response.ok) {
        await discardResponse(response);
        throw new NikaTransportError(
          this.kind,
          `HTTP ${response.status} for ${path}: [REDACTED]`,
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

function workflowPath(name: string): string {
  const segments = name.split('/');
  if (
    name.startsWith('/')
    || name.includes('\\')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TypeError('workflow name must be a contained slash-separated path');
  }
  return segments.map(encodeURIComponent).join('/');
}

function scheduleBody(
  workflow: string,
  options: NikaScheduleOptions,
): Record<string, unknown> {
  return {
    workflow,
    when: options.when,
    maxCostUsd: options.maxCostUsd,
    missed: options.missed,
    ...(options.maxLatenessSeconds !== undefined
      ? { maxLatenessSeconds: options.maxLatenessSeconds }
      : {}),
    ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
    ...(options.afterSkip !== undefined ? { afterSkip: options.afterSkip } : {}),
    ...(options.jitter !== undefined ? { jitter: options.jitter } : {}),
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
    ...(options.active !== undefined ? { active: options.active } : {}),
    ...(options.pauseReason !== undefined ? { pauseReason: options.pauseReason } : {}),
    ...(options.pauseUntil !== undefined ? { pauseUntil: options.pauseUntil } : {}),
  };
}

function scheduleStatusProjection(value: unknown): value is Record<string, unknown> {
  const status = machineObject(value);
  const definition = machineObject(status?.definition);
  const when = machineObject(definition?.when);
  const due = machineObject(status?.due);
  const finding = machineObject(status?.finding);
  return !!status
    && !!definition
    && typeof definition.id === 'string'
    && typeof definition.workflow === 'string'
    && !!when
    && typeof when.kind === 'string'
    && typeof definition.maxCostUsd === 'number'
    && typeof definition.missed === 'string'
    && (definition.maxLatenessSeconds === null
      || typeof definition.maxLatenessSeconds === 'number')
    && typeof definition.overlap === 'string'
    && typeof definition.afterSkip === 'string'
    && (definition.jitter === null || typeof definition.jitter === 'string')
    && (definition.tolerance === null || typeof definition.tolerance === 'string')
    && typeof definition.active === 'boolean'
    && (definition.pauseReason === null || typeof definition.pauseReason === 'string')
    && (definition.pauseUntil === null || typeof definition.pauseUntil === 'string')
    && typeof status.origin === 'string'
    && typeof status.revision === 'string'
    && typeof status.active === 'boolean'
    && (status.pause === null || !!machineObject(status.pause))
    && Array.isArray(status.next)
    && status.next.every(scheduleSlotProjection)
    && (status.earliestWakeHint === null || typeof status.earliestWakeHint === 'string')
    && (status.lastDecision === null || !!machineObject(status.lastDecision))
    && (
      (typeof due?.kind === 'string' && status.finding === undefined)
      || (status.due === undefined && scheduleFindingProjection(finding))
    );
}

function scheduleSlotProjection(value: unknown): boolean {
  const slot = machineObject(value);
  return typeof slot?.slotId === 'string'
    && typeof slot.scheduledFor === 'string'
    && (slot.requestedCivil === null || typeof slot.requestedCivil === 'string')
    && typeof slot.shift === 'string';
}

function scheduleFindingProjection(value: unknown): boolean {
  const finding = machineObject(value);
  return typeof finding?.code === 'string' && typeof finding.detail === 'string';
}

function operationFindings(values: unknown[]): NikaOperationFinding[] | undefined {
  const findings: NikaOperationFinding[] = [];
  for (const value of values) {
    const finding = machineObject(value);
    if (typeof finding?.code !== 'string' || typeof finding.detail !== 'string') {
      return undefined;
    }
    findings.push(finding as unknown as NikaOperationFinding);
  }
  return findings;
}

function pathForOperation(operation: NikaOperation): string {
  return operation === 'schedule' ? 'schedule apply' : 'schedule status';
}

function isTerminal(status: unknown): status is string {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'interrupted'
    || status === 'cancelled';
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? boundedDelay(seconds * 1_000) : undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return boundedDelay(Math.max(0, date - Date.now()));
}

function boundedDelay(milliseconds: number): number {
  return Math.max(
    RETRY_MIN_MILLISECONDS,
    Math.min(Math.floor(milliseconds), RETRY_MAX_MILLISECONDS),
  );
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Observation aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('Observation aborted'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function isRetryObservation(
  value: DurableJob | RetryObservation,
): value is RetryObservation {
  return 'retry' in value;
}

function durableJob(
  value: Record<string, unknown>,
  expectedId: string,
  transport: 'http',
): DurableJob {
  const allowed = new Set([
    'id', 'status', 'execution_id', 'trace_id', 'outputs', 'receipt', 'error',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new NikaProtocolError(transport, 'Durable job response contained unknown fields');
  }
  if (value.id !== expectedId || typeof value.status !== 'string' || !JOB_STATUSES.has(value.status)) {
    throw new NikaProtocolError(transport, 'Durable job response had an invalid id or status');
  }
  for (const field of ['execution_id', 'trace_id'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new NikaProtocolError(transport, `Durable job response ${field} was not a string`);
    }
  }
  let error: DurableJob['error'];
  if (value.error !== undefined) {
    const object = machineObject(value.error);
    if (
      !object
      || Object.keys(object).some((key) => key !== 'code' && key !== 'message')
      || typeof object.code !== 'string'
      || typeof object.message !== 'string'
    ) {
      throw new NikaProtocolError(transport, 'Durable job response error was malformed');
    }
    error = { code: object.code, message: object.message };
  }
  const outputs = value.outputs === undefined ? undefined : machineObject(value.outputs);
  const receipt = value.receipt === undefined ? undefined : machineObject(value.receipt);
  if (value.outputs !== undefined && !outputs) {
    throw new NikaProtocolError(transport, 'Durable job response outputs were malformed');
  }
  if (value.receipt !== undefined && !receipt) {
    throw new NikaProtocolError(transport, 'Durable job response receipt was malformed');
  }
  if (receipt) {
    assertReceiptIdentity(
      receipt,
      expectedId,
      transport,
      typeof value.execution_id === 'string' ? value.execution_id : undefined,
      typeof value.trace_id === 'string' ? value.trace_id : undefined,
    );
  }
  return {
    id: value.id,
    status: value.status,
    ...(typeof value.execution_id === 'string' ? { execution_id: value.execution_id } : {}),
    ...(typeof value.trace_id === 'string' ? { trace_id: value.trace_id } : {}),
    ...(outputs ? { outputs } : {}),
    ...(receipt ? { receipt: Object.freeze(receipt) } : {}),
    ...(error ? { error } : {}),
  };
}

function assertReceiptIdentity(
  receipt: Readonly<Record<string, unknown>>,
  expectedJobId: string,
  transport: 'http',
  expectedExecutionId?: string,
  expectedTraceId?: string,
): void {
  if (receipt.job_id !== expectedJobId) {
    throw new NikaProtocolError(transport, 'Receipt job identity did not match its run');
  }
  if (expectedExecutionId !== undefined && receipt.execution_id !== expectedExecutionId) {
    throw new NikaProtocolError(transport, 'Receipt execution identity did not match its job');
  }
  if (expectedTraceId !== undefined && receipt.trace_id !== expectedTraceId) {
    throw new NikaProtocolError(transport, 'Receipt trace identity did not match its job');
  }
}
