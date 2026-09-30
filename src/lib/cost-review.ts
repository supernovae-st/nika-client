import { NikaProtocolError } from '../errors.js';
import type { NikaCostReview, NikaCostReviewV2, NikaCostReviewResult, NikaCostReviewResultV2 } from '../types.js';
import { machineObject } from './machine.js';

/** Select one explicit protocol before I/O; no automatic version negotiation. */
const PROTOCOLS = {
  1: { version: 1, capability: 'costReviewV1', create: '/v1/cost-reviews',
    read: (id: string) => `/v1/cost-reviews/${id}`,
    decide: (id: string) => `/v1/cost-reviews/${id}/decision` },
  2: { version: 2, capability: 'costReviewV2', create: '/v2/cost-reviews',
    read: (id: string) => `/v2/cost-reviews/${id}`,
    decide: (id: string) => `/v2/cost-reviews/${id}/decision` },
} as const;

export function costReviewProtocol(version: unknown = 1) {
  if (version !== 1 && version !== 2) throw new TypeError('cost review version must be 1 or 2');
  return PROTOCOLS[version];
}

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

export function readCostReviewResult(value: unknown, allowNotRequired: boolean, expectedId?: string, expectedVersion: 1 | 2 = 1): NikaCostReviewResult | NikaCostReviewResultV2 {
  const v = machineObject(value);
  if (!v || v.cost_review_version !== expectedVersion) throw malformed();
  if (v.review_required === false) {
    if (!allowNotRequired || typeof v.observer !== 'boolean' || !text(v.reason)
      || Object.keys(v).some(key => !['cost_review_version', 'review_required', 'observer', 'reason'].includes(key))) {
      throw malformed();
    }
    return v as unknown as NikaCostReviewResult | NikaCostReviewResultV2;
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
    || !integer(bounds.request_timeout_seconds, 1)
    || (expectedVersion === 1 ? bounds.retries !== 0 : !dispatchV2(v.dispatch, bounds))
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
  return v as unknown as NikaCostReview | NikaCostReviewV2;
}

// Read the wire's typed bound without reimplementing the engine's cost law.
function dispatchV2(value: unknown, bounds: Record<string, unknown>): boolean {
  const dispatch = machineObject(value);
  const closed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
  return bounds.transport_retries === 0 && integer(bounds.max_in_flight, 1)
    && (bounds.max_in_flight as number) <= (bounds.max_requests as number)
    && closed(bounds, ['max_requests', 'max_in_flight', 'max_output_tokens', 'request_timeout_seconds', 'transport_retries'])
    && dispatch !== undefined && dispatch !== null
    && closed(dispatch, ['requests', 'max_in_flight', 'authored_retry', 'tasks'])
    && dispatch.requests === bounds.max_requests && dispatch.max_in_flight === bounds.max_in_flight
    && typeof dispatch.authored_retry === 'boolean' && Array.isArray(dispatch.tasks)
    && dispatch.tasks.every(value => {
      const row = machineObject(value);
      return !!row && closed(row, ['task', 'items', 'attempts', 'calls_per_attempt', 'max_parallel', 'requests'])
        && text(row.task) && (row.items === null || integer(row.items))
        && integer(row.attempts, 1) && integer(row.calls_per_attempt, 1)
        && integer(row.max_parallel, 1) && integer(row.requests);
    });
}

function malformed(): NikaProtocolError {
  return new NikaProtocolError('http', 'HTTP cost review response was malformed or named another review');
}
