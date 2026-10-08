'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * One real-provider document revision per door, from the packed package of
 * one module system (scripts/run-compile-parity-e2e.mjs, provider phase).
 * Each door makes its own provider round: the two candidates are separate
 * generations and are never compared byte for byte. What must hold on each
 * door is the evidence law: the decoder accepted the evidence, every revision
 * stated binds the exact base the caller sent and the exact candidate the
 * caller received, a kept plan states the decision's revision, a ready round
 * keeps its plan, and the backend keeps its model identities apart. The engine
 * drops the plan whole (no replay) when its verifier holds, withdraws or
 * doubts the candidate; the decision keeps the revision it made.
 */
module.exports = async function compileEvidence(sdk, config) {
  const native = new sdk.Nika({ bin: config.bin, cwd: config.project });
  // If compile ever attempted a local fallback, this path could not resolve an engine.
  const http = new sdk.Nika({ url: config.url, token: config.token,
    bin: path.join(config.project, 'there-is-no-local-engine'), allowInsecureHttp: true });
  const revise = { workflow: config.base, change: config.change, original_intent: config.originalIntent };
  const rows = [];
  for (const door of ['native', 'http']) {
    const started = Date.now();
    const outcome = door === 'native'
      ? await native.compile({ ...revise, authoringModel: config.model })
      : await http.compile({ ...revise, cognition: 'explicitProvider' }, { observe: false });
    rows.push(evidenceRow(sdk, door, outcome, config, Date.now() - started));
  }
  return { module_system: config.moduleSystem, rows };
};

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
    assert.notEqual(plan, undefined, `${door}: a ready round keeps its record`);
  }
  const revision = stated[0];
  const reuse = decision.knowledge_qualification?.reuse;
  const backend = provenance.authoring.backend;
  return {
    door,
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
    receipt: {
      model: provenance.authoring.model,
      calls: provenance.authoring.calls,
      input_tokens: provenance.authoring.input_tokens,
      output_tokens: provenance.authoring.output_tokens,
      elapsed_ms: provenance.authoring.elapsed_ms,
      context_roles: provenance.authoring.context.map((entry) => entry.role ?? null),
    },
    backend: backend === null ? null : {
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
    },
  };
}
