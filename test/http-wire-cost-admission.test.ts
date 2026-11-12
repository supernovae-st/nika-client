import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError, isNikaRunSucceeded } from '../src/index.js';
import type { NikaRunEvent, NikaSettlement } from '../src/index.js';
import { TOKEN_A, healthResponse, jsonResponse, sseResponse } from './helpers/http-depth-harness.js';

// Engine 0.124.4: a server its operator started with `nika serve --cost-policy`
// admits a Run on an API route the catalog does not price under a standing
// rule, and says so inside the job's settlement: `cost_admission`, the closed
// `nika/cost-admission@1` object. `Job` and `JobEvent` gain no key, because
// this package closes both and reads a settlement open.
//
// The capability list is the one the released 0.124.4 binary answers on
// `/health` when it is started with one rule. The admission is contract-shaped:
// hand-built from the `CostAdmission` schema that server serves on
// `GET /v1/openapi.json`, with placeholder identities. No engine wrote it and
// no provider was called. It pins how this package reads that wire, not what a
// release writes: recapture it from a job a rule admitted.

const JOB = 'job-1';
const CAPABILITIES = [
  'check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'artifacts',
  'accessServiceTier', 'accessSessionOffer', 'schedule', 'costStandingPolicyV1',
];
const RECEIPT = Object.freeze({
  job_id: JOB,
  execution_id: 'exe-1',
  trace_id: 'trace-1',
  snapshot_digest: 'a'.repeat(64),
  origin: { kind: 'manual' },
});
const COST_ADMISSION = Object.freeze({
  schema: 'nika/cost-admission@1',
  authority: 'standing_policy',
  price: 'unknown',
  choice: {
    candidate: 'c'.repeat(64),
    invocation: 'exe-1',
    provider: 'example',
    model: 'example-model',
    origin: null,
    max_requests: 4,
    max_output_tokens: 4096,
    timeout_ms: 120_000,
    declared_tariff: null,
    standing: { policy: 'rule-1', max_runs: 200, window_seconds: 86_400 },
  },
  host: {
    allowed: true,
    policy: { class: 'observed', origin: 'the standing cost policy', cap: 'absent' },
    machine: { class: 'observed', origin: 'no per-run ceiling', cap: 'absent' },
    occurrence: { class: 'not_applicable', origin: 'a manual job' },
  },
});
// One call whose cost is unknown: counted unpriced, never as zero.
const SETTLEMENT: NikaSettlement = Object.freeze({
  cause: 'normal',
  elapsed_ms: 41,
  spend: { priced_calls: 0, qualifier: 'unpriced', unpriced_calls: 1 },
  status: 'succeeded',
  tasks: { cancelled: 0, failed: 0, never_started: 0, ok: 1, recovered: 0, skipped: 0, total: 1 },
  cost_admission: COST_ADMISSION,
});
const STARTED = { sequence: 1, kind: 'execution.started', status: 'running' };
const SETTLED = {
  sequence: 2,
  kind: 'execution.settled',
  status: 'succeeded',
  outputs: { answer: 'ok' },
  receipt: RECEIPT,
  settlement: SETTLEMENT,
};
const DURABLE = {
  id: JOB,
  status: 'succeeded',
  execution_id: RECEIPT.execution_id,
  trace_id: RECEIPT.trace_id,
  outputs: { answer: 'ok' },
  receipt: RECEIPT,
  settlement: SETTLEMENT,
};

function remote(fetch: ReturnType<typeof vi.fn>): Nika {
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, fetch: fetch as typeof globalThis.fetch });
}

function standingHealth(): Response {
  return healthResponse({ engineVersion: '0.124.4', supportedCapabilities: CAPABILITIES });
}

/** A run by served name on a server that holds a policy, whose stream is exactly `frames`. */
function observed(frames: Record<string, unknown>[]) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(standingHealth())
    .mockResolvedValueOnce(jsonResponse({ id: JOB, status: 'queued' }, 202))
    .mockResolvedValueOnce(sseResponse(frames as never));
  return remote(fetch).run('flow.nika', { idempotencyKey: 'standing-rule' });
}

/** Reattach to a job whose durable record is already terminal: settled from GET alone. */
function attached(durable: Record<string, unknown>) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(standingHealth())
    .mockResolvedValueOnce(jsonResponse(durable));
  return remote(fetch).attachRun(JOB);
}

describe('the cost admission a 0.124.4 server nests in a settlement (`cost_admission`)', () => {
  it('passes identity beside `costStandingPolicyV1` and keeps the admission whole on the result', async () => {
    const run = await observed([STARTED, SETTLED]);
    const events: NikaRunEvent[] = [];
    for await (const event of run.events()) events.push(event);
    expect(events.map((event) => event.kind)).toEqual(['run.started', 'run.settled']);
    // The protocol frame keeps the settlement the server nested, untouched.
    expect(events.at(-1)!.raw.settlement).toEqual(SETTLEMENT);

    const result = await run.result();
    expect(result.status).toBe('succeeded');
    expect(isNikaRunSucceeded(result)).toBe(true);
    expect(result.outputs).toEqual({ answer: 'ok' });
    expect(result.receipt).toEqual(RECEIPT);
    expect(result.settlement).toEqual(SETTLEMENT);
    // Untyped: the package names no member of it, and changes none.
    expect(result.settlement?.cost_admission).toEqual(COST_ADMISSION);
    expect(result.settlement?.spend).toEqual({ priced_calls: 0, qualifier: 'unpriced', unpriced_calls: 1 });
  });

  it('reads the same admission from the durable job on attach', async () => {
    const result = await (await attached(DURABLE)).result();
    expect(result).toMatchObject({ id: JOB, status: 'succeeded', execution_id: 'exe-1', trace_id: 'trace-1' });
    expect(result.settlement).toEqual(SETTLEMENT);
    expect(result.settlement?.cost_admission).toEqual(COST_ADMISSION);
  });

  it('still refuses the admission beside the settlement: both projections stay closed', async () => {
    const { cost_admission: _admission, ...plain } = SETTLEMENT;
    const run = await observed([{ ...SETTLED, sequence: 1, settlement: plain, cost_admission: COST_ADMISSION }]);
    const failure = await run.result().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message).toContain('SSE data contained fields outside the public projection');

    const refused = await attached({ ...DURABLE, settlement: plain, cost_admission: COST_ADMISSION })
      .catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect((refused as Error).message).toContain('Durable job response contained unknown fields');
  });
});
