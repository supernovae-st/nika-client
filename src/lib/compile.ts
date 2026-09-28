import { NikaProtocolError } from '../errors.js';
import type { NikaCompileOutcome } from '../types.js';
import { machineObject } from './machine.js';

/** Check the authoring envelope; preserve engine-owned evidence without inferring consent. */
export function readCompileOutcome(value: Record<string, unknown>): NikaCompileOutcome {
  const provenance = machineObject(value.provenance);
  const preview = machineObject(value.check_preview);
  const valid = (value.compile_version === 1 || value.compile_version === 2)
    && ['ready', 'incomplete', 'refused'].includes(String(value.status))
    && (value.candidate === null || typeof value.candidate === 'string')
    && (value.status !== 'ready' || (typeof value.candidate === 'string' && value.candidate.length > 0))
    && (value.check_preview === null || (preview?.scope === 'sourceOnly' && !!machineObject(preview.report)))
    && Array.isArray(value.diagnostics)
    && value.diagnostics.every((diagnostic) => {
      const d = machineObject(diagnostic);
      return d && ['applied', 'missed', 'unknown', 'requiresHuman', 'refused'].includes(String(d.kind))
        && typeof d.target === 'string' && typeof d.message === 'string';
    })
    && Array.isArray(value.questions)
    && value.questions.every((question) => {
      const q = machineObject(question);
      return q && typeof q.key === 'string' && typeof q.label === 'string'
        && typeof q.why === 'string' && typeof q.mandatory === 'boolean'
        && ['text', 'literal', 'choice'].includes(String(q.type))
        && (q.options === undefined || (Array.isArray(q.options) && q.options.every((option) => {
          const o = machineObject(option);
          return o && typeof o.key === 'string' && typeof o.label === 'string';
        })));
    })
    && (value.requested_boundary === null || !!machineObject(value.requested_boundary))
    && (value.requested_trigger === null || !!machineObject(value.requested_trigger))
    && typeof provenance?.compiler_version === 'string'
    && typeof provenance.spec_pin === 'string'
    && (provenance.skeleton === null || typeof provenance.skeleton === 'string')
    && (provenance.decision === undefined || !!machineObject(provenance.decision))
    && (provenance.plan === undefined || !!machineObject(provenance.plan))
    && (provenance.strategy === undefined || typeof provenance.strategy === 'string')
    && (provenance.suggested_file === undefined || provenance.suggested_file === null
      || typeof provenance.suggested_file === 'string')
    && (value.compile_version === 1
      ? provenance.cognition === 'deterministicOnly'
      : provenance.cognition === 'explicitProvider' && validAuthoring(provenance.authoring));
  if (!valid) throw new NikaProtocolError('http', 'HTTP compile returned an invalid authoring envelope');
  return value as unknown as NikaCompileOutcome;
}

function validAuthoring(value: unknown): boolean {
  const receipt = machineObject(value);
  if (!receipt) return false;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return typeof receipt.model === 'string'
    && count(receipt.calls) && (receipt.calls as number) >= 1
    && count(receipt.elapsed_ms)
    && (receipt.input_tokens === null || count(receipt.input_tokens))
    && (receipt.output_tokens === null || count(receipt.output_tokens))
    && !!machineObject(receipt.sampling)
    && Array.isArray(receipt.context) && receipt.context.every((item) => !!machineObject(item))
    && (receipt.backend === null || !!machineObject(receipt.backend));
}
