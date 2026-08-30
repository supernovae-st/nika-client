import type { NikaTransportKind } from './types.js';

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
