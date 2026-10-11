import type {
  NikaCancelResult,
  NikaAttachRunOptions,
  NikaCheckOptions,
  NikaCheckResult,
  NikaCompileOptions,
  NikaCompileOutcome,
  NikaCompileRequest,
  NikaEvent,
  NikaReceipt,
  NikaRunId,
  NikaRunOptions,
  NikaRunResult,
  NikaRunStatus,
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaSessionOptions,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
  NikaWorkflowMetadata,
} from '../types.js';
import type { SessionChannel } from './session-host.js';

export interface TransportRun {
  readonly id: NikaRunId;
  readonly events: AsyncIterable<NikaEvent>;
  readonly done: Promise<NikaRunResult>;
  status(): Promise<NikaRunStatus>;
  cancel(): Promise<NikaCancelResult>;
  cleanup(): Promise<void>;
}

/** The adapter boundary. It has exactly the native-process and HTTP implementations. */
export interface Transport {
  readonly kind: NikaTransportKind;
  check(workflow: string, options: NikaCheckOptions): Promise<NikaCheckResult>;
  compile(request: NikaCompileRequest, options: NikaCompileOptions): Promise<NikaCompileOutcome>;
  startRun(workflow: string, options: NikaRunOptions): Promise<TransportRun>;
  attachRun(id: string, options: NikaAttachRunOptions): Promise<TransportRun>;
  listWorkflows(): Promise<readonly string[]>;
  workflow(name: string): Promise<NikaWorkflowMetadata>;
  schedule(workflow: string, options: NikaScheduleOptions): Promise<NikaScheduleApplyResult>;
  scheduleStatus(id: string): Promise<NikaScheduleStatus>;
  traceVerify(
    receipt: NikaReceipt,
    options: NikaTraceVerifyOptions,
  ): Promise<NikaTraceVerifyResult>;
  /** Open the engine's authoring Session; `retention` bounds the events a native handle keeps. */
  openSession(options: NikaSessionOptions, retention: number): Promise<SessionChannel>;
  /** Attach to a live Session the door already holds (HTTP). */
  attachSession(id: string, options: NikaSessionOptions): Promise<SessionChannel>;
}
