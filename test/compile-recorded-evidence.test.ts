import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, isNikaCompileHeld } from '../src/index.js';
import type { NikaCompileOutcome } from '../src/index.js';
import { compilePayloadFrom } from '../src/lib/compile.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// Outcome documents the engine itself wrote for a complete-document creation and
// a later revision of it (fixtures/compile-evidence/recorded-fcdd44292, scripted
// seats, rendered by the engine's own `outcome_document`). The SDK must carry
// every member exactly, judge the creation and revision laws on them, and the
// provider phase's judges must read them as the evidence they are.

const DIR = new URL('./fixtures/compile-evidence/recorded-fcdd44292/', import.meta.url);
const COMPILE_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const NATIVE_SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'compileNativeV2',
  'compileJudgedAnswerRound'];
const REPLAY = '0123456789abcdef'.repeat(4);
const LEGS = ['ready-composed', 'ready-written', 'continuation', 'edit-created', 'edit-revised'] as const;
type Leg = (typeof LEGS)[number];
const file = (name: string) => fileURLToPath(new URL(name, DIR));
const text = (name: string) => readFileSync(file(name), 'utf8');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(text('manifest.json')) as Record<Leg, { file: string; file_sha256: string }>;
const raw = (leg: Leg) => text(`${leg}.outcome.json`);
const recorded = (leg: Leg) => JSON.parse(raw(leg)) as Record<string, any>;
const decode = (payload: Record<string, unknown>): NikaCompileOutcome =>
  compilePayloadFrom(payload, 'http', 'https://nika.example', [1, 2]);
const require = createRequire(import.meta.url);
type Row = (sdk: unknown, door: string, outcome: unknown, config: unknown, wallMs: number) => Record<string, any>;
const { evidenceRow, creationRow } = require('../scripts/packed-consumers/compile-evidence.cjs') as {
  evidenceRow: Row;
  creationRow: Row;
};

describe('the recorded fixtures are the engine owner\'s bytes', () => {
  it.each(LEGS)('%s matches the owner\'s manifest digest', (leg) => {
    expect(sha256(readFileSync(file(manifest[leg].file)))).toBe(manifest[leg].file_sha256);
  });
});

describe('recorded creation outcomes decode exactly', () => {
  it.each(LEGS)('%s returns the engine\'s own objects, every member kept', (leg) => {
    const payload = recorded(leg);
    const outcome = decode(payload);
    expect(outcome.provenance).toBe(payload.provenance);
    expect(JSON.parse(JSON.stringify(outcome))).toEqual({ ...JSON.parse(raw(leg)), ready: payload.status === 'ready' });
  });

  it('settles a composed creation on its final bytes, with the request verbatim and one receipt', () => {
    const outcome = decode(recorded('ready-composed'));
    const settled = outcome.provenance.plan!.document!;
    expect(settled).toMatchObject({ version: 1, base_sha256: null, mode: 'composed' });
    expect(settled.candidate_sha256).toBe(sha256(outcome.candidate!));
    // The intent file has no trailing newline, and the request is exactly its bytes.
    expect(settled.request).toBe(text('intent-stale-filter.txt'));
    const [receipt] = settled.components;
    expect(receipt!.component).toMatchObject({ id: 'block:stale-filter-report',
      release: { version: 'fixture-document-r1', profile: 'nika-knowledge-release-profile/r1' } });
    expect(receipt!.bindings.map((binding) => [binding.path, binding.component_literal, binding.bound])).toEqual([
      ['const.max_age_hours', 48, 48], ['const.records_path', './data/tickets.json', './in/tickets.json'],
      ['const.report_path', './out/stale.json', './out/report.json']]);
    expect(settled.components).toEqual(outcome.provenance.plan!.document_create!.components);
    const made = outcome.provenance.decision!.document_create!;
    // On READY the door's record is restated on the final bytes.
    expect(made.candidate_sha256).toBe(settled.candidate_sha256);
    expect(made.reuse!.references.map((reference) => [reference.id, reference.use]))
      .toEqual([['block:stale-filter-report', 'expanded']]);
  });

  it('settles a written creation with no receipt, its request keeping the trailing newline', () => {
    const outcome = decode(recorded('ready-written'));
    const settled = outcome.provenance.plan!.document!;
    expect(settled).toMatchObject({ version: 1, base_sha256: null, mode: 'written', components: [] });
    expect(settled.candidate_sha256).toBe(sha256(outcome.candidate!));
    expect(settled.request).toBe(text('intent-config-values.txt'));
    expect(settled.request.endsWith('\n')).toBe(true);
    expect(outcome.provenance.decision!.document_create).toMatchObject({ mode: 'written', base_sha256: null,
      operations: 0, candidate_sha256: settled.candidate_sha256 });
  });

  it('settles nothing while a mandatory question is open', () => {
    const outcome = decode(recorded('continuation'));
    expect(outcome).toMatchObject({ status: 'incomplete', ready: false, candidate: null });
    expect(outcome.questions.map((question) => [question.key, question.mandatory]))
      .toEqual([['const.webhook_endpoint', true]]);
    expect(Object.hasOwn(outcome.provenance.plan!, 'document')).toBe(false);
    expect(outcome.provenance.plan!.document_create!.resolved).toBe(text('intent-digest-webhook.txt'));
    expect(outcome.provenance.decision!.document_create!.candidate_sha256).toBeNull();
  });

  it('revises the created bytes by a later change: a revision record, the receipt rebound 48 → 72', () => {
    const created = decode(recorded('edit-created'));
    const revised = decode(recorded('edit-revised'));
    const createdSha = sha256(created.candidate!);
    expect(created.provenance.plan!.document!.candidate_sha256).toBe(createdSha);
    // A change to a settled creation is new work over it, never an answer round of the creation.
    expect(Object.hasOwn(revised.provenance.plan!, 'document')).toBe(false);
    const revision = revised.provenance.plan!.document_revision!;
    expect(revision).toMatchObject({ mode: 'operations', base_sha256: createdSha, changed: ['const.max_age_hours'] });
    expect(revision.candidate_sha256).toBe(sha256(revised.candidate!));
    expect(revised.provenance.plan!.source_revision).toMatchObject({ base_sha256: createdSha,
      candidate_sha256: revision.candidate_sha256 });
    expect(revised.provenance.decision!.document_revision).toEqual(revision);
    const [before] = created.provenance.plan!.document!.components;
    const [after] = revision.components;
    expect(after!.component).toEqual(before!.component);
    expect(after!.bindings[0]).toEqual({ ...before!.bindings[0], bound: 72 });
    expect(after!.bindings.slice(1)).toEqual(before!.bindings.slice(1));
    expect(after!.revises).toBe(createdSha);
    expect(after!.candidate_sha256).toBe(revision.candidate_sha256);
    expect(Object.keys(after!.nodes)).toEqual(Object.keys(before!.nodes));
  });
});

