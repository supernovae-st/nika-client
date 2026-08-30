import type {
  NikaOperation,
  NikaOperationFinding,
  NikaTransportKind,
} from './types.js';

export class NikaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NikaError';
  }
}

export class NikaConfigurationError extends NikaError {
  constructor(message: string) {
    super(message);
    this.name = 'NikaConfigurationError';
  }
}

export class NikaTransportError extends NikaError {
  readonly transport: NikaTransportKind;

  constructor(transport: NikaTransportKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NikaTransportError';
    this.transport = transport;
  }
}

/** A typed engine/adapter capability gap, not a workflow failure. */
export class NikaCompatibilityError extends NikaError {
  readonly capability: string;
  readonly transport: NikaTransportKind;

  constructor(
    capability: string,
    transport: NikaTransportKind,
    message: string,
  ) {
    super(message);
    this.name = 'NikaCompatibilityError';
    this.capability = capability;
    this.transport = transport;
  }
}

export class NikaProtocolError extends NikaTransportError {
  constructor(transport: NikaTransportKind, message: string, options?: ErrorOptions) {
    super(transport, message, options);
    this.name = 'NikaProtocolError';
  }
}

/** One taxonomy for engine refusals returned by an SDK operation. */
export class NikaOperationError extends NikaError {
  readonly operation: NikaOperation;
  readonly code: string;
  readonly transport: NikaTransportKind;
  readonly status: number;
  readonly findings?: readonly NikaOperationFinding[];
  readonly currentRevision?: string | null;
  readonly machineCode?: string;

  constructor(
    operation: NikaOperation,
    transport: NikaTransportKind,
    code: string,
    message: string,
    details: {
      status: number;
      findings?: readonly NikaOperationFinding[];
      currentRevision?: string | null;
      machineCode?: string;
    },
  ) {
    super(message);
    this.name = 'NikaOperationError';
    this.operation = operation;
    this.code = code;
    this.transport = transport;
    this.status = details.status;
    this.findings = details.findings;
    this.currentRevision = details.currentRevision;
    this.machineCode = details.machineCode;
  }
}

export class NikaEventBufferOverflowError extends NikaError {
  readonly runId: string;
  readonly limit: number;

  constructor(runId: string, limit: number) {
    super(`Event subscriber for run ${runId} exceeded its ${limit}-event buffer`);
    this.name = 'NikaEventBufferOverflowError';
    this.runId = runId;
    this.limit = limit;
  }
}

export class NikaRunOwnershipError extends NikaError {
  constructor() {
    super('The NikaRun was not created by this Nika client');
    this.name = 'NikaRunOwnershipError';
  }
}
