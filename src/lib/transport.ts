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
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
  NikaWorkflowMetadata,
} from '../types.js';

export interface TransportRun {
  readonly id: string;
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
}
