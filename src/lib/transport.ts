import type {
  NikaArtifact,
  NikaArtifactDownload,
  NikaArtifactDownloadOptions,
  NikaArtifactManifest,
  NikaArtifactReadOptions,
  NikaArtifactsOptions,
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
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
  NikaWorkflowMetadata,
} from '../types.js';

export interface TransportRun {
  readonly id: NikaRunId;
  readonly events: AsyncIterable<NikaEvent>;
  readonly done: Promise<NikaRunResult>;
  status(): Promise<NikaRunStatus>;
  cancel(): Promise<NikaCancelResult>;
  /** The settled job's artifact manifest; a native run refuses with a typed gap. */
  artifacts(options: NikaArtifactsOptions): Promise<NikaArtifactManifest>;
  /** One artifact's verified stream; a native run refuses with a typed gap. */
  downloadArtifact(
    artifact: string | NikaArtifact,
    options: NikaArtifactDownloadOptions,
  ): Promise<NikaArtifactDownload>;
  /** One artifact's proven bytes, bounded; a native run refuses with a typed gap. */
  readArtifact(artifact: string | NikaArtifact, options: NikaArtifactReadOptions): Promise<Uint8Array>;
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
}
