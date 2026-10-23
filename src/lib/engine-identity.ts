import { NikaCompatibilityError } from '../errors.js';
import type { NikaTransportKind } from '../types.js';
import { machineObject } from './machine.js';

/**
 * The one machine-protocol generation this SDK speaks, in lockstep with the
 * engine it bundles. The engine raises it in the commit that changes an
 * object a published SDK reads closed (a key, an enum value), so that SDK
 * refuses the engine here, at identity (`nika --sdk-identity`, `GET /health`),
 * before any spawn or job, never in the middle of a run.
 *
 * Generation 2 (engine 0.123): a compile question may be `choice` with its
 * `options`, and a catch-up firing's receipt origin may name the silence it
 * answers for (`missed_first`, `missed_count`). An engine on generation 1
 * (0.122 and older) is refused with `NikaCompatibilityError`; it pairs with
 * the SDK release of its own train.
 */
export const MACHINE_PROTOCOL_VERSION = 2;

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
      `Engine ${identity.engineVersion} machine protocol ${String(identity.machineProtocolVersion)} `
      + `is incompatible with SDK protocol ${MACHINE_PROTOCOL_VERSION}; each SDK release speaks `
      + 'the protocol of the engine it bundles',
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
