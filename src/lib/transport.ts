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
  traceVerify(
    receipt: NikaReceipt,
    options: NikaTraceVerifyOptions,
  ): Promise<NikaTraceVerifyResult>;
}
