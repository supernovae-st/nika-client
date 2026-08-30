import type {
  NikaCancelResult,
  NikaCheckOptions,
  NikaCheckResult,
  NikaEvent,
  NikaReceipt,
  NikaRunOptions,
  NikaRunResult,
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
} from '../types.js';

export interface TransportRun {
  readonly id: string;
  readonly events: AsyncIterable<NikaEvent>;
  readonly done: Promise<NikaRunResult>;
  cancel(): Promise<NikaCancelResult>;
  cleanup(): Promise<void>;
}

/** The adapter boundary. It has exactly the native-process and HTTP implementations. */
export interface Transport {
  readonly kind: NikaTransportKind;
  check(workflow: string, options: NikaCheckOptions): Promise<NikaCheckResult>;
  startRun(workflow: string, options: NikaRunOptions): Promise<TransportRun>;
  schedule(workflow: string, options: NikaScheduleOptions): Promise<NikaScheduleApplyResult>;
  scheduleStatus(id: string): Promise<NikaScheduleStatus>;
  traceVerify(
    receipt: NikaReceipt,
    options: NikaTraceVerifyOptions,
  ): Promise<NikaTraceVerifyResult>;
}