describe('the provider phase reads recorded outcomes as the evidence they are', () => {
  const sdk = { isNikaCompileHeld };

  it('qualifies a recorded ready creation and withholds the continuation', () => {
    const intent = text('intent-stale-filter.txt');
    const composed = creationRow(sdk, 'native', decode(recorded('ready-composed')), { createIntent: intent }, 1);
    expect(composed).toMatchObject({ leg: 'create', exercised: true, status: 'ready',
      settled: { version: 1, base_sha256: null, mode: 'composed', request_is_the_sent_intent: true },
      made: { names_the_candidate_received: true, same_receipts_as_settled: true } });
    const waiting = creationRow(sdk, 'http', decode(recorded('continuation')),
      { createIntent: text('intent-digest-webhook.txt') }, 1);
    expect(waiting).toMatchObject({ exercised: false, settled: null, candidate_sha256: null });
  });

  it('qualifies the recorded revision of the created bytes by the evidence law', () => {
    const created = recorded('edit-created');
    const row = evidenceRow(sdk, 'native', decode(recorded('edit-revised')),
      { base: created.candidate, keptLines: [created.candidate.split('\n')[0]] }, 1);
    expect(row).toMatchObject({ leg: 'edit', exercised: true, status: 'ready', plan_kept: true,
      revision_in: { plan: true, decision: true }, candidate_keeps_comments_and_unicode: true,
      revision: { mode: 'operations', changed: ['const.max_age_hours'], components: 1 } });
  });
});

describe('recorded outcomes over both doors', () => {
  afterEach(() => {
    delete process.env.NIKA_FAKE_COMPILE_OUTCOME;
  });

  it.each(LEGS)('%s decodes identically through native and HTTP', async (leg) => {
    process.env.NIKA_FAKE_COMPILE_OUTCOME = file(`${leg}.outcome.json`);
    const local = await new Nika({ bin: COMPILE_ENGINE }).compile({ intent: 'recorded', authoringModel: 'mock/authoring' });
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse({ engineVersion: '0.123.0', supportedCapabilities: NATIVE_SERVER }))
      .mockResolvedValueOnce(jsonResponse(recorded(leg), 200, { 'Cache-Control': 'no-store', 'Nika-Compile-Replay': REPLAY }));
    const remote = await new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch })
      .compile({ intent: 'recorded', cognition: 'explicitProvider' });
    const { replay_token: _token, judged_answer_round_available: _judged, ...common } = remote;
    expect(common).toEqual(local);
    expect(local.candidate).toBe(recorded(leg).candidate);
    expect(JSON.parse(JSON.stringify(local.provenance))).toEqual(recorded(leg).provenance);
  });
});
