import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import type { NikaCompileOutcome } from '../src/index.js';
import { compilePayloadFrom } from '../src/lib/compile.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The revision, reuse and intelligence evidence of a compile outcome
// (`provenance.plan`, `provenance.decision`, `provenance.authoring.backend`),
// as engine carrier 7d98023f9 writes it. The fixture's VALUES are synthetic
// (no engine produced these bytes); its shapes are the producers'. It proves
// decoder behavior only: the real-engine qualification is
// `scripts/run-compile-parity-e2e.mjs`.

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/compile-evidence/document-revision.json', import.meta.url));
const COMPILE_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  base: string;
  original_intent: string;
  change: string;
  document: Record<string, any>;
};
const REPLAY = '0123456789abcdef'.repeat(4);
const NATIVE_SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'compileNativeV2',
  'compileJudgedAnswerRound'];
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SECRET = 'sk-planted-secret-value-0123456789';

/** A fresh deep copy of the fixture document. */
function document(): Record<string, any> {
  return structuredClone(fixture.document);
}

function decode(payload: Record<string, unknown>): NikaCompileOutcome {
  return compilePayloadFrom(payload, 'http', 'https://nika.example', [1, 2]);
}

function refusal(payload: Record<string, unknown>): NikaProtocolError {
  try {
    decode(payload);
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

describe('the evidence fixture is internally consistent', () => {
  it('binds the base and candidate bytes by their sha256 digests', () => {
    const { provenance, candidate } = fixture.document;
    expect(candidate).toContain('\r\n');
    expect(candidate).toContain('\t');
    expect(candidate).toContain('🦋');
    for (const revision of [provenance.plan.document_revision, provenance.decision.document_revision]) {
      expect(revision.base_sha256).toBe(sha256(fixture.base));
      expect(revision.candidate_sha256).toBe(sha256(candidate));
    }
    expect(provenance.plan.source_revision.base_sha256).toBe(sha256(fixture.base));
    expect(provenance.plan.source_revision.candidate_sha256).toBe(sha256(candidate));
    const { reuse } = provenance.decision.knowledge_qualification;
    for (const use of ['expanded', 'invoked', 'revised', 'absent', 'consulted']) {
      expect(reuse[use]).toBe(reuse.references.filter((reference: any) => reference.use === use).length);
    }
  });
});

describe('compile evidence decoding', () => {
  it('returns the engine\'s own objects, every member kept exactly', () => {
    const payload = document();
    const raw = JSON.stringify(payload);
    const outcome = decode(payload);
    expect(outcome.provenance).toBe(payload.provenance);
    expect(outcome.candidate).toBe(fixture.document.candidate);
    expect(JSON.parse(JSON.stringify(outcome.provenance))).toEqual(JSON.parse(raw).provenance);
    expect(JSON.stringify(payload)).toBe(raw);
  });

  it('types every documented member and keeps additive ones', () => {
    const { provenance } = decode(document());
    const revision = provenance.plan!.document_revision!;
    expect(revision.mode).toBe('operations');
    expect(revision.changed).toEqual(['const.window_hours', 'const.max_age_hours', 'component block:notify-digest']);
    expect(revision.future_lineage).toEqual({ parents: [sha256(fixture.base)] });
    expect(provenance.decision!.document_revision).toEqual(revision);
    const [expanded, invoked] = revision.components;
    // The 48 → 72 rebinding keeps the component's literal, the bound one and the digest it revised.
    expect(expanded!.bindings[0]).toEqual({ path: 'const.max_age_hours', hole: 'const.max_age_hours', owner: 'human',
      component_literal: 48, bound: 72 });
    expect(expanded!.revises).toMatch(/^[0-9a-f]{64}$/);
    expect(expanded!.component).toMatchObject({ id: 'block:stock-window', status: 'QUALIFIED', proof_level: 'CHECKED',
      release: { version: 'foundry-2026.10.08', profile: 'nika-release@2' } });
    expect(expanded!.nodes.const!.window_hours).toBeNull();
    expect(expanded!.future_receipt_member).toEqual({ additive: true });
    // The calling node and the child program are separate evidence.
    expect(invoked!.invocation).toEqual({ task: 'notify_digest', workflow: 'children/notify-digest.nika' });
    expect(invoked!.nodes).toEqual({ tasks: { notify_digest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(invoked!.child!.candidate_sha256).not.toBe(invoked!.candidate_sha256);
    const reuse = provenance.decision!.knowledge_qualification!.reuse!;
    expect(reuse.references.map((reference) => [reference.id, reference.use])).toEqual([
      ['pattern:paginated-read', 'consulted'],
      ['block:stock-window', 'expanded'],
      ['block:notify-digest', 'invoked'],
      ['block:legacy-copy', 'absent'],
      [null, 'unreadable'],
    ]);
    expect(reuse.references[2]!.witness!.workflow).toBe('children/notify-digest.nika');
    expect(reuse.references[3]!.witness).toEqual({ component: 'block:legacy-copy', verdict: 'absent' });
    expect(provenance.plan!.intent_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.future_provenance_member).toBe('kept');
  });

  it('keeps requested, transmitted, configured, reported and attested identities apart', () => {
    const backend = decode(document()).provenance.authoring!.backend!;
    expect(backend.requested_model).toBe('deepseek/deepseek-flash');
    expect(backend.decision_model).toBe('typesafe/jev');
    expect(backend.observed_models).toEqual(['deepseek-v4-flash']);
    expect(backend.unreported_models).toBe(1);
    expect(backend.served_model).toBeNull();
    expect('forwarded_model' in backend).toBe(false);
    expect(backend.selection).toEqual({ role: 'author', scope: 'round', future: 'access-owner additive evidence' });
    expect(backend.authority!.http_requests).toEqual({ sent: 4, refused: 0, unknown: null });
  });

  it('keeps explicit null apart from absence', () => {
    const payload = document();
    const backend = payload.provenance.authoring.backend;
    delete backend.served_model;
    backend.requested_model = null;
    const decoded = decode(payload).provenance.authoring!.backend!;
    expect('served_model' in decoded).toBe(false);
    expect(decoded.requested_model).toBeNull();
    expect(Object.hasOwn(decoded, 'requested_model')).toBe(true);
  });

  it('decodes an outcome without any of this evidence exactly as before', () => {
    const payload = document();
    payload.provenance.plan = { semantic_record: { request: 'digest' } };
    payload.provenance.decision = { route: ['native: author 1'], knowledge_qualification: { trace: { references: [] } } };
    payload.provenance.authoring.backend = null;
    const raw = JSON.stringify(payload);
    const outcome = decode(payload);
    expect(JSON.stringify(outcome.provenance)).toBe(JSON.stringify(JSON.parse(raw).provenance));
    expect(outcome.provenance.authoring!.backend).toBeNull();
  });

  it('keeps future vocabulary words', () => {
    const payload = document();
    payload.provenance.plan.document_revision.mode = 'rewritten';
    payload.provenance.decision.knowledge_qualification.reuse.references[1].use = 'adapted';
    payload.provenance.decision.knowledge_qualification.reuse.references[1].witness.verdict = 'partially';
    payload.provenance.authoring.backend.kind = 'grpc_harness';
    const { provenance } = decode(payload);
    expect(provenance.plan!.document_revision!.mode).toBe('rewritten');
    expect(provenance.authoring!.backend!.kind).toBe('grpc_harness');
  });

  it('admits the optional members a producer may leave out', () => {
    const payload = document();
    const revision = payload.provenance.plan.document_revision;
    delete revision.route;
    delete revision.preservation;
    for (const receipt of revision.components) {
      for (const key of ['law', 'open', 'not_inherited', 'authority', 'check', 'revises', 'child']) delete receipt[key];
      receipt.component = { id: receipt.component.id };
    }
    delete payload.provenance.plan.source_revision.resolved;
    delete payload.provenance.plan.intent_sha256;
    payload.provenance.authoring.backend = { kind: 'direct_api' };
    expect(() => decode(payload)).not.toThrow();
  });

  const at = (payload: Record<string, any>) => ({
    planRevision: payload.provenance.plan.document_revision,
    decisionRevision: payload.provenance.decision.document_revision,
    source: payload.provenance.plan.source_revision,
    expanded: payload.provenance.plan.document_revision.components[0],
    invoked: payload.provenance.plan.document_revision.components[1],
    reuse: payload.provenance.decision.knowledge_qualification.reuse,
    witness: payload.provenance.decision.knowledge_qualification.reuse.references[1].witness,
    backend: payload.provenance.authoring.backend,
  });
  type Where = ReturnType<typeof at>;
  const malformed: [string, (where: Where, payload: Record<string, any>) => void, RegExp][] = [
    ['a non-hex base digest', (w) => { w.planRevision.base_sha256 = SECRET; },
      /provenance\.plan\.document_revision\.base_sha256 is not a sha256 digest/],
    ['an upper-case candidate digest', (w) => { w.decisionRevision.candidate_sha256 = w.decisionRevision.candidate_sha256.toUpperCase(); },
      /provenance\.decision\.document_revision\.candidate_sha256 is not a sha256 digest/],
    ['a numeric mode', (w) => { w.planRevision.mode = 1; }, /document_revision\.mode is not text/],
    ['a changed list with a number', (w) => { w.planRevision.changed.push(2); }, /document_revision\.changed is not a list of text/],
    ['components as an object', (w) => { w.planRevision.components = {}; }, /document_revision\.components is not a list/],
    ['a null document revision', (_w, p) => { p.provenance.plan.document_revision = null; },
      /provenance\.plan\.document_revision is not an object/],
    ['a null decision revision', (_w, p) => { p.provenance.decision.document_revision = null; },
      /provenance\.decision\.document_revision is not an object/],
    ['a document revision without its base digest', (w) => { delete w.planRevision.base_sha256; },
      /document_revision\.base_sha256 is absent/],
    ['a document revision without components', (w) => { delete w.decisionRevision.components; },
      /document_revision\.components is absent/],
    ['a null source revision', (_w, p) => { p.provenance.plan.source_revision = null; }, /source_revision is not an object/],
    ['a source revision without its candidate digest', (w) => { delete w.source.candidate_sha256; },
      /source_revision\.candidate_sha256 is absent/],
    ['numeric resolved words', (w) => { w.source.resolved = 7; }, /source_revision\.resolved is not text/],
    ['a non-hex intent digest', (_w, p) => { p.provenance.plan.intent_sha256 = 'intent'; }, /plan\.intent_sha256 is not a sha256 digest/],
    ['a receipt without a component id', (w) => { delete w.expanded.component.id; },
      /components\[0\]\.component\.id is absent/],
    ['a null receipt component', (w) => { w.expanded.component = null; }, /components\[0\]\.component is not an object/],
    ['a numeric file digest', (w) => { w.expanded.component.file_sha256 = 5; }, /component\.file_sha256 is not text/],
    ['a release as text', (w) => { w.expanded.component.release = 'v1'; }, /component\.release is not an object/],
    ['a binding without its bound literal', (w) => { delete w.expanded.bindings[0].bound; },
      /components\[0\]\.bindings\[0\]\.bound is absent/],
    ['a binding path as a number', (w) => { w.invoked.bindings[0].path = 0; }, /components\[1\]\.bindings\[0\]\.path is not text/],
    ['a numeric hole', (w) => { w.expanded.bindings[1].hole = 3; }, /bindings\[1\]\.hole is neither text nor null/],
    ['a node digest that is not hex', (w) => { w.expanded.nodes.tasks.totals = SECRET; },
      /components\[0\]\.nodes holds a node digest that is neither a sha256 digest nor null/],
    ['a node section as a list', (w) => { w.expanded.nodes.tasks = []; }, /components\[0\]\.nodes has a section that is not an object/],
    ['a receipt without nodes', (w) => { delete w.invoked.nodes; }, /components\[1\]\.nodes is absent/],
    ['a receipt digest that is not hex', (w) => { w.invoked.candidate_sha256 = 'x'; },
      /components\[1\]\.candidate_sha256 is not a sha256 digest/],
    ['an invocation without its workflow', (w) => { delete w.invoked.invocation.workflow; },
      /components\[1\]\.invocation\.workflow is absent/],
    ['a child digest that is not hex', (w) => { w.invoked.child.candidate_sha256 = 'child'; },
      /components\[1\]\.child\.candidate_sha256 is not a sha256 digest/],
    ['a revises digest that is not hex', (w) => { w.expanded.revises = 'earlier'; },
      /components\[0\]\.revises is neither a sha256 digest nor null/],
    ['a check whose ready is text', (w) => { w.expanded.check.ready = 'yes'; }, /components\[0\]\.check\.ready is not a boolean/],
    ['open holes as text', (w) => { w.expanded.open = 'const.x'; }, /components\[0\]\.open is not a list of text/],
    ['a null qualification', (_w, p) => { p.provenance.decision.knowledge_qualification = null; },
      /knowledge_qualification is not an object/],
    ['a null reuse', (_w, p) => { p.provenance.decision.knowledge_qualification.reuse = null; },
      /knowledge_qualification\.reuse is not an object/],
    ['a negative count', (w) => { w.reuse.absent = -1; }, /reuse\.absent is not a count/],
    ['a fractional count', (w) => { w.reuse.expanded = 0.5; }, /reuse\.expanded is not a count/],
    ['reuse without its invoked count', (w) => { delete w.reuse.invoked; }, /reuse\.invoked is absent/],
    ['a reference without its use', (w) => { delete w.reuse.references[0].use; }, /references\[0\]\.use is absent/],
    ['a reference with a numeric id', (w) => { w.reuse.references[0].id = 9; }, /references\[0\]\.id is neither text nor null/],
    ['a witness without its verdict', (w) => { delete w.witness.verdict; }, /references\[1\]\.witness\.verdict is absent/],
    ['a witness whose kept nodes are text', (w) => { w.witness.nodes.kept = 'tasks.totals'; },
      /references\[1\]\.witness\.nodes\.kept is not a list of text/],
    ['a witness receipt digest that is not hex', (w) => { w.witness.receipt_candidate_sha256 = 'r'; },
      /witness\.receipt_candidate_sha256 is neither a sha256 digest nor null/],
    ['a numeric requested model', (w) => { w.backend.requested_model = 4; },
      /backend\.requested_model is neither text nor null/],
    ['observed models as text', (w) => { w.backend.observed_models = SECRET; }, /backend\.observed_models is not a list of text/],
    ['a negative unreported count', (w) => { w.backend.unreported_models = -1; }, /backend\.unreported_models is not a count/],
    ['a null forwarded model', (w) => { w.backend.forwarded_model = null; }, /backend\.forwarded_model is not text/],
    ['a usage completeness as text', (w) => { w.backend.usage_complete = 'true'; }, /backend\.usage_complete is not a boolean/],
    ['a billed amount as text', (w) => { w.backend.billed_cost_usd = '0.10'; }, /backend\.billed_cost_usd is neither a number nor null/],
    ['invocations without their refused count', (w) => { delete w.backend.authority.invocations.refused; },
      /authority\.invocations\.refused is absent/],
    ['a fractional request bound', (w) => { w.backend.authority.max_calls = 1.5; }, /authority\.max_calls is neither a count nor null/],
    ['a request account as a list', (w) => { w.backend.authority.http_requests = []; }, /authority\.http_requests is not an object/],
    ['observed rows that are not objects', (w) => { w.backend.observed = [1]; }, /backend\.observed is not a list of objects/],
  ];
  it.each(malformed)('refuses %s as a protocol fault naming its path, never its value', (_name, mutate, message) => {
    const payload = document();
    mutate(at(payload), payload);
    const error = refusal(payload);
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('compile evidence over both doors', () => {
  const argvLog = path.join(tmpdir(), `nika-sdk-compile-evidence-${process.pid}.log`);
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    rmSync(argvLog, { force: true });
  });
  const request = {
    workflow: fixture.base,
    change: fixture.change,
    original_intent: fixture.original_intent,
  };
  const native = () => new Nika({ bin: COMPILE_ENGINE }).compile({ ...request, authoringModel: 'deepseek/deepseek-flash' });
  function http(body: Record<string, unknown>) {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ engineVersion: '0.122.0', supportedCapabilities: NATIVE_SERVER }))
      .mockResolvedValueOnce(jsonResponse(body, 200, { 'Cache-Control': 'no-store', 'Nika-Compile-Replay': REPLAY }));
    process.env.NIKA_FAKE_ARGV_LOG = argvLog;
    const client = new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: COMPILE_ENGINE, fetch });
    return { fetch, compile: () => client.compile({ ...request, cognition: 'explicitProvider' }) };
  }

  it('retains the same evidence and the exact candidate through native and HTTP', async () => {
    const local = await native();
    const door = http(document());
    const remote = await door.compile();
    expect(existsSync(argvLog), 'HTTP compile never spawns a local engine').toBe(false);
    const sent = JSON.parse(door.fetch.mock.calls[1]![1].body as string);
    expect(sent).toMatchObject({ compile_version: 2, mode: 'edit', cognition: 'explicitProvider',
      source: fixture.base, change: { text: fixture.change }, original_intent: fixture.original_intent });
    // HTTP alone adds the kept round's token and whether its server judges an answer round.
    const { replay_token: token, judged_answer_round_available: judged, ...common } = remote;
    expect(token).toBe(REPLAY);
    expect(judged).toBe(true);
    expect(common).toEqual(local);
    expect(local.candidate).toBe(fixture.document.candidate);
    expect(remote.candidate).toBe(fixture.document.candidate);
    expect(JSON.parse(JSON.stringify(local.provenance))).toEqual(fixture.document.provenance);
    expect(local.provenance.plan!.document_revision!.base_sha256).toBe(sha256(fixture.base));
    expect(local.provenance.plan!.document_revision!.candidate_sha256).toBe(sha256(local.candidate!));
  });

  it('refuses malformed known evidence on both doors', async () => {
    const malformed = document();
    malformed.provenance.plan.document_revision.base_sha256 = 48;
    await expect(new Nika({ bin: COMPILE_ENGINE }).compile({ ...request, change: 'evidence-malformed',
      authoringModel: 'deepseek/deepseek-flash' })).rejects.toThrow(/document_revision\.base_sha256 is not a sha256 digest/);
    await expect(http(malformed).compile()).rejects.toThrow(/document_revision\.base_sha256 is not a sha256 digest/);
    const nulled = document();
    nulled.provenance.decision.document_revision = null;
    await expect(new Nika({ bin: COMPILE_ENGINE }).compile({ ...request, change: 'evidence-null-revision',
      authoringModel: 'deepseek/deepseek-flash' })).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(http(nulled).compile()).rejects.toBeInstanceOf(NikaProtocolError);
  });
});
