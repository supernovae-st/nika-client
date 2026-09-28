import type {
  NikaCostReview,
  NikaCostReviewV2,
  NikaCostReviewResultV2,
  NikaCostReviewRequest,
  NikaCostReviewDecision,
  NikaCostReviewOptions,
  NikaCostReviewResult,
  NikaPrepareCostReviewOptions,
  NikaCompileRequest,
  NikaCompileOptions,
  NikaCompileResult,
  NikaCancelResult,
  NikaAttachRunOptions,
  NikaCheckOptions,
  NikaCheckResult,
  NikaEvent,
  NikaReceipt,
  NikaRunId,
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
import type { NikaEngineIdentity } from './engine-identity.js';

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
  serverIdentity(): Promise<NikaEngineIdentity>;
  compile(request: NikaCompileRequest, options: NikaCompileOptions): Promise<NikaCompileResult>;
  prepareCostReview(request: NikaCostReviewRequest, options: NikaPrepareCostReviewOptions): Promise<NikaCostReviewResult | NikaCostReviewResultV2>;
  costReview(id: string, options: NikaCostReviewOptions): Promise<NikaCostReview | NikaCostReviewV2>;
  decideCostReview(id: string, decision: NikaCostReviewDecision, options: NikaCostReviewOptions): Promise<NikaCostReview | NikaCostReviewV2>;
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
