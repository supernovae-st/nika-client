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
  NikaAttachRunOptions,
  NikaCheckOptions,
  NikaCheckResult,
  NikaConfig,
  NikaEvent,
  NikaEventsOptions,
  NikaReceipt,
  NikaRun,
  NikaRunOptions,
  NikaRunStatus,
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
  NikaWorkflowMetadata,
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
        token: checkedToken(config.token),
        fetch: config.fetch ?? globalThis.fetch.bind(globalThis),
        requestTimeout: positiveInteger(
          config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT,
          'requestTimeout',
        ),
        machineBufferBytes,
        // Lazy: HTTP observation needs no local engine. Resolution (and its
        // typed NikaEngineUnavailable refusal) is deferred to caller-owned
        // source capture in check/run.
        resolveEngine: () => resolveNikaEngine(config.bin),
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

  /**
   * `Outputs` is the caller's projection of the engine-emitted outputs map;
   * the SDK transports outputs without validating their shape.
   */
  async run<Outputs extends Record<string, unknown> = Record<string, unknown>>(
    workflow: string,
    options: NikaRunOptions = {},
  ): Promise<NikaRun<Outputs>> {
    const source = await this.transport.startRun(workflowName(workflow), options);
    const session = new RunSession(source, this.eventBufferSize);
    this.sessions.set(session.run, session);
    return session.run as NikaRun<Outputs>;
  }

  /** Reattach this client process to an already-admitted durable HTTP job. */
  async attachRun<Outputs extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    options: NikaAttachRunOptions = {},
  ): Promise<NikaRun<Outputs>> {
    const lastEventId = options.lastEventId ?? 0;
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
      throw new RangeError('lastEventId must be a non-negative safe integer');
    }
    const source = await this.transport.attachRun(jobId(id), { lastEventId });
    const session = new RunSession(source, this.eventBufferSize);
    this.sessions.set(session.run, session);
    return session.run as NikaRun<Outputs>;
  }

  /** List contained workflow names from a resident HTTP authority. */
  listWorkflows(): Promise<readonly string[]> {
    return this.transport.listWorkflows();
  }

  /** Read path-free metadata for one contained workflow. */
  workflow(name: string): Promise<NikaWorkflowMetadata> {
    return this.transport.workflow(workflowName(name));
  }

  events<Outputs extends Record<string, unknown> = Record<string, unknown>>(
    run: NikaRun<Outputs>,
    options: NikaEventsOptions = {},
  ): AsyncIterable<NikaEvent<Outputs>> {
    return this.session(run).events(options) as AsyncIterable<NikaEvent<Outputs>>;
  }

  cancel(run: NikaRun): Promise<NikaCancelResult> {
    return this.session(run).cancel();
  }

  /** Read the current durable status without waiting for terminal settlement. */
  status(run: NikaRun): Promise<NikaRunStatus> {
    return this.session(run).status();
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
  if (url.protocol === 'http:') {
    if (!allowInsecureHttp) {
      throw new NikaConfigurationError(
        'Plain HTTP requires allowInsecureHttp: true; prefer HTTPS for remote engines',
      );
    }
    // The opt-in widens the scheme, never the destination: a bearer token
    // must not leave the host in plaintext.
    if (!isLoopbackHost(url.hostname)) {
      throw new NikaConfigurationError(
        'Plain HTTP is limited to loopback hosts (localhost, 127.0.0.0/8, [::1]); '
        + `use HTTPS for ${url.hostname}`,
      );
    }
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NikaConfigurationError('Nika URL cannot contain credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/$/, '');
}

const LOOPBACK_IPV4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV4_MAPPED_IPV6 = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/;

/**
 * `URL.hostname` is already normalized: IPv4 shorthand becomes a dotted quad,
 * IPv6 stays bracketed and compressed (`[::ffff:127.0.0.1]` -> `[::ffff:7f00:1]`).
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (LOOPBACK_IPV4.test(host)) return true;
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (literal === '::1') return true;
  const mapped = literal.match(IPV4_MAPPED_IPV6);
  return mapped !== null && Number.parseInt(mapped[1], 16) >>> 8 === 0x7f;
}

function checkedToken(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes < 32 || bytes > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new NikaConfigurationError(
      'Nika bearer token must be 32-512 visible ASCII bytes without whitespace',
    );
  }
  return value;
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

function jobId(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('job id must be a non-empty string');
  }
  return value;
}

export {
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaError,
  NikaEventBufferOverflowError,
  NikaObservationInterrupted,
  NikaOperationError,
  NikaProtocolError,
  NikaRunOwnershipError,
  NikaTransportError,
} from './errors.js';

export { NikaEngineUnavailable };

export {
  isNikaRunSealedEvent,
  isNikaRunSettledEvent,
} from './events.js';

export type {
  NikaCancelResult,
  NikaAttachRunOptions,
  NikaCheckOptions,
  NikaCheckResult,
  NikaConfig,
  NikaLocalConfig,
  NikaRemoteConfig,
  NikaEvent,
  NikaEventsOptions,
  NikaExecutionId,
  NikaJobId,
  NikaMachineError,
  NikaReceipt,
  NikaOperation,
  NikaOperationFinding,
  NikaRun,
  NikaRunId,
  NikaRunOptions,
  NikaRunResult,
  NikaRunSealedEvent,
  NikaRunSettledEvent,
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
  NikaTaskCompletedEvent,
  NikaTaskScheduledEvent,
  NikaTaskStartedEvent,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
  NikaUnknownEvent,
  NikaWorkflowCompletedEvent,
  NikaWorkflowFailedEvent,
  NikaWorkflowInterruptedEvent,
  NikaWorkflowMetadata,
  NikaWorkflowStartedEvent,
} from './types.js';
