import { randomUUID } from 'node:crypto';
import {
  NikaCompatibilityError,
  NikaObservationInterrupted,
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
  NikaExecutionId,
  NikaReceipt,
  NikaRunId,
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
  resolveEngine: () => ResolvedNikaEngine;
  cwd?: string;
  retryDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface CapturedSnapshot {
  report: NikaCheckResult;
  bytes?: string;
  identity?: SnapshotIdentity;
}

interface SnapshotIdentity {
  digest: string;
  root: string;
  units: number;
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
  execution_id?: NikaExecutionId;
  trace_id?: string;
  outputs?: Record<string, unknown>;
  receipt?: NikaReceipt;
  error?: { code: string; message: string };
}

interface RetryObservation {
  retry: true;
  retryAfterMilliseconds?: number;
}

interface ObservationSettlement {
  jobPath: string;
  id: string;
  settle: (source: NikaEvent | DurableJob) => void;
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
  private serverIdentity?: Promise<NikaEngineIdentity>;
  private localIdentity?: Promise<NikaEngineIdentity>;
  private resolvedEngine?: ResolvedNikaEngine;
  private remoteIdentity?: NikaEngineIdentity;

  constructor(private readonly options: HttpTransportOptions) {}

  async check(workflow: string, options: NikaCheckOptions): Promise<NikaCheckResult> {
    if (options.model !== undefined || options.nativeStrict === true) {
      throw this.gap(
        'checkOptions',
        'Remote snapshot capture does not support model or nativeStrict overrides',
      );
    }
    const captured = await this.captureSnapshot(workflow, options.signal, true);
    if (captured.bytes === undefined) return captured.report;
    const snapshot = captured.identity;
    if (!snapshot) {
      throw this.gap('executionSnapshot', 'Local engine omitted execution snapshot identity');
    }
    const acknowledged = await this.json('/v1/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: captured.bytes,
      signal: options.signal,
    }, true, [200], 'check');
    if (
      Object.keys(acknowledged).some((key) => ![
        'status', 'snapshot_digest', 'root', 'units',
      ].includes(key))
      || acknowledged.status !== 'accepted'
      || acknowledged.snapshot_digest !== snapshot.digest
      || acknowledged.root !== snapshot.root
      || acknowledged.units !== snapshot.units
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
    if (!captured.identity) {
      throw this.gap('executionSnapshot', 'Local engine omitted execution snapshot identity');
    }
    const admitted = await this.json('/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: captured.bytes,
    }, true, [200, 202], 'run');
    const id = typeof admitted.id === 'string' ? admitted.id as NikaRunId : undefined;
    if (!id) {
      throw new NikaProtocolError(this.kind, 'Job admission response omitted its id');
    }
    return this.httpRun(
      id,
      0,
      durableJob(admitted, id, this.kind),
      captured.identity.digest,
    );
  }

  async attachRun(id: string, options: NikaAttachRunOptions): Promise<TransportRun> {
    await this.ensureServerIdentity();
    const object = await this.json(`/v1/jobs/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, true, [200], 'attachRun');
    const durable = durableJob(object, id, this.kind);
    return this.httpRun(id as NikaRunId, options.lastEventId ?? 0, durable);
  }

  async listWorkflows(): Promise<readonly string[]> {
    await this.ensureServerIdentity();
    const object = await this.json('/v1/workflows', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, true, [200], 'listWorkflows');
    if (
      Object.keys(object).some((key) => key !== 'workflows')
      || !Array.isArray(object.workflows)
      || object.workflows.some((name) => !isContainedWorkflowName(name))
      || new Set(object.workflows).size !== object.workflows.length
    ) {
      throw new NikaProtocolError(this.kind, 'Workflow catalog response was malformed');
    }
    return Object.freeze([...object.workflows]) as readonly string[];
  }

  async workflow(name: string): Promise<NikaWorkflowMetadata> {
    await this.ensureServerIdentity();
    const object = await this.json(`/v1/workflows/${workflowPath(name)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    }, true, [200], 'workflow');
    if (
      Object.keys(object).some((key) => key !== 'workflow')
      || !isContainedWorkflowName(object.workflow)
      || object.workflow !== name
    ) {
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
    await this.ensureServerIdentity();
    const jobId = receipt.job_id;
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw this.gap('traceVerify', 'The engine receipt does not carry a remote job_id');
    }
    const object = await this.json(
      `/v1/jobs/${encodeURIComponent(jobId)}/trace/verify`,
      { method: 'GET', signal: options.signal },
      true,
      [200],
      'traceVerify',
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

  private httpRun(
    id: NikaRunId,
    initialSequence = 0,
    attachedState?: DurableJob,
    expectedSnapshotDigest?: string,
  ): TransportRun {
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
      if (
        durable?.execution_id !== undefined
        && attachedState?.execution_id !== undefined
        && durable.execution_id !== attachedState.execution_id
      ) {
        throw new NikaProtocolError(this.kind, 'Durable execution identity changed after attach');
      }
      if (
        durable?.trace_id !== undefined
        && attachedState?.trace_id !== undefined
        && durable.trace_id !== attachedState.trace_id
      ) {
        throw new NikaProtocolError(this.kind, 'Durable trace identity changed after attach');
      }
      const knownExecutionId = attachedState?.execution_id ?? durable?.execution_id;
      const knownTraceId = attachedState?.trace_id ?? durable?.trace_id;
      if (receipt) {
        assertReceiptIdentity(
          receipt,
          id,
          this.kind,
          knownExecutionId,
          knownTraceId,
          expectedSnapshotDigest,
        );
      }
      // A run admitted by POST and settled from its SSE frame has no durable
      // read to name its identities; the receipt on that frame carries them
      // and was just checked against every identity already known, so the
      // result names the same execution and trace on both settlement paths.
      const executionId = knownExecutionId
        ?? (typeof receipt?.execution_id === 'string'
          ? receipt.execution_id as NikaExecutionId
          : undefined);
      const traceId = knownTraceId
        ?? (typeof receipt?.trace_id === 'string' ? receipt.trace_id : undefined);
      terminalObserved = true;
      const outputs = event ? eventOutputs(event) : durable?.outputs;
      const error = event ? eventError(event) : durable?.error;
      resolveDone({
        id,
        status: source.status!,
        transport: this.kind,
        ...(executionId ? { execution_id: executionId } : {}),
        ...(traceId ? { trace_id: traceId } : {}),
        ...(outputs ? { outputs } : {}),
        ...(receipt ? { receipt } : {}),
        ...(error ? { error } : {}),
      });
    };
    if (attachedState && isTerminal(attachedState.status)) settle(attachedState);

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
          if (terminalObserved && controller.signal.aborted) return;
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
        }, true, [200], 'status');
        if (typeof object.status !== 'string' || !JOB_STATUSES.has(object.status)) {
          throw new NikaProtocolError(this.kind, 'Job status response was malformed');
        }
        return object.status;
      },
      cancel: async (): Promise<NikaCancelResult> => {
        const object = await this.json(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
        }, true, [200], 'cancel');
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
        controller.abort();
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
    const settlement: ObservationSettlement = { jobPath, id, settle };

    while (!state.terminalObserved) {
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (state.lastSequence > 0) headers.set('Last-Event-ID', String(state.lastSequence));

      let response: Response;
      try {
        response = await this.observationRequest(eventsPath, { headers, signal });
      } catch {
        await this.retryObservation(state, signal, {
          retry: true,
        }, settlement);
        continue;
      }

      if (response.status === 404) {
        await discardResponse(response);
        const durable = await this.inspectDurableJob(jobPath, id, signal);
        if (isRetryObservation(durable)) {
          await this.retryObservation(state, signal, durable, settlement);
          continue;
        }
        if (isTerminal(durable.status)) {
          state.terminalObserved = true;
          settle(durable);
          return;
        }
        await this.retryObservation(state, signal, { retry: true }, settlement);
        continue;
      }

      if (isRetryableStatus(response.status)) {
        const retryAfterMilliseconds = retryAfter(response.headers.get('Retry-After'));
        await discardResponse(response);
        await this.retryObservation(state, signal, {
          retry: true,
          ...(retryAfterMilliseconds !== undefined ? { retryAfterMilliseconds } : {}),
        }, settlement);
        continue;
      }

      this.assertObservationResponse(response, eventsPath, 'text/event-stream');
      const body = response.body;
      if (!body) {
        throw new NikaProtocolError(this.kind, 'SSE event response omitted its body');
      }

      try {
        const limits = this.sseLimits();
        for await (const frame of decodeSse(body, limits, signal)) {
          if (frame.retry !== undefined) {
            state.serverRetryMilliseconds = boundedDelay(frame.retry);
          }
          if (frame.data === undefined) continue;
          const event = this.nikaEvent(id, frame.id, frame.data);
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
        await this.retryObservation(state, signal, durable, settlement);
        continue;
      }
      if (isTerminal(durable.status)) {
        state.terminalObserved = true;
        settle(durable);
        return;
      }
      await this.retryObservation(state, signal, { retry: true }, settlement);
    }
  }

  private nikaEvent(jobId: string, id: string | undefined, data: string): NikaEvent {
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
    const allowed = new Set([
      'sequence', 'kind', 'status', 'code', 'message', 'outputs', 'receipt',
    ]);
    if (Object.keys(event).some((key) => !allowed.has(key))) {
      throw new NikaProtocolError(this.kind, 'SSE data contained fields outside the public projection');
    }
    if (event.sequence !== sequence) {
      throw new NikaProtocolError(
        this.kind,
        `SSE id ${id} did not equal JSON data.sequence`,
      );
    }
    if (!Object.hasOwn(event, 'kind') || (event.kind !== null && typeof event.kind !== 'string')) {
      throw new NikaProtocolError(this.kind, 'SSE data.kind was not a string or null');
    }
    if (
      !Object.hasOwn(event, 'status')
      || (event.status !== null
      && (typeof event.status !== 'string' || !JOB_STATUSES.has(event.status))
      )
    ) {
      throw new NikaProtocolError(this.kind, 'SSE data.status was not a known job status or null');
    }
    for (const field of ['code', 'message'] as const) {
      if (event[field] !== undefined && typeof event[field] !== 'string') {
        throw new NikaProtocolError(this.kind, `SSE data.${field} was not a string`);
      }
    }
    if (event.outputs !== undefined && !machineObject(event.outputs)) {
      throw new NikaProtocolError(this.kind, 'SSE data.outputs was not an object');
    }
    if (event.receipt !== undefined) {
      const receipt = machineObject(event.receipt);
      if (!receipt) {
        throw new NikaProtocolError(this.kind, 'SSE data.receipt was not an object');
      }
      assertReceiptIdentity(receipt, jobId, this.kind);
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
    settlement: ObservationSettlement,
  ): Promise<void> {
    if (state.attempt >= MAX_OBSERVATION_RETRIES) {
      // Exhaustion is a settlement question, not an error by itself: the
      // durable record is the workflow's truth, so one final read wins over
      // observer connectivity. Only a still non-terminal record interrupts.
      const durable = await this.inspectDurableJob(
        settlement.jobPath,
        settlement.id,
        signal,
      );
      if (!isRetryObservation(durable) && isTerminal(durable.status)) {
        state.terminalObserved = true;
        settlement.settle(durable);
        return;
      }
      throw new NikaObservationInterrupted(
        this.kind,
        settlement.id,
        state.lastSequence,
        state.attempt,
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

  private ensureServerIdentity(): Promise<NikaEngineIdentity> {
    this.serverIdentity ??= this.probeServerIdentity();
    return this.serverIdentity;
  }

  private async probeServerIdentity(): Promise<NikaEngineIdentity> {
    const health = await this.json('/health', { method: 'GET' }, false);
    if (health.status !== 'ok' || health.service !== 'nika-serve') {
      throw new NikaCompatibilityError(
        'engineIdentity',
        this.kind,
        'GET /health did not identify a live nika-serve engine',
      );
    }
    // Server-only comparison: the advertised identity must satisfy the SDK's
    // expected protocol vector without any local engine involvement.
    this.remoteIdentity = compatibleEngineIdentity(health, this.kind);
    return this.remoteIdentity;
  }

  private ensureLocalEngine(): Promise<NikaEngineIdentity> {
    this.localIdentity ??= this.verifyLocalEngine();
    return this.localIdentity;
  }

  private localEngine(): ResolvedNikaEngine {
    this.resolvedEngine ??= this.options.resolveEngine();
    return this.resolvedEngine;
  }

  private async verifyLocalEngine(): Promise<NikaEngineIdentity> {
    // Verify local package integrity first: a modified capture engine must not
    // reach even the remote liveness probe.
    const local = await verifyNikaEngine(this.localEngine());
    const remote = await this.ensureServerIdentity();
    compatibleEngineIdentity(remote, this.kind, local);
    return local;
  }

  private async ensureScheduleCapability(): Promise<void> {
    await this.ensureServerIdentity();
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
    teach = false,
  ): Promise<CapturedSnapshot> {
    const identity = await this.ensureLocalEngine();
    const captured = await captureEngine(
      this.localEngine().bin,
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
      if (teach && !Array.isArray(outer.findings)) {
        return { report: await this.teachingReport(workflow, report, signal) };
      }
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
    return {
      report: report as NikaCheckResult,
      bytes,
      identity: snapshotIdentity(bytes, this.kind),
    };
  }

  /**
   * A red workflow has no exportable snapshot, so the capture returns one
   * error line and no findings. Ask the same local engine for its plain
   * teaching report, so `findings[]` reads the same on both transports. The
   * refused capture line is preserved as `snapshot_error` rather than
   * overwriting whatever the engine put in `error`. No bytes leave the
   * machine on this path: the caller still sees `clean: false`.
   */
  private async teachingReport(
    workflow: string,
    refused: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<NikaCheckResult> {
    const captured = await captureEngine(
      this.localEngine().bin,
      ['check', workflow, '--json'],
      {
        cwd: this.options.cwd,
        signal,
        bufferBytes: this.options.machineBufferBytes,
        transport: this.kind,
        label: 'SDK teaching check',
      },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(captured.stdout.trim());
    } catch {
      return refused as NikaCheckResult;
    }
    const plain = machineObject(parsed);
    if (!plain) return refused as NikaCheckResult;
    const report: Record<string, unknown> = {
      ...plain,
      clean: false,
      exitCode: captured.exitCode,
      ...(refused.error === undefined ? {} : { snapshot_error: refused.error }),
    };
    delete report.execution_snapshot;
    return report as NikaCheckResult;
  }

  private async json(
    path: string,
    init: RequestInit,
    authenticated = true,
    acceptedStatuses: readonly number[] = [200],
    operation?: NikaOperation,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchResponse(path, init, true, authenticated, false);
    if (!acceptedStatuses.includes(response.status)) {
      if (response.ok) {
        await discardResponse(response);
        throw new NikaProtocolError(
          this.kind,
          `HTTP ${path} returned non-contract status ${response.status}`,
        );
      }
      // A refusal the server typed as `{ error: { code, message } }` keeps its
      // code. The message is engine-owned and already path-free; the bearer
      // token is redacted defensively in case a hostile server echoes it.
      const refusal = operation === undefined
        ? undefined
        : await this.readRefusal(response, path);
      if (operation !== undefined && refusal) {
        throw new NikaOperationError(
          operation,
          this.kind,
          refusal.code,
          `HTTP ${response.status} for ${path}: ${refusal.code}`
          + (refusal.message ? ` (${refusal.message})` : ''),
          { status: response.status, machineCode: refusal.code },
        );
      }
      await discardResponse(response);
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

  /**
   * Read a non-2xx body only when the server typed it as an engine refusal.
   * Anything else (plain text, oversized, malformed, a code that is not a
   * plain identifier, a code that carries the bearer token) is discarded and
   * the caller falls back to the redacted transport error.
   */
  private async readRefusal(
    response: Response,
    path: string,
  ): Promise<{ code: string; message?: string } | undefined> {
    const contentType = response.headers
      .get('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      await discardResponse(response);
      return undefined;
    }
    let object: Record<string, unknown>;
    try {
      object = await this.readObservationObject(response, path);
    } catch {
      return undefined;
    }
    const error = machineObject(object.error);
    const code = error?.code;
    if (
      typeof code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(code)
      || code.includes(this.options.token)
    ) {
      return undefined;
    }
    const message = typeof error?.message === 'string' && error.message.length > 0
      ? this.redact(error.message)
      : undefined;
    return { code, ...(message ? { message } : {}) };
  }

  /** Engine messages are already path-free; a reflected bearer token never survives. */
  private redact(text: string): string {
    const clean = text
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .split(this.options.token)
      .join('[REDACTED]');
    return clean.length > 240 ? `${clean.slice(0, 240)}...` : clean;
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

function isContainedWorkflowName(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('.nika.yaml')) return false;
  try {
    workflowPath(value);
    return true;
  } catch {
    return false;
  }
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
  if (operation === 'schedule') return 'schedule apply';
  if (operation === 'scheduleStatus') return 'schedule status';
  return operation;
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
    ...(typeof value.execution_id === 'string'
      ? { execution_id: value.execution_id as NikaExecutionId }
      : {}),
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
  expectedSnapshotDigest?: string,
): void {
  const allowed = new Set([
    'job_id', 'execution_id', 'trace_id', 'snapshot_digest', 'origin', 'chain_head',
  ]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    throw new NikaProtocolError(transport, 'Receipt contained unknown fields');
  }
  if (receipt.job_id !== expectedJobId) {
    throw new NikaProtocolError(transport, 'Receipt job identity did not match its run');
  }
  if (typeof receipt.execution_id !== 'string' || receipt.execution_id.length === 0) {
    throw new NikaProtocolError(transport, 'Receipt omitted its execution identity');
  }
  if (typeof receipt.trace_id !== 'string' || receipt.trace_id.length === 0) {
    throw new NikaProtocolError(transport, 'Receipt omitted its trace identity');
  }
  if (
    typeof receipt.snapshot_digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.snapshot_digest)
  ) {
    throw new NikaProtocolError(transport, 'Receipt omitted its canonical snapshot digest');
  }
  if (
    receipt.chain_head !== undefined
    && (typeof receipt.chain_head !== 'string' || receipt.chain_head.length === 0)
  ) {
    throw new NikaProtocolError(transport, 'Receipt chain head was malformed');
  }
  if (receipt.origin !== undefined) validateReceiptOrigin(receipt.origin, transport);
  if (expectedExecutionId !== undefined && receipt.execution_id !== expectedExecutionId) {
    throw new NikaProtocolError(transport, 'Receipt execution identity did not match its job');
  }
  if (expectedTraceId !== undefined && receipt.trace_id !== expectedTraceId) {
    throw new NikaProtocolError(transport, 'Receipt trace identity did not match its job');
  }
  if (
    expectedSnapshotDigest !== undefined
    && receipt.snapshot_digest !== expectedSnapshotDigest
  ) {
    throw new NikaProtocolError(transport, 'Receipt snapshot digest did not match its admission');
  }
}

function snapshotIdentity(bytes: string, transport: 'http'): SnapshotIdentity {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (cause) {
    throw new NikaCompatibilityError(
      'executionSnapshot',
      transport,
      'Local engine emitted malformed execution_snapshot bytes',
    );
  }
  const snapshot = machineObject(value);
  if (
    !snapshot
    || typeof snapshot.digest !== 'string'
    || !/^[0-9a-f]{64}$/.test(snapshot.digest)
    || typeof snapshot.root !== 'string'
    || snapshot.root.length === 0
    || !Array.isArray(snapshot.units)
    || snapshot.units.length < 1
  ) {
    throw new NikaCompatibilityError(
      'executionSnapshot',
      transport,
      'Local engine emitted an invalid execution_snapshot identity',
    );
  }
  return { digest: snapshot.digest, root: snapshot.root, units: snapshot.units.length };
}

function validateReceiptOrigin(value: unknown, transport: 'http'): void {
  const origin = machineObject(value);
  if (!origin || typeof origin.kind !== 'string') {
    throw new NikaProtocolError(transport, 'Receipt origin was malformed');
  }
  if (origin.kind === 'manual') {
    if (Object.keys(origin).some((key) => key !== 'kind')) {
      throw new NikaProtocolError(transport, 'Manual receipt origin contained unknown fields');
    }
    return;
  }
  const required = [
    'kind', 'schedule_origin', 'schedule_id', 'schedule_revision', 'slot_id',
    'decision', 'scheduled_for', 'fired_at', 'arm_generation',
  ];
  if (
    origin.kind !== 'schedule'
    || Object.keys(origin).some((key) => !required.includes(key))
    || required.some((key) => !Object.hasOwn(origin, key))
    || !['project', 'api'].includes(String(origin.schedule_origin))
    || !['scheduled', 'catch_up'].includes(String(origin.decision))
    || required.slice(2).some((key) => typeof origin[key] !== 'string' || origin[key].length === 0)
    || Buffer.byteLength(String(origin.schedule_id)) > 255
    || !/^sha256:[0-9a-f]{64}$/.test(String(origin.schedule_revision))
    || !/^[0-9a-f]{64}$/.test(String(origin.slot_id))
    || !/^[0-9a-f]{64}$/.test(String(origin.arm_generation))
    || !isCanonicalTimestamp(String(origin.scheduled_for))
    || !isCanonicalTimestamp(String(origin.fired_at))
  ) {
    throw new NikaProtocolError(transport, 'Scheduled receipt origin was malformed');
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetSign ? Number(offsetHourText) : 0;
  const offsetMinute = offsetSign ? Number(offsetMinuteText) : 0;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= days[month - 1]!
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}
