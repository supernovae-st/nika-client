import assert from 'node:assert/strict';
import { test } from 'vitest';
import { cancelHeldRun } from '../scripts/gauntlet-cancellation.mjs';

function fixture({ resultChange, eventChange, actionStatus = 'cancellation_requested', arrivalError } = {}) {
  const order = [];
  const settlement = { status: 'cancelled', cause: 'operator', elapsed_ms: 31,
    tasks: { total: 2, ok: 1, failed: 0, recovered: 0, skipped: 0, cancelled: 1, never_started: 1 },
    spend: { total_cost_usd: null, priced_calls: 0, unpriced_calls: 0, qualifier: 'unmetered' } };
  const result = { id: 'same-run', status: 'cancelled', settlement };
  const event = { kind: 'execution.settled', status: 'cancelled', settlement: structuredClone(settlement) };
  resultChange?.(result);
  eventChange?.(event);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const run = { id: 'same-run', done: held.then(() => result) };
  const gate = {
    arrived: arrivalError ? Promise.reject(new Error('rendezvous missing')) : Promise.resolve(),
    async release() { order.push('release'); release(); },
    finish() { order.push('finish'); return { requests: { hold: 1, dependent: 0 } }; },
  };
  const action = Promise.resolve({ accepted: true, status: actionStatus });
  const client = {
    cancel() { order.push('cancel'); return action; },
    async *events(_run, { signal }) {
      await new Promise((resolve) => {
        const aborted = () => resolve();
        signal.addEventListener('abort', aborted, { once: true });
        held.then(() => { signal.removeEventListener('abort', aborted); resolve(); });
        if (signal.aborted) aborted();
      });
      if (!signal.aborted) yield event;
    },
  };
  return { client, run, gate, order };
}

test('older gauntlets acknowledge the action before releasing a real held task', async () => {
  const f = fixture();
  const proof = await cancelHeldRun(f.client, f.run, f.gate);
  assert.deepEqual(f.order, ['cancel', 'cancel', 'release', 'finish']);
  assert.equal(proof.result.status, 'cancelled');
  assert.equal(proof.cancellation.status, 'cancellation_requested');
  assert.equal(proof.events.at(-1).settlement.elapsed_ms, 31);
});

test.each(['succeeded', 'failed'])('older gauntlets reject fabricated cancellation over an actual %s event', async (status) => {
  const f = fixture({ eventChange(event) { event.status = status; event.settlement.status = status; } });
  await assert.rejects(cancelHeldRun(f.client, f.run, f.gate), /same-job/);
});

test.each([
  (result) => { delete result.settlement; },
  (result) => { result.settlement.tasks.never_started = 0; },
  (result) => { result.settlement.elapsed_ms = 0; },
])('older gauntlets reject missing, weakened or altered terminal facts', async (resultChange) => {
  const f = fixture({ resultChange });
  await assert.rejects(cancelHeldRun(f.client, f.run, f.gate));
});

test('an obsolete cancelled action status never releases the held task', async () => {
  const f = fixture({ actionStatus: 'cancelled' });
  await assert.rejects(cancelHeldRun(f.client, f.run, f.gate), /cancellation_requested/);
  assert(!f.order.includes('release'));
});

test('a missing rendezvous fails instead of issuing cancellation on a timer', async () => {
  const f = fixture({ arrivalError: true });
  await assert.rejects(cancelHeldRun(f.client, f.run, f.gate), /rendezvous missing/);
  assert.deepEqual(f.order, []);
});

test('depth incident proof preserves the original project workflow and rejects a failed plan', async () => {
  const { exerciseIncident } = await import('../gauntlet/projects-depth/incident-response-controller/app.mjs');
  const called = [];
  const client = {
    async check(workflow) { called.push(workflow); return { clean: true }; },
    async run(workflow) { called.push(workflow); return { done: Promise.resolve({ status: 'failed' }) }; },
  };
  await assert.rejects(exerciseIncident(client, { arm() { throw new Error('must validate original workflow first'); } }), /succeeded/);
  assert.deepEqual(called, ['workflow.nika.yaml', 'workflow.nika.yaml']);
});
