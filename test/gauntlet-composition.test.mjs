import assert from 'node:assert/strict';
import { test } from 'vitest';
import { exerciseIncident } from '../gauntlet/projects-depth/incident-response-controller/app.mjs';
import { stableDepthEvidence, stableHostileEvidence } from '../scripts/verify-release-replay.mjs';

test('controlled incident output satisfies the current replay judge without changing its cancellation contract', async () => {
  const settlement = { status: 'cancelled', cause: 'operator', elapsed_ms: 9,
    tasks: { total: 2, ok: 1, failed: 0, recovered: 0, skipped: 0, cancelled: 1, never_started: 1 },
    spend: { pricing_as_of: null, total_cost_usd: null, qualifier: 'unmetered' } };
  const result = { id: 'controlled-job', status: 'cancelled', settlement, receipt: { trace_id: 'controlled-trace' } };
  const event = { kind: 'execution.settled', status: 'cancelled', settlement, receipt: result.receipt };
  const action = Promise.resolve({ accepted: true, status: 'cancellation_requested' });
  let release;
  const held = new Promise((resolve) => { release = () => resolve(result); });
  const controlled = { id: result.id, done: held };
  const workflows = [];
  const client = {
    check: async () => ({ clean: true }),
    run: async (workflow) => {
      workflows.push(workflow);
      if (workflow === 'controlled-cancel.nika.yaml') return controlled;
      assert.equal(workflow, 'workflow.nika.yaml');
      return { done: Promise.resolve({ status: 'succeeded', outputs: {
        plan: { incident: { id: 'inc-2042' }, breached: 3 },
        completion: { state: 'reassessed' }, plan_digest: 'a'.repeat(64),
      } }) };
    },
    cancel: () => action,
    async *events(run) { await run.done; yield structuredClone(event); },
    attachRun: async (id) => { assert.equal(id, result.id); return controlled; },
    traceVerify: async () => ({ verified: true, verdict: 'sealed', reason: 'sealed',
      trace_id: result.receipt.trace_id, exit: 0, chain: { headline: 'intact' } }),
  };
  const gate = { arm() {}, arrived: Promise.resolve(), release: async () => release(),
    finish: () => ({ requests: { hold: 1, dependent: 0 } }) };
  const project = await exerciseIncident(client, gate);
  assert.deepEqual(workflows, ['workflow.nika.yaml', 'controlled-cancel.nika.yaml']);
  assert.equal(project.sse_terminal.settlement_cause, 'operator');
  assert.equal(project.settlement.spend.pricing_as_of, null);
  assert.doesNotThrow(() => stableDepthEvidence({ projects: [project] }));
  const missingCause = structuredClone(project);
  delete missingCause.sse_terminal.settlement_cause;
  assert.throws(() => stableDepthEvidence({ projects: [missingCause] }), /exact cancellation terminal/);
});

test('main interruption evidence stays valid independently of supplementary controlled cancellation', () => {
  const report = { schema_version: 1, engine: 'synthetic-fixture', summary: {}, result: 'green',
    scenarios: [{ name: 'remote-durable-cancellation', result: 'green', evidence: {
      cancel_status: 'cancellation_requested', run_status: 'interrupted',
      events: [{ kind: 'execution.interrupted', status: 'interrupted' }],
      controlled_cancellation: { run_status: 'cancelled', settlement: { cause: 'operator' } },
    } }] };
  assert.doesNotThrow(() => stableHostileEvidence(report));
  const falseSettlement = structuredClone(report);
  falseSettlement.scenarios[0].evidence.events[0].settlement_cause = 'operator';
  assert.throws(() => stableHostileEvidence(falseSettlement), /exact terminal frame/);
});
