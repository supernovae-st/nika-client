import { NikaProtocolError } from '../errors.js';
import type { NikaCostReview, NikaCostReviewResult } from '../types.js';
import { machineObject } from './machine.js';

const SHA = /^[0-9a-f]{64}$/;
const ID = /^rev-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES = new Set(['pending', 'approved', 'declined', 'expired', 'admitting', 'consumed', 'refused', 'failed']);
const CUSTODY = new Set(['LOCAL_PROCESS', 'HOST_SERVER_MEMORY', 'MANAGED_SECRET_STORE', 'REMOTE_PROVIDER', 'UNKNOWN']);
const text = (v: unknown): v is string => typeof v === 'string';
const nullableText = (v: unknown): boolean => v === null || text(v);
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(text);
const integer = (v: unknown, min = 0): boolean => Number.isSafeInteger(v) && (v as number) >= min;
const hash = (v: unknown): boolean => text(v) && SHA.test(v);
const date = (v: unknown): boolean => text(v) && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));

export function costReviewId(value: unknown): string {
  if (!text(value) || !ID.test(value)) throw new TypeError('cost review id must be an engine-issued rev-UUID');
  return value;
}

export function reviewWitness(value: unknown): void {
  if (!hash(value)) throw new TypeError('cost review witness must be a lowercase SHA-256');
}

export function reviewReference(value: unknown): void {
  const ref = machineObject(value);
  if (!ref || Object.keys(ref).some(key => key !== 'review_id' && key !== 'witness_sha256')) {
    throw new TypeError('costReview must contain only review_id and witness_sha256');
  }
  costReviewId(ref.review_id);
  reviewWitness(ref.witness_sha256);
}

/** One admission attempt only; the caller owns any explicit replay. */
export function admissionKey(value: string): string {
  if (!text(value) || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 255
    || /[\x00-\x20\x7f-\uffff]/.test(value)) {
    throw new TypeError('Idempotency-Key must be 1-255 visible ASCII bytes');
  }
  return value;
}

export function readCostReviewResult(value: unknown, allowNotRequired: boolean, expectedId?: string): NikaCostReviewResult {
  const v = machineObject(value);
  if (!v || v.cost_review_version !== 1) throw malformed();
  if (v.review_required === false) {
    if (!allowNotRequired || typeof v.observer !== 'boolean' || !text(v.reason)
      || Object.keys(v).some(key => !['cost_review_version', 'review_required', 'observer', 'reason'].includes(key))) {
      throw malformed();
    }
    return v as unknown as NikaCostReviewResult;
  }
  const project = machineObject(v.project);
  const program = machineObject(v.program);
  const inputs = machineObject(v.inputs);
  const route = machineObject(v.route);
  const price = machineObject(v.price);
  const bounds = machineObject(v.bounds);
  const defaults = machineObject(v.defaults);
  const host = machineObject(v.host);
  const journal = machineObject(v.prior_journal);
  if (!text(v.review_id) || !ID.test(v.review_id) || (expectedId !== undefined && v.review_id !== expectedId)
    || !hash(v.witness_sha256) || !text(v.state) || !STATES.has(v.state)
    || !date(v.created_at) || !date(v.expires_at) || (v.decided_at !== undefined && !date(v.decided_at))
    || !text(v.workflow) || v.workflow.length === 0 || !nullableText(v.access) || !text(v.execution_id)
    || !project || !nullableText(project.root_fingerprint) || !text(project.basis)
    || !program || !text(program.snapshot_digest) || !hash(program.source_sha256)
    || !inputs || !strings(inputs.names) || inputs.source !== 'api_caller' || !hash(inputs.sha256)
    || !route || !text(route.provider) || !text(route.model) || !text(route.origin)
    || !price || price.state !== 'unknown' || !text(price.native) || !text(v.question)
    || !bounds || !integer(bounds.max_requests, 1) || !integer(bounds.max_output_tokens, 1)
    || !integer(bounds.request_timeout_seconds, 1) || bounds.retries !== 0
    || !defaults || !nullableText(defaults.invocation_usd) || !nullableText(defaults.project_usd) || !text(defaults.basis)
    || !host || host.authority !== 'operator_started_cost_review' || !machineObject(host.evidence)
    || !text(host.credential_custody) || !CUSTODY.has(host.credential_custody)
    || !journal || !integer(journal.length) || !hash(journal.sha256)
    || !strings(v.effects) || !text(v.grants)) throw malformed();
  if (v.job !== undefined) {
    const job = machineObject(v.job);
    if (!job || !text(job.id) || job.id.length === 0) throw malformed();
  }
  if (v.refusal !== undefined) {
    const refusal = machineObject(v.refusal);
    if (!refusal || !text(refusal.code) || !text(refusal.message)) throw malformed();
  }
  if (v.account !== undefined) {
    const account = machineObject(v.account);
    if (!account || !integer(account.attempts) || !integer(account.marked_sent)
      || !integer(account.unknown_charge_attempts) || !text(account.state)
      || account.basis !== 'admission-account accounting, not proof of physical dispatch') throw malformed();
  }
  return v as unknown as NikaCostReview;
}

function malformed(): NikaProtocolError {
  return new NikaProtocolError('http', 'HTTP cost review response was malformed or named another review');
}
