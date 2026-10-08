'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const path = require('node:path');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Real-provider rounds per door, from the packed package of one module system
 * (scripts/run-compile-parity-e2e.mjs, provider phase), in two separate legs:
 * EDIT revises one rich base, CREATE writes a new document from words alone.
 * Each door makes its own provider round: the candidates are separate
 * generations and are never compared byte for byte. What must hold on each
 * door is the evidence law: the decoder accepted the evidence, every revision
 * stated binds the exact base the caller sent and the exact candidate the
 * caller received, a kept plan states the decision's revision, a ready round
 * keeps its plan, a ready creation settles the exact bytes received, and the
 * backend keeps its model identities apart. The engine drops the plan whole
 * (no replay) when its verifier holds, withdraws or doubts the candidate; the
 * decision keeps the revision it made.
 */
module.exports = async function compileEvidence(sdk, config) {
  const native = new sdk.Nika({ bin: config.bin, cwd: config.project });
  // If compile ever attempted a local fallback, this path could not resolve an engine.
  const http = new sdk.Nika({ url: config.url, token: config.token,
    bin: path.join(config.project, 'there-is-no-local-engine'), allowInsecureHttp: true });
  const seat = { authoringModel: config.model, ...(config.decisionModel ? { decisionModel: config.decisionModel } : {}) };
  const round = async (door, input) => {
    const started = Date.now();
    const outcome = door === 'native'
      ? await native.compile({ ...input, ...seat })
      : await http.compile({ ...input, cognition: 'explicitProvider' }, { observe: false });
    return { outcome, wallMs: Date.now() - started };
  };
  const legs = config.legs ?? ['edit', 'create'];
  const rows = [];
  const created = [];
  // Each finished leg is kept as it lands, so a bound of the harness's observation keeps what
  // was already seen (the runner reads this file when it stops watching).
  const kept = (leg, row) => {
    if (config.progress) appendFileSync(config.progress, `${JSON.stringify({ leg, row })}\n`);
    return row;
  };
  for (const door of ['native', 'http']) {
    if (legs.includes('edit')) {
      const { outcome, wallMs } = await round(door,
        { workflow: config.base, change: config.change, original_intent: config.originalIntent });
      rows.push(kept('edit', evidenceRow(sdk, door, outcome, config, wallMs)));
    }
    if (legs.includes('create')) {
      const { outcome, wallMs } = await round(door, { intent: config.createIntent });
      created.push(kept('create', creationRow(sdk, door, outcome, config, wallMs)));
    }
  }
  return { module_system: config.moduleSystem, rows, created };
};
module.exports.evidenceRow = evidenceRow;
module.exports.creationRow = creationRow;
module.exports.rawEvidence = rawEvidence;

/**
 * The outcome's own receipts, as the engine wrote them (every member, unknown ones included,
 * nothing recomputed): the full diagnostics and questions, the whole provenance (plan, decision
 * with its rehearsal and qualification, authoring receipts) and, when nothing is ready, the
 * candidate the engine still shows, so a held or failed leg stays diagnosable.
 */
function rawEvidence(outcome) {
  return { diagnostics: outcome.diagnostics, questions: outcome.questions, provenance: outcome.provenance,
    candidate: outcome.status === 'ready' ? undefined : outcome.candidate };
}

/**
 * One leg's evidence. The scenario targets a revision: a leg on which the
 * engine stated none is `exercised: false`, and the runner then withholds
 * the qualification instead of reading the absence as a pass. A ready leg
 * keeps its replayable plan and the plan states the revision.
 */
