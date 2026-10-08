import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import type { NikaCompileCreatedDocument, NikaCompileDocumentCreate, NikaCompileOutcome } from '../src/index.js';
import { compilePayloadFrom } from '../src/lib/compile.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The complete-document creation's evidence (`provenance.plan.document`,
// `provenance.plan.document_create`, `provenance.decision.document_create`), as
// the 0.123 creation door writes it. The fixture's VALUES are synthetic (no
// engine produced these bytes); its shapes, presence and nullability are the
// producer's. It proves decoder behavior only: the real-engine qualification
// is the CREATE leg of `scripts/run-compile-parity-e2e.mjs`.

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/compile-evidence/document-create.json', import.meta.url));
const COMPILE_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
type LegName = 'ready' | 'written' | 'continuation';
type Leg = { intent: string; authored?: string; expanded?: string; document: Record<string, any> };
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<LegName, Leg>;
const REPLAY = '0123456789abcdef'.repeat(4);
const NATIVE_SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'compileNativeV2',
  'compileJudgedAnswerRound'];
const MODEL = 'claude-code/opus';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const SECRET = 'sk-planted-secret-value-0123456789';

/** A fresh deep copy of one leg's outcome. */
function document(leg: LegName = 'ready'): Record<string, any> {
  return structuredClone(fixture[leg].document);
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

describe('the creation fixture is internally consistent', () => {
  it('binds the final bytes, the request and one set of receipts', () => {
    const { candidate, provenance } = fixture.ready.document;
    expect(candidate).toContain('\r\n');
    expect(candidate).toContain('\t');
    expect(candidate).toContain('🦋');
    const { document: settled, document_create: section } = provenance.plan;
    const made = provenance.decision.document_create;
    expect(settled.candidate_sha256).toBe(sha256(candidate));
    expect(made.candidate_sha256).toBe(sha256(candidate));
    expect(made.base_sha256).toBe(sha256(fixture.ready.authored!));
    expect(settled.base_sha256).toBeNull();
    expect(settled.request).toBe(fixture.ready.intent);
    expect(section.resolved).toBe(fixture.ready.intent);
    expect(settled.components).toEqual(section.components);
    expect(made.components).toEqual(section.components);
    // A receipt names the bytes right after its expansion; the witness reads the final ones.
    const [receipt] = settled.components;
    expect(receipt.candidate_sha256).toBe(sha256(fixture.ready.expanded!));
    expect(receipt.candidate_sha256).not.toBe(settled.candidate_sha256);
    const [witnessed] = made.reuse.references;
    expect(witnessed.witness).toMatchObject({ candidate_sha256: sha256(candidate),
      receipt_candidate_sha256: receipt.candidate_sha256 });
    for (const reuse of [made.reuse, provenance.decision.knowledge_qualification.reuse]) {
      for (const use of ['expanded', 'invoked', 'revised', 'absent', 'consulted']) {
        expect(reuse[use]).toBe(reuse.references.filter((reference: any) => reference.use === use).length);
      }
    }
  });

  it('settles a written document whose only question is optional', () => {
    const { candidate, questions, provenance } = fixture.written.document;
    expect(questions.map((question: any) => question.mandatory)).toEqual([false]);
    expect(provenance.plan.document).toMatchObject({ candidate_sha256: sha256(candidate), mode: 'written',
      components: [] });
    expect(provenance.decision.document_create).toMatchObject({ base_sha256: null, operations: 0, changed: [] });
  });

  it('settles nothing while a mandatory question is open', () => {
    const { candidate, questions, provenance } = fixture.continuation.document;
    expect(candidate).toBeNull();
    expect(questions.map((question: any) => question.mandatory)).toEqual([true]);
    expect('document' in provenance.plan).toBe(false);
    expect(provenance.decision.document_create.candidate_sha256).toBeNull();
  });
});

describe('creation evidence decoding', () => {
  it('returns the engine\'s own objects, every member kept exactly', () => {
    const payload = document();
    const raw = JSON.stringify(payload);
    const outcome = decode(payload);
    expect(outcome.provenance).toBe(payload.provenance);
    expect(outcome.candidate).toBe(fixture.ready.document.candidate);
    expect(JSON.stringify(payload)).toBe(raw);
  });

  it('types every documented member and keeps additive ones', () => {
    const { provenance } = decode(document());
    const settled: NikaCompileCreatedDocument = provenance.plan!.document!;
    expect(settled).toMatchObject({ version: 1, base_sha256: null, mode: 'composed', request: fixture.ready.intent });
    expect(settled.future_document_member).toBe('kept');
    const [receipt] = settled.components;
    // The hole the creation bound keeps the component's literal beside the bound one.
    expect(receipt!.bindings[0]).toEqual({ path: 'const.threshold_hours', hole: 'const.threshold_hours', owner: 'human',
      component_literal: 24, bound: 48 });
    expect(receipt!.component).toMatchObject({ id: 'block:stale-filter', status: 'QUALIFIED',
      release: { version: 'foundry-2026.10.08', profile: 'nika-release@2' } });
    expect(receipt!.future_receipt_member).toEqual({ additive: true });
    const made: NikaCompileDocumentCreate = provenance.decision!.document_create!;
    expect(made).toMatchObject({ route: 'native: document', mode: 'composed', operations: 3,
      changed: ['component block:stale-filter', 'const.label', 'tasks.report'] });
    expect(made.reuse!.references.map((reference) => [reference.id, reference.use]))
      .toEqual([['block:stale-filter', 'expanded']]);
    expect(made.future_create_member).toBe(1);
    expect(provenance.plan!.document_create!.resolved).toBe(fixture.ready.intent);
    const backend = provenance.authoring!.backend!;
    expect([backend.requested_model, backend.forwarded_model, backend.decision_model, backend.served_model])
      .toEqual(['claude-code/opus', 'opus', 'typesafe/jev', null]);
    expect(backend.authority!.http_requests).toEqual({ sent: null, refused: null,
      unknown: 'the harness makes its own requests' });
  });

  it('settles a ready creation whose only question is optional', () => {
    const outcome = decode(document('written'));
    expect(outcome.ready).toBe(true);
    expect(outcome.questions[0]!.mandatory).toBe(false);
    expect(outcome.provenance.plan!.document!.components).toEqual([]);
  });

  it('decodes a continuation that settled nothing', () => {
    const outcome = decode(document('continuation'));
    expect(outcome.status).toBe('incomplete');
    expect(outcome.candidate).toBeNull();
    expect(Object.hasOwn(outcome.provenance.plan!, 'document')).toBe(false);
    expect(outcome.provenance.plan!.document_create!.mode).toBe('written');
    const made = outcome.provenance.decision!.document_create!;
    expect(made.base_sha256).toBeNull();
    expect(Object.hasOwn(made, 'base_sha256')).toBe(true);
    expect(made.candidate_sha256).toBeNull();
  });

  it('keeps a withdrawal whose candidate the outcome no longer holds', () => {
    const payload = document();
    payload.status = 'incomplete';
    payload.candidate = null;
    delete payload.provenance.plan.document;
    payload.provenance.decision.document_create.candidate_sha256 = null;
    const made = decode(payload).provenance.decision!.document_create!;
    expect(made.candidate_sha256).toBeNull();
    expect(made.base_sha256).toBe(sha256(fixture.ready.authored!));
  });

  it('carries a settled record of another version as written, unjudged', () => {
    const payload = document();
    payload.provenance.plan.document = { version: 2, final: { digests: ['later'] }, components: 'later' };
    const outcome = decode(payload);
    expect(outcome.provenance.plan!.document).toEqual({ version: 2, final: { digests: ['later'] }, components: 'later' });
  });

  it('keeps future vocabulary words', () => {
    const payload = document();
    payload.provenance.plan.document.mode = 'drafted';
    payload.provenance.plan.document_create.mode = 'drafted';
    payload.provenance.decision.document_create.mode = 'drafted';
    payload.provenance.decision.document_create.reuse.references[0].use = 'adapted';
    const { provenance } = decode(payload);
    expect(provenance.plan!.document!.mode).toBe('drafted');
    expect(provenance.decision!.document_create!.reuse!.references[0]!.use).toBe('adapted');
  });

  it('admits the optional members a producer may leave out', () => {
    const payload = document();
    const section = payload.provenance.plan.document_create;
    for (const key of ['route', 'resolved', 'preservation']) delete section[key];
    const made = payload.provenance.decision.document_create;
    for (const key of ['route', 'preservation', 'reuse']) delete made[key];
    expect(() => decode(payload)).not.toThrow();
  });

  const at = (payload: Record<string, any>) => ({
    settled: payload.provenance.plan.document,
    section: payload.provenance.plan.document_create,
    made: payload.provenance.decision.document_create,
  });
  type Where = ReturnType<typeof at>;
  const malformed: [string, (where: Where, payload: Record<string, any>) => void, RegExp][] = [
    ['a null settled record', (_w, p) => { p.provenance.plan.document = null; }, /provenance\.plan\.document is not an object/],
    ['a version as text', (w) => { w.settled.version = '1'; }, /provenance\.plan\.document\.version is not a count/],
    ['a record without its version', (w) => { delete w.settled.version; }, /provenance\.plan\.document\.version is absent/],
    ['a non-hex final digest', (w) => { w.settled.candidate_sha256 = SECRET; },
      /provenance\.plan\.document\.candidate_sha256 is not a sha256 digest/],
    ['a null final digest', (w) => { w.settled.candidate_sha256 = null; },
      /provenance\.plan\.document\.candidate_sha256 is not a sha256 digest/],
    ['a numeric request', (w) => { w.settled.request = 4; }, /provenance\.plan\.document\.request is not text/],
    ['a record without its request', (w) => { delete w.settled.request; }, /provenance\.plan\.document\.request is absent/],
    ['a base digest that is not hex', (w) => { w.settled.base_sha256 = 'base'; },
      /provenance\.plan\.document\.base_sha256 is neither a sha256 digest nor null/],
    ['a record without its base member', (w) => { delete w.settled.base_sha256; },
      /provenance\.plan\.document\.base_sha256 is absent/],
    ['a numeric mode', (w) => { w.settled.mode = 1; }, /provenance\.plan\.document\.mode is not text/],
    ['components as an object', (w) => { w.settled.components = {}; }, /provenance\.plan\.document\.components is not a list/],
    ['a receipt without nodes', (w) => { delete w.settled.components[0].nodes; },
      /provenance\.plan\.document\.components\[0\]\.nodes is absent/],
    ['a binding without its bound literal', (w) => { delete w.settled.components[0].bindings[0].bound; },
      /provenance\.plan\.document\.components\[0\]\.bindings\[0\]\.bound is absent/],
    ['a section without its mode', (w) => { delete w.section.mode; }, /provenance\.plan\.document_create\.mode is absent/],
    ['a section without its changes', (w) => { delete w.section.changed; },
      /provenance\.plan\.document_create\.changed is absent/],
    ['a numeric resolved request', (w) => { w.section.resolved = 7; }, /provenance\.plan\.document_create\.resolved is not text/],
    ['changes as text', (w) => { w.section.changed = 'const.label'; },
      /provenance\.plan\.document_create\.changed is not a list of text/],
    ['a section without components', (w) => { delete w.section.components; },
      /provenance\.plan\.document_create\.components is absent/],
    ['a null decision record', (_w, p) => { p.provenance.decision.document_create = null; },
      /provenance\.decision\.document_create is not an object/],
    ['a decision record without its base member', (w) => { delete w.made.base_sha256; },
      /provenance\.decision\.document_create\.base_sha256 is absent/],
    ['a decision record without its candidate member', (w) => { delete w.made.candidate_sha256; },
      /provenance\.decision\.document_create\.candidate_sha256 is absent/],
    ['a candidate digest that is not hex', (w) => { w.made.candidate_sha256 = 'abc'; },
      /provenance\.decision\.document_create\.candidate_sha256 is neither a sha256 digest nor null/],
    ['a decision record without its operation count', (w) => { delete w.made.operations; },
      /provenance\.decision\.document_create\.operations is absent/],
    ['operations as a list', (w) => { w.made.operations = ['set']; },
      /provenance\.decision\.document_create\.operations is not a count/],
    ['a negative operation count', (w) => { w.made.operations = -1; },
      /provenance\.decision\.document_create\.operations is not a count/],
    ['a decision record without its changes', (w) => { delete w.made.changed; },
      /provenance\.decision\.document_create\.changed is absent/],
    ['reuse without its expanded count', (w) => { delete w.made.reuse.expanded; },
      /provenance\.decision\.document_create\.reuse\.expanded is absent/],
    ['a witness without its verdict', (w) => { delete w.made.reuse.references[0].witness.verdict; },
      /provenance\.decision\.document_create\.reuse\.references\[0\]\.witness\.verdict is absent/],
  ];
  it.each(malformed)('refuses %s as a protocol fault naming its path, never its value', (_name, mutate, message) => {
    const payload = document();
    mutate(at(payload), payload);
    const error = refusal(payload);
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('creation evidence over both doors', () => {
  const argvLog = path.join(tmpdir(), `nika-sdk-compile-create-evidence-${process.pid}.log`);
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    rmSync(argvLog, { force: true });
  });
  const native = (intent: string) => new Nika({ bin: COMPILE_ENGINE }).compile({ intent, authoringModel: MODEL });
  function http(body: Record<string, unknown>) {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ engineVersion: '0.123.0', supportedCapabilities: NATIVE_SERVER }))
      .mockResolvedValueOnce(jsonResponse(body, 200, { 'Cache-Control': 'no-store', 'Nika-Compile-Replay': REPLAY }));
    process.env.NIKA_FAKE_ARGV_LOG = argvLog;
    const client = new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: COMPILE_ENGINE, fetch });
    return { fetch, compile: (intent: string) => client.compile({ intent, cognition: 'explicitProvider' }) };
  }

  it.each(['ready', 'written', 'continuation'] as const)(
    'retains the same %s evidence and the exact candidate through native and HTTP', async (leg) => {
      const { intent } = fixture[leg];
      const local = await native(intent);
      const door = http(document(leg));
      const remote = await door.compile(intent);
      expect(existsSync(argvLog), 'HTTP compile never spawns a local engine').toBe(false);
      expect(JSON.parse(door.fetch.mock.calls[1]![1].body as string)).toMatchObject({ compile_version: 2,
        mode: 'create', cognition: 'explicitProvider', intent });
      // HTTP alone adds the kept round's token and whether its server judges an answer round.
      const { replay_token: token, judged_answer_round_available: judged, ...common } = remote;
      expect(token).toBe(REPLAY);
      expect(judged).toBe(true);
      expect(common).toEqual(local);
      expect(local.candidate).toBe(fixture[leg].document.candidate);
      expect(JSON.parse(JSON.stringify(local.provenance))).toEqual(fixture[leg].document.provenance);
      const settled = local.provenance.plan!.document;
      expect(settled === undefined ? null : settled.candidate_sha256)
        .toBe(leg === 'continuation' ? null : sha256(local.candidate!));
    });

  it('refuses a malformed settled record on both doors', async () => {
    await expect(native('create-evidence-malformed')).rejects
      .toThrow(/provenance\.plan\.document\.candidate_sha256 is not a sha256 digest/);
    const malformed = document();
    malformed.provenance.plan.document.candidate_sha256 = 'x';
    await expect(http(malformed).compile(fixture.ready.intent)).rejects
      .toThrow(/provenance\.plan\.document\.candidate_sha256 is not a sha256 digest/);
  });
});
