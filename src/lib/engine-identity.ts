import { NikaCompatibilityError } from '../errors.js';
import type { NikaTransportKind } from '../types.js';
import { machineObject } from './machine.js';

export const MACHINE_PROTOCOL_VERSION = 1;

export interface NikaEngineIdentity {
  engineVersion: string;
  machineProtocolVersion: number;
  snapshotFormatVersion: number;
  checkReportVersion: number;
  eventFormatVersion: number;
  traceFormatVersion?: number;
  supportedCapabilities: string[];
  [key: string]: unknown;
}

const REQUIRED_CAPABILITIES = ['check', 'executionSnapshot', 'eventStream'] as const;
const COMPATIBILITY_CLOCKS = [
  'machineProtocolVersion',
  'snapshotFormatVersion',
  'checkReportVersion',
  'eventFormatVersion',
] as const;

/** Validate one adapter identity and, when supplied, its peer's wire clocks. */
export function compatibleEngineIdentity(
  value: unknown,
  transport: NikaTransportKind,
  peer?: NikaEngineIdentity,
): NikaEngineIdentity {
  const identity = machineObject(value);
  if (!identity) throw incompatible(transport, 'Engine identity is not an object');
  if (typeof identity.engineVersion !== 'string' || identity.engineVersion.length === 0) {
    throw incompatible(transport, 'Engine identity is missing engineVersion');
  }
  for (const clock of COMPATIBILITY_CLOCKS) {
    if (!Number.isSafeInteger(identity[clock])) {
      throw incompatible(transport, `Engine identity is missing ${clock}`);
    }
  }
  if (identity.machineProtocolVersion !== MACHINE_PROTOCOL_VERSION) {
    throw incompatible(
      transport,
      `Engine machine protocol ${String(identity.machineProtocolVersion)} is incompatible with SDK protocol ${MACHINE_PROTOCOL_VERSION}`,
    );
  }
  if (
    !Array.isArray(identity.supportedCapabilities)
    || !identity.supportedCapabilities.every((item) => typeof item === 'string')
  ) {
    throw incompatible(transport, 'Engine identity is missing supportedCapabilities');
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!identity.supportedCapabilities.includes(capability)) {
      throw incompatible(transport, `Engine identity does not support ${capability}`);
    }
  }

  const checked = identity as NikaEngineIdentity;
  if (peer) {
    for (const clock of COMPATIBILITY_CLOCKS) {
      if (checked[clock] !== peer[clock]) {
        throw incompatible(
          transport,
          `Remote ${clock} ${checked[clock]} is incompatible with local ${clock} ${peer[clock]}`,
        );
      }
    }
  }
  return checked;
}

function incompatible(
  transport: NikaTransportKind,
  message: string,
): NikaCompatibilityError {
  return new NikaCompatibilityError('engineIdentity', transport, message);
}
