import assert from 'node:assert/strict';
import { Nika } from '@supernovae-st/nika-client';

const engine = process.env.NIKA_BIN;
assert(engine, 'NIKA_BIN is required');
const nika = new Nika({ bin: engine, cwd: process.cwd(), eventBufferSize: 128 });
const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
assert.equal(checked.clean, true);
const [first, second] = await Promise.all([
  nika.run('workflow.nika.yaml', { maxCostUsd: 0 }),
  nika.run('workflow.nika.yaml', { maxCostUsd: 0 }),
]);
const eventKinds = [];
const observation = (async () => {
  for await (const event of nika.events(first)) eventKinds.push(event.kind ?? 'unknown');
})();
const [a, b] = await Promise.all([first.done, second.done, observation]).then(([left, right]) => [left, right]);
assert.equal(a.status, 'succeeded');
assert.equal(b.status, 'succeeded');
assert.equal(a.outputs?.provenance_root, b.outputs?.provenance_root);
assert(a.receipt && b.receipt);
const [proofA, proofB] = await Promise.all([nika.traceVerify(a.receipt), nika.traceVerify(b.receipt)]);
assert.equal(proofA.verified, true);
assert.equal(proofB.verified, true);
const forged = await nika.traceVerify({ ...a.receipt, chain_head: '0'.repeat(64), chain_len: 999999 });
assert.equal(forged.verified, false);

console.log(JSON.stringify({
  project: 'evidence-provenance-pipeline',
  status: 'succeeded',
  concurrent_runs: 2,
  deterministic_provenance_root: a.outputs.provenance_root,
  receipts_verified: 2,
  forged_receipt_rejected: true,
  observed_event_kinds: [...new Set(eventKinds)].sort(),
  deterministic_cost_cap_usd: 0,
}));