function evidenceRow(sdk, door, outcome, config, wallMs) {
  const { provenance } = outcome;
  assert.equal(outcome.compile_version, 2, `${door}: a provider round answers generation 2`);
  // The plan is the round's replayable record: the engine drops it whole when the verifier
  // holds, withdraws or doubts the candidate. The decision keeps what the revision did.
  const plan = provenance.plan;
  const decision = provenance.decision ?? {};
  const held = sdk.isNikaCompileHeld(outcome);
  const stated = [plan?.document_revision, decision.document_revision].filter((revision) => revision !== undefined);
  const lineage = plan?.source_revision;
  const candidateSha = outcome.candidate === null ? null : sha256(outcome.candidate);
  for (const revision of stated) {
    assert.equal(revision.base_sha256, sha256(config.base), `${door}: the revision binds the exact base sent`);
    if (outcome.candidate !== null) {
      assert.equal(revision.candidate_sha256, candidateSha, `${door}: the revision binds the exact candidate received`);
    }
  }
  if (plan?.document_revision !== undefined) {
    assert.deepStrictEqual(decision.document_revision, plan.document_revision, `${door}: plan and decision state one revision`);
  }
  if (lineage !== undefined) {
    assert.equal(lineage.base_sha256, sha256(config.base), `${door}: the lineage binds the exact base sent`);
    if (outcome.candidate !== null) {
      assert.equal(lineage.candidate_sha256, candidateSha, `${door}: the lineage binds the exact candidate received`);
    }
  }
  if (outcome.status === 'ready') {
    assert.notEqual(plan?.document_revision, undefined, `${door}: a ready revision keeps its plan and states it there`);
  }
  const revision = stated[0];
  const reuse = decision.knowledge_qualification?.reuse;
  const backend = provenance.authoring.backend;
  return {
    door,
    leg: 'edit',
    exercised: stated.length > 0,
    status: outcome.status,
    held,
    plan_kept: plan !== undefined,
    revision_in: { plan: plan?.document_revision !== undefined, decision: decision.document_revision !== undefined },
    wall_ms: wallMs,
    candidate_sha256: candidateSha,
    candidate_bytes: outcome.candidate === null ? null : Buffer.byteLength(outcome.candidate),
    candidate_keeps_comments_and_unicode: outcome.candidate !== null
      && config.keptLines.every((line) => outcome.candidate.includes(line)),
    questions: outcome.questions.map((question) => question.key),
    diagnostics: outcome.diagnostics.map((diagnostic) => `${diagnostic.kind}:${diagnostic.target}`),
    // What the verifier said, in the engine's words: a held candidate is the engine's verdict.
    judgment: {
      diagnostics: outcome.diagnostics.filter((diagnostic) => diagnostic.target === 'semantic_verification'
        || diagnostic.target === 'verify_held' || diagnostic.target === 'verify_resume'),
      semantic_verification: decision.semantic_verification ?? null,
      route: decision.route ?? null,
    },
    raw: rawEvidence(outcome),
    strategy: provenance.strategy ?? null,
    revision: revision === undefined ? null : {
      route: revision.route ?? null,
      mode: revision.mode,
      base_sha256: revision.base_sha256,
      candidate_sha256: revision.candidate_sha256,
      changed: revision.changed,
      preservation: revision.preservation ?? null,
      components: revision.components.length,
    },
    source_revision: lineage ?? null,
    intent_sha256: plan?.intent_sha256 ?? null,
    reuse: reuse === undefined ? null : {
      counts: { expanded: reuse.expanded, invoked: reuse.invoked, revised: reuse.revised, absent: reuse.absent,
        consulted: reuse.consulted },
      references: reuse.references.map((reference) => ({ id: reference.id, kind: reference.kind ?? null,
        use: reference.use })),
    },
    receipt: receiptRow(provenance.authoring),
    backend: backendRow(backend),
  };
}

/**
 * One creation leg's evidence. The leg targets the settled record of a
 * created document: a ready round must state `plan.document`, bound to the
 * exact candidate bytes the caller received, with no program base. A round
 * that settled nothing (a mandatory question still open, a held or refused
 * round) did not exercise the record: `exercised: false`, and the runner
 * withholds the qualification instead of reading the absence as a pass.
 */
