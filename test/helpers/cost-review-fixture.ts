import type { NikaCostReview } from '../../src/index.js';

export const id = 'rev-12345678-1234-1234-1234-123456789abc';
export const hash = 'a'.repeat(64);
export const token = 'review-bearer-public-fixture-0123456789';
export const caps = ['check', 'executionSnapshot', 'eventStream', 'costReviewV1', 'jobInputs'];
export const request = { workflow: 'daily.nika', inputs: { customer: 'Élodie', count: 2, enabled: false }, access: 'default' };
export const review: NikaCostReview = {
  cost_review_version: 1, review_id: id, witness_sha256: hash, state: 'pending',
  created_at: '2026-09-28T00:00:00Z', expires_at: '2026-09-28T00:05:00Z',
  workflow: request.workflow, access: 'default', execution_id: 'execution-test',
  project: { root_fingerprint: null, basis: 'host-local, unauthenticated' },
  program: { snapshot_digest: hash, source_sha256: hash },
  inputs: { names: ['customer', 'count', 'enabled'], source: 'api_caller', sha256: hash },
  route: { provider: 'test', model: 'test', origin: 'https://example.invalid:443' },
  price: { state: 'unknown', native: 'unknown tariff' }, question: 'Authorize one bounded unknown-cost request?',
  bounds: { max_requests: 1, max_output_tokens: 50, request_timeout_seconds: 2, retries: 0 },
  defaults: { invocation_usd: null, project_usd: null, basis: 'no default' },
  host: { authority: 'operator_started_cost_review', evidence: {}, credential_custody: 'HOST_SERVER_MEMORY' },
  prior_journal: { length: 0, sha256: hash }, effects: ['write result'], grants: 'existing permit',
};
