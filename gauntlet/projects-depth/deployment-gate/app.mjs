import assert from 'node:assert/strict';
import { Nika, NikaCompatibilityError } from '@supernovae-st/nika-client';

const engine = process.env.NIKA_BIN;
assert(engine, 'NIKA_BIN is required');
const nika = new Nika({ bin: engine, cwd: process.cwd(), eventBufferSize: 128 });
const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
assert.equal(checked.clean, true);
const [allowed, refused] = await Promise.all([
  nika.run('workflow.nika.yaml', { vars: { approved: true }, maxCostUsd: 0 }),
  nika.run('workflow.nika.yaml', { vars: { approved: false }, maxCostUsd: 0 }),
]);
const allowedEvents = [];
const observe = (async () => { for await (const event of nika.events(allowed)) allowedEvents.push(event.kind ?? 'unknown'); })();
const [green, red] = await Promise.all([allowed.done, refused.done, observe]).then(([success, failure]) => [success, failure]);
assert.equal(green.status, 'succeeded');
assert.equal(green.outputs?.board?.green, true);
assert.equal(red.status, 'failed');
assert.equal(red.exitCode, 1);
assert.equal(red.outputs?.board?.green, false);
assert(green.receipt);
assert.equal((await nika.traceVerify(green.receipt)).verified, true);

let typedError;
try {
  await nika.run('workflow.nika.yaml', { idempotencyKey: 'remote-option-on-native' });
} catch (error) { typedError = error; }
assert(typedError instanceof NikaCompatibilityError);
assert.equal(typedError.capability, 'idempotencyKey');

console.log(JSON.stringify({
  project: 'deployment-gate',
  status: 'succeeded',
  green_path: green.status,
  refusal_path: { status: red.status, exit_code: red.exitCode, board_green: red.outputs.board.green },
  typed_error: { name: typedError.name, capability: typedError.capability },
  concurrent_gate_runs: 2,
  observed_event_kinds: [...new Set(allowedEvents)].sort(),
  receipt_verified: true,
  deterministic_cost_cap_usd: 0,
}));