function creationRow(sdk, door, outcome, config, wallMs) {
  const { provenance } = outcome;
  if (outcome.compile_version !== 2) {
    // No provider call: the engine settled the words without its author (a reading it composes
    // whole goes to Check), so the document door, and its record, were never reached.
    assert.equal(provenance.plan?.document, undefined, `${door}: only the document door settles a creation`);
    return { door, leg: 'create', exercised: false, why: 'no provider round: the document door was not reached',
      status: outcome.status, compile_version: outcome.compile_version, wall_ms: wallMs,
      strategy: provenance.strategy ?? null, route: provenance.decision?.route ?? null, raw: rawEvidence(outcome) };
  }
  const plan = provenance.plan;
  const decision = provenance.decision ?? {};
  const settled = plan?.document;
  const made = decision.document_create;
  const candidateSha = outcome.candidate === null ? null : sha256(outcome.candidate);
  if (outcome.status === 'ready') {
    assert.notEqual(settled, undefined, `${door}: a ready creation settles plan.document`);
  }
  if (settled !== undefined) {
    assert.equal(settled.version, 1, `${door}: the settled record is version 1`);
    assert.equal(outcome.status, 'ready', `${door}: only a ready creation settles its record`);
    assert.equal(settled.candidate_sha256, candidateSha, `${door}: the settled record binds the exact candidate received`);
    assert.equal(settled.base_sha256, null, `${door}: a creation revises no program`);
    assert.equal(typeof settled.request === 'string' && settled.request.length > 0, true,
      `${door}: the settled record states the request its bytes answer`);
    if (plan.document_create !== undefined) {
      assert.deepStrictEqual(settled.components, plan.document_create.components,
        `${door}: the settled record keeps the receipts the door made`);
    }
  }
  // On a ready outcome the engine refreshes the door's record to the final bytes; elsewhere it
  // names what the door judged, reported below and never corrected here.
  if (made !== undefined && outcome.status === 'ready') {
    assert.equal(made.candidate_sha256, candidateSha, `${door}: the door's record names the exact candidate received`);
  }
  const reuse = made?.reuse;
  const qualification = decision.knowledge_qualification?.reuse;
  const uses = (record) => record === undefined ? null : {
    counts: { expanded: record.expanded, invoked: record.invoked, revised: record.revised, absent: record.absent,
      consulted: record.consulted },
    references: record.references.map((reference) => ({ id: reference.id, kind: reference.kind ?? null,
      use: reference.use })),
  };
  return {
    door,
    leg: 'create',
    exercised: settled !== undefined,
    status: outcome.status,
    held: sdk.isNikaCompileHeld(outcome),
    plan_kept: plan !== undefined,
    wall_ms: wallMs,
    candidate_sha256: candidateSha,
    candidate_bytes: outcome.candidate === null ? null : Buffer.byteLength(outcome.candidate),
    questions: outcome.questions.map((question) => ({ key: question.key, mandatory: question.mandatory })),
    diagnostics: outcome.diagnostics.map((diagnostic) => `${diagnostic.kind}:${diagnostic.target}`),
    judgment: {
      diagnostics: outcome.diagnostics.filter((diagnostic) => diagnostic.target === 'semantic_verification'
        || diagnostic.target === 'verify_held' || diagnostic.target === 'verify_resume'),
      route: decision.route ?? null,
    },
    raw: rawEvidence(outcome),
    strategy: provenance.strategy ?? null,
    settled: settled === undefined ? null : {
      version: settled.version,
      candidate_sha256: settled.candidate_sha256,
      base_sha256: settled.base_sha256,
      mode: settled.mode,
      request_is_the_sent_intent: settled.request === config.createIntent,
      components: settled.components.map(componentRow),
    },
    made: made === undefined ? null : {
      route: made.route ?? null,
      mode: made.mode,
      base_sha256: made.base_sha256,
      candidate_sha256: made.candidate_sha256,
      operations: made.operations ?? null,
      changed: made.changed,
      preservation: made.preservation ?? null,
      components: made.components.map(componentRow),
      names_the_candidate_received: made.candidate_sha256 === candidateSha,
      same_receipts_as_settled: settled === undefined ? null
        : JSON.stringify(made.components) === JSON.stringify(settled.components),
    },
    intent_sha256: plan?.intent_sha256 ?? null,
    reuse: uses(reuse),
    qualification_reuse: uses(qualification),
    receipt: receiptRow(provenance.authoring),
    backend: backendRow(provenance.authoring.backend),
  };
}

/** A component receipt as a row: its identity and bindings, never a reduction to its name. */
function componentRow(receipt) {
  return {
    id: receipt.component.id,
    release: receipt.component.release ?? null,
    row_sha256: receipt.component.row_sha256 ?? null,
    file: receipt.component.file ?? null,
    file_sha256: receipt.component.file_sha256 ?? null,
    bindings: receipt.bindings.map((binding) => ({ path: binding.path, hole: binding.hole ?? null,
      component_literal: binding.component_literal ?? null, bound: binding.bound })),
    nodes: receipt.nodes,
    candidate_sha256: receipt.candidate_sha256,
    invocation: receipt.invocation ?? null,
  };
}

function receiptRow(authoring) {
  return {
    model: authoring.model,
    calls: authoring.calls,
    input_tokens: authoring.input_tokens,
    output_tokens: authoring.output_tokens,
    elapsed_ms: authoring.elapsed_ms,
    context_roles: authoring.context.map((entry) => entry.role ?? null),
  };
}

/** The backend's identities, each kept as its own fact; `absent` is not `null`. */
function backendRow(backend) {
  return backend === null ? null : {
    kind: backend.kind ?? null,
    provider: backend.provider ?? null,
    requested_model: 'requested_model' in backend ? backend.requested_model : 'absent',
    forwarded_model: 'forwarded_model' in backend ? backend.forwarded_model : 'absent',
    decision_model: 'decision_model' in backend ? backend.decision_model : 'absent',
    observed_models: backend.observed_models ?? 'absent',
    unreported_models: backend.unreported_models ?? 'absent',
    served_model: 'served_model' in backend ? backend.served_model : 'absent',
    usage_complete: backend.usage_complete ?? 'absent',
    host: 'host' in backend ? backend.host : 'absent',
    endpoint_basis: backend.endpoint_basis ?? 'absent',
    cost_basis: backend.cost_basis ?? 'absent',
    http_requests: backend.authority?.http_requests ?? 'absent',
    invocations: backend.authority?.invocations ?? 'absent',
    members: Object.keys(backend).sort(),
  };
}
