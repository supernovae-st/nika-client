import {
  NikaConfigurationError,
  NikaRunOwnershipError,
} from './errors.js';
import { HttpTransport } from './lib/http-transport.js';
import { NativeProcessTransport } from './lib/native-process-transport.js';
import { NikaEngineUnavailable, resolveNikaEngine } from './lib/binary/index.js';
import { RunSession } from './lib/run-session.js';
import type { Transport } from './lib/transport.js';
import type {
  NikaCancelResult,
  NikaCheckOptions,
  NikaCheckResult,
  NikaConfig,
  NikaEvent,
  NikaEventsOptions,
  NikaReceipt,
  NikaRun,
  NikaRunOptions,
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
} from './types.js';

const DEFAULT_EVENT_BUFFER_SIZE = 256;
const DEFAULT_MACHINE_BUFFER_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT = 30_000;

/** One client surface for a local engine process or a live nika serve URL. */
export class Nika {
  readonly transportKind: NikaTransportKind;

  private readonly transport: Transport;
  private readonly sessions = new WeakMap<NikaRun, RunSession>();
  private readonly eventBufferSize: number;

  constructor(config: NikaConfig = {}) {
    this.eventBufferSize = positiveInteger(
      config.eventBufferSize ?? DEFAULT_EVENT_BUFFER_SIZE,
      'eventBufferSize',
    );
    const machineBufferBytes = positiveInteger(
      config.machineBufferBytes ?? DEFAULT_MACHINE_BUFFER_BYTES,
      'machineBufferBytes',
    );

    if (config.url !== undefined) {
      if (typeof config.token !== 'string' || config.token.length === 0) {
        throw new NikaConfigurationError('A non-empty token is required with a Nika URL');
      }
      const url = checkedUrl(config.url, config.allowInsecureHttp === true);
      this.transport = new HttpTransport({
        url,
        token: config.token,
        fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
        requestTimeout: positiveInteger(
          config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
          'requestTimeout',
        ),
        machineBufferBytes,
        engine: resolveNikaEngine(config.bin),
        cwd: config.cwd,
      });
    } else {
      const remoteOnly = config as NikaConfig & {
        token?: unknown;
        allowInsecureHttp?: unknown;
        requestTimeout?: unknown;
        fetch?: unknown;
      };
      if (
        remoteOnly.token !== undefined
        || remoteOnly.allowInsecureHttp !== undefined
        || remoteOnly.requestTimeout !== undefined
        || remoteOnly.fetch !== undefined
      ) {
        throw new NikaConfigurationError('token, allowInsecureHttp, requestTimeout, and fetch require url');
      }
      const engine = resolveNikaEngine(config.bin);
      this.transport = new NativeProcessTransport({
        engine,
        cwd: config.cwd,
        machineBufferBytes,
      });
    }
    this.transportKind = this.transport.kind;
  }

  check(workflow: string, options: NikaCheckOptions = {}): Promise<NikaCheckResult> {
    return this.transport.check(workflowName(workflow), options);
  }

  async run(workflow: string, options: NikaRunOptions = {}): Promise<NikaRun> {
    const source = await this.transport.startRun(workflowName(workflow), options);
    const session = new RunSession(source, this.eventBufferSize);
    this.sessions.set(session.run, session);
    return session.run;
  }

  events(run: NikaRun, options: NikaEventsOptions = {}): AsyncIterable<NikaEvent> {
    return this.session(run).events(options);
  }

  cancel(run: NikaRun): Promise<NikaCancelResult> {
    return this.session(run).cancel();
  }

  schedule(
    workflow: string,
    options: NikaScheduleOptions,
  ): Promise<NikaScheduleApplyResult> {
    scheduleId(options?.id);
    return this.transport.schedule(workflowName(workflow), options);
  }

  scheduleStatus(id: string): Promise<NikaScheduleStatus> {
    return this.transport.scheduleStatus(scheduleId(id));
  }

  traceVerify(
    receipt: NikaReceipt,
    options: NikaTraceVerifyOptions = {},
  ): Promise<NikaTraceVerifyResult> {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new TypeError('traceVerify() accepts an engine-issued NikaReceipt object only');
    }
    return this.transport.traceVerify(receipt, options);
  }

  private session(run: NikaRun): RunSession {
    const session = this.sessions.get(run);
    if (!session) throw new NikaRunOwnershipError();
    return session;
  }
}

function checkedUrl(value: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NikaConfigurationError(`Invalid Nika URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new NikaConfigurationError('Nika URL must use https: or http:');
  }
  if (url.protocol === 'http:' && !allowInsecureHttp) {
    throw new NikaConfigurationError(
      'Plain HTTP requires allowInsecureHttp: true; prefer HTTPS for remote engines',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NikaConfigurationError('Nika URL cannot contain credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/$/, '');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new NikaConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

function workflowName(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('workflow must be a non-empty string');
  }
  return value;
}

function scheduleId(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('schedule id must be a non-empty string');
  }
  return value;
}

export {
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaError,
  NikaEventBufferOverflowError,
  NikaOperationError,
  NikaProtocolError,
  NikaRunOwnershipError,
  NikaTransportError,
} from './errors.js';

export { NikaEngineUnavailable };

export type {
  NikaCancelResult,
  NikaCheckOptions,
  NikaCheckResult,
  NikaConfig,
  NikaLocalConfig,
  NikaRemoteConfig,
  NikaEvent,
  NikaEventsOptions,
  NikaMachineError,
  NikaReceipt,
  NikaOperation,
  NikaOperationFinding,
  NikaRun,
  NikaRunOptions,
  NikaRunResult,
  NikaRunStatus,
  NikaScheduleAfterSkip,
  NikaScheduleApplyResult,
  NikaScheduleClaim,
  NikaScheduleDefinition,
  NikaScheduleDue,
  NikaScheduleFinding,
  NikaScheduleLastDecision,
  NikaScheduleMissed,
  NikaScheduleOptions,
  NikaScheduleOverlap,
  NikaSchedulePause,
  NikaScheduleSlot,
  NikaScheduleStatus,
  NikaScheduleWhen,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
} from './types.js';
