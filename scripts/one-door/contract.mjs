import assert from 'node:assert/strict';

export const fixtures = {
  clean: `nika: m-clean
permits: { tools: ["nika:jq"] }
tasks:
  a:
    invoke: { tool: "nika:jq", args: { input: 1, expression: "." } }
  b:
    with: { prev: "${'${{ tasks.a.output }}'}" }
    invoke: { tool: "nika:jq", args: { input: 2, expression: "." } }
outputs: { answer: "${'${{ tasks.b.output }}'}" }
`,
  failed: `nika: m-fail
permits: { fs: { read: ["./missing.md"] }, tools: ["nika:read"] }
tasks:
  a:
    invoke: { tool: "nika:read", args: { path: "./missing.md" } }
`,
  recovered: `nika: m-recover
permits: { fs: { read: ["./missing.md"] }, tools: ["nika:read"] }
const: { fallback: "FALLBACK" }
tasks:
  a:
    invoke: { tool: "nika:read", args: { path: "./missing.md" } }
    on_error: { recover: "${'${{ const.fallback }}'}" }
outputs: { answer: "${'${{ tasks.a.output }}'}" }
`,
  paused: `nika: m-gate
permits: { tools: ["nika:prompt"] }
tasks:
  gate:
    invoke: { tool: "nika:prompt", args: { message: "ship it?" } }
`,
};

// Shape adapted from 05-fetch-chain and 02-parallel-fanout. The harness
// supplies only its owned loopback listener; no user input or external host.
export function cancellationFixture(url) {
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  return `nika: m-cancel
permits: { tools: ["nika:fetch"], net: { http: ["127.0.0.1"] } }
tasks:
  held:
    invoke: { tool: "nika:fetch", args: { url: "${url}/hold", mode: jq, jq: "." } }
  dependent:
    after: { held: success }
    invoke: { tool: "nika:fetch", args: { url: "${url}/dependent", mode: jq, jq: "." } }
`;
}

export function compareControlledCancellation(result) {
  const actual = verdict(result);
  assert.equal(actual.status, 'cancelled', 'controlled cancellation must reach the runtime boundary');
  assert.equal(actual.cause, 'operator');
  assert.deepEqual(actual.tasks, { total: 2, ok: 1, failed: 0, recovered: 0, skipped: 0,
    cancelled: 1, never_started: 1 }, 'completed in-flight task and unstarted dependent');
  assert.deepEqual(actual.outputs, {});
  assert.equal(actual.error_code, null);
}

// Compare independent executions using stable engine facts, including the
// complete output map and failing task. Elapsed time, IDs, and prose can differ.
export function settlementFacts(result) {
  assert(result, 'missing terminal result');
  const settlement = result.settlement ?? result;
  assert.equal(typeof settlement.cause, 'string', 'missing settlement cause');
  assert(settlement.tasks && settlement.spend, 'missing engine tally or spend');
  const error = result.error ?? settlement.error;
  return { status: result.status ?? settlement.status, cause: settlement.cause,
    tasks: settlement.tasks, spend: settlement.spend,
    error_code: error?.code ?? null, error_task: error?.task ?? null };
}

export function verdict(result) {
  const facts = settlementFacts(result);
  // Failed/paused/cancelled HTTP observations may omit the optional outputs
  // field when no workflow outputs were evaluated. This means an empty set;
  // a dropped nonempty map still differs from the CLI oracle on every door.
  const outputs = result.outputs === undefined && facts.status !== 'succeeded' ? {} : result.outputs;
  assert(outputs && typeof outputs === 'object' && !Array.isArray(outputs), 'missing workflow output map');
  return { ...facts, outputs };
}

export function compareResult(result, expected, label) {
  try { assert.deepEqual(verdict(result), expected, label); }
  catch (error) {
    throw new Error(`${label ?? 'result comparison'}: ${error.message}\nactual terminal: ${JSON.stringify(result)}`, { cause: error });
  }
}

function presentFields(object, fields) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(object, key))
    .map((key) => [key, object[key]]));
}

function exactObservation(observation) {
  assert(observation, 'missing observation');
  const nativeEvent = observation.kind === 'run_settled';
  const httpEvent = observation.kind === 'execution.settled' || observation.kind === 'execution.cancelled';
  // Native flattens known settlement fields among event metadata. Project only
  // those fields, preserving absence; HTTP already supplies the full object,
  // including any additive fields that the proof must not normalize away.
  const settlement = nativeEvent
    ? presentFields(observation, ['status', 'cause', 'elapsed_ms', 'tasks', 'spend', 'error'])
    : observation.settlement;
  assert(settlement && typeof settlement === 'object' && !Array.isArray(settlement), 'missing settlement object');
  // An HTTP terminal event carries the authoritative diagnostic inside its
  // settlement. SDK results expose it separately too: check that copy as well,
  // without falling back to the nested error and concealing a dropped copy.
  return { ...presentFields(observation, ['status']), settlement,
    ...presentFields(httpEvent ? settlement : observation, ['error']) };
}

export function compareSameJobResult(result, original, label = 'same-job result comparison') {
  try { assert.deepEqual(exactObservation(result), exactObservation(original)); }
  catch (error) {
    throw new Error(`${label} (same-job): ${error.message}`, { cause: error });
  }
}

export function identity(result) {
  return { execution_id: result.execution_id ?? result.receipt?.execution_id ?? null,
    execution: result.execution ?? null, receipt: result.receipt ?? null,
    outputs_field_present: Object.hasOwn(result, 'outputs') };
}
