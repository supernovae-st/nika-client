import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import type {
  NikaAuthoringSession,
  NikaSessionAnswered,
  NikaSessionAskedQuestion,
  NikaSessionAuthoringCall,
  NikaSessionAuthoringCalls,
  NikaSessionBinding,
  NikaSessionCandidateFile,
  NikaSessionDelegation,
  NikaSessionIntelligence,
  NikaSessionKnowledge,
  NikaSessionQuestion,
  NikaSessionResult,
  NikaSessionRun,
  NikaSessionRunEnd,
  NikaSessionSnapshot,
  NikaSessionStageTimes,
  NikaSessionWaiting,
  NikaSessionWork,
} from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The work members a Session snapshot gained at the 0.123 integration
// (`1b47f34c0`): each candidate file's exact `content`, the compiler's
// `authoring.draft` and `authoring.calls` receipt, and the configured
// `intelligence`. The fixture's VALUES are synthetic, its shapes the
// producer's; recorded frames from the assembled binary join them once they
// exist. The SDK judges these members where they are and carries the rest.

const FIXTURE = fileURLToPath(new URL('./fixtures/session-host/work-1b47f34c0.json', import.meta.url));
const SESSION_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session.mjs', import.meta.url));
const RECORDED = fileURLToPath(new URL('./fixtures/session-host/e849d08eaf37/native-answers.json', import.meta.url));
const rich = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { authoring: any; intelligence: any };
const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'ab'.repeat(16)}`;
const SECRET = 'sk-planted-secret-value-0123456789';
const CONTENT = '# Digest 🦋\nnika: digest\n# « Relevé — semaine »\ntasks: {}\n';
const WITNESS = 'b'.repeat(64);

function work(extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    contract: 'nika/session-work@0', root: '/srv/project', request: { goal: null, decisions: [], unresolved: [] },
    authoring: structuredClone(rich.authoring), intelligence: structuredClone(rich.intelligence),
    waiting: { kind: 'consent', proposal: 'p'.repeat(64) },
    candidate: { proposal: 'p'.repeat(64), aside: false, rehearsed: false, run_after_save: false, revision: null,
      files: [{ path: 'digest.nika', landing: 'create', workflow: true, bytes: WITNESS, replaces: null, audit: null,
        content: CONTENT }] },
    saved: null, requested: null, run: null,
    rail: { draft: 'working', saved: 'pending', checked: 'pending', active: 'pending', run: 'pending' },
    ...extra,
  };
}
const opened = (body: Record<string, any>) => ({ contract: CONTRACT, session: SESSION, frame: 'opened', event: 1,
  snapshot: { snapshot: `snp_${'0'.repeat(32)}`, seq: 1, busy: null, work: body }, notices: [] });
/** A revised candidate's compact revision, in the shape `nika-session-change` `work.rs` serializes. */
const revision = () => ({
  mode: 'operations', base_sha256: 'c'.repeat(64), candidate_sha256: 'd'.repeat(64), changed: ['const.max_age_hours'],
  preservation: 'by construction: each component\'s entries inserted or rebound in place; not re-verified byte by byte',
  components: [{ id: 'block:stale-filter-report', version: 'fixture-document-r1', release: '2'.repeat(64),
    file_sha256: null, bindings: [{ path: 'const.max_age_hours', value: 72 }, { path: 'const.records_path',
      value: './in/tickets.json' }], witness: 'expanded', future_use_member: 'kept' }],
  future_revision_member: { additive: true },
});

/** An observed Run as `nika-session-change` `work.rs` serializes it: every member, `null` where unobserved. */
const observedRun = (): Record<string, any> => ({ current: true, workflow: 'digest.nika', end: { end: 'succeeded' },
  trace: '/srv/project/.nika/traces/run.ndjson', execution: null, workflow_sha256: null, chain_head: null,
  chain_len: null });

// The carrier's wire example of `work.authoring.calls` at engine `2db30c6e2`
// (`nika-session-change` `AuthoringCalls` with `per_call`, introduced at
// `ca5845b85`, its hyphenated roles kept since `2db30c6e2`), projected by
// engine code from the synthetic receipt of its allowlist test, not a live
// call; keys sorted; byte for byte: an answered `document` call; a failed
// `document-repair` call whose malformed digest, unrecorded references and
// unsafe effort the engine wrote as `null`; and a `revision` call cut at its
// output limit, its usage unreported.
const CALLS_WIRE = fileURLToPath(new URL('./fixtures/session-host/work-authoring-calls-2db30c6e2.json',
  import.meta.url));
const wire = (): Record<string, any> => JSON.parse(readFileSync(CALLS_WIRE, 'utf8'));

// The carrier's wire example of `work.answered`: every act form, `seat_default` included, generated
// by the engine's own serializer (`nika-session-change` `Answered`/`AnswerAct`) at `2812ea11b`;
// keys sorted; byte for byte.
const ANSWERED_WIRE = fileURLToPath(new URL('./fixtures/session-host/work-answered-2812ea11b.json', import.meta.url));
const acts = (): Record<string, Record<string, any>> => JSON.parse(readFileSync(ANSWERED_WIRE, 'utf8'));
// The answer records the real binaries wrote through this SDK's native door (no model, no key in
// the launch environment), each row named by the act the engine recorded.
const RECORDED_ANSWERS = ['f1dad1ef5/native-answered.json', 'fbfb1dccc/native-default-answer.json'];
const recordedAnswers = (file: string): { rows: Record<string, any>[] } =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/session-host/${file}`, import.meta.url)), 'utf8'));
// The creation record of an actual loopback CREATE as the engine projects it under
// `work.candidate.revision` at `2812ea11b` (composed, no base, its component expanded on the
// proposed bytes), from the carrier, byte for byte.
const CREATED = fileURLToPath(new URL('./fixtures/session-host/candidate-revision-created-2812ea11b.json',
  import.meta.url));

// The wire the engine's own serializer tests assert at `ad70c9aa7` for the members the 0.123
// integration batches added: `knowledge`, `authoring.stages` and the `knowledge_choice` wait
// (`5f1e91c6f`), the conversation's `bindings`, `delegations`, `questions` and the `questions`
// wait (`6d217dfba`), and `run.sealed` (`ad70c9aa7`). Byte for byte where a test asserts a whole
// value, completed by the struct's field order where it asserts a part; never a live call.
const BATCHES = fileURLToPath(new URL('./fixtures/session-host/work-ad70c9aa7.json', import.meta.url));
const batches = (): Record<string, any> => JSON.parse(readFileSync(BATCHES, 'utf8'));
/** The texts the engine's host writes when a Stop reached a Run (`nika-session-host` `worker.rs`, `ad70c9aa7`). */
const RUN_STOPPED = 'the Stop reached the run: it stopped at a wave boundary · the work in flight completed and is '
  + 'counted · unstarted tasks were cancelled · its trace is sealed';
const RUN_ABORTED = 'the run took the Stop but ended without sealing its trace: it was cut mid-flight (an abort or a '
  + 'crash) · its trace is incomplete · nothing was rolled back and the work in flight has an unknown outcome';
const decoded = (body: Record<string, any>): NikaSessionWork =>
  (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;

/** A waiting question as `nika-session-change` serializes it (host 46817419a): no options unless a choice has some. */
const question = (): Record<string, any> => ({ key: 'model', label: 'Which provider/model runs the language steps?',
  type: 'text', why: 'The compiler cannot invent this authoring value.', mandatory: true });

function refusal(body: Record<string, any>): NikaProtocolError {
  try {
    sessionFrame(opened(body), 'http');
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

describe('Session work members', () => {
  it('returns the engine\'s own work, every member kept exactly', () => {
    const frame = opened(work());
    const raw = JSON.stringify(frame);
    expect(sessionFrame(frame, 'http')).toBe(frame);
    expect(JSON.stringify(frame)).toBe(raw);
  });

  it('types the exact candidate bytes, the draft, the calls receipt and the configured intelligence', () => {
    const typed = (sessionFrame(opened(work()), 'native-process').snapshot as { work: NikaSessionWork }).work;
    const [file]: NikaSessionCandidateFile[] = typed.candidate!.files;
    expect(file!.content).toBe(CONTENT);
    expect(file!.bytes).toBe(WITNESS);
    expect(typed.authoring!.draft).toBe(CONTENT);
    const calls: NikaSessionAuthoringCalls = typed.authoring!.calls!;
    // Requested is what the calls asked for; the backend reports what answered; unknown usage stays null.
    expect([calls.requested_model, calls.input_tokens, calls.output_tokens, calls.backend?.observed_model])
      .toEqual(['claude-code/opus', null, null, 'claude-opus']);
    expect(calls.future_calls_member).toBe('kept');
    const intelligence: NikaSessionIntelligence = typed.intelligence!;
    expect(intelligence.selected).toMatchObject({ kind: 'harness', via: 'claude-code', transport: 'acp', model: null,
      ready: true });
    expect(intelligence.author).toEqual({ kind: 'harness', model: null, seat: 'claude-code', transport: 'acp', why: null });
    expect(intelligence.decision).toEqual({ model: 'typesafe/jev', refusal: null });
    expect(intelligence.effort).toBe('max');
    expect(intelligence.future_intelligence_member).toEqual({ additive: true });
  });

  it.each(['http', 'native-process'] as const)('types each authoring call the receipt recorded (%s)', (transport) => {
    const body = work();
    body.authoring.calls = { ...wire(), future_calls_member: 'kept' };
    body.authoring.calls.per_call[0].future_call_member = 'kept';
    const frame = opened(body);
    const raw = JSON.stringify(frame);
    expect(sessionFrame(frame, transport)).toBe(frame);
    expect(JSON.stringify(frame)).toBe(raw);
    const calls: NikaSessionAuthoringCalls = (frame.snapshot.work as NikaSessionWork).authoring!.calls!;
    const [answered, failed, cut]: NikaSessionAuthoringCall[] = calls.per_call!;
    expect(calls.per_call).toHaveLength(3);
    expect(answered).toEqual({ call: 'document', instruction_sha256: 'a'.repeat(64),
      schema_sha256: '0123456789abcdef'.repeat(4), message_bytes: 4096, references: 2, max_output_tokens: 16384,
      timeout_ms: 600000, elapsed_ms: 700, stop_reason: 'EndTurn', failure_kind: null, usage_reported: true,
      input_tokens: 1000, output_tokens: 250, reasoning_effort: 'high', reasoning_tokens: null,
      future_call_member: 'kept' });
    // A failed repair names the engine's kind; what the receipt held unsafely or not at all stays null.
    expect(failed).toMatchObject({ call: 'document-repair', instruction_sha256: null, references: null,
      stop_reason: null, failure_kind: 'timeout', usage_reported: null, input_tokens: null, output_tokens: null,
      reasoning_effort: null });
    // A call cut at its output limit: usage unreported is `false` with unknown tokens, never `0`.
    expect(cut).toEqual({ call: 'revision', instruction_sha256: null, schema_sha256: null, message_bytes: 128,
      references: null, max_output_tokens: null, timeout_ms: null, elapsed_ms: null, stop_reason: 'MaxTokens',
      failure_kind: null, usage_reported: false, input_tokens: null, output_tokens: null, reasoning_effort: null,
      reasoning_tokens: null });
    // The totals stay the receipt's own, never reconciled with the rows: unknown output stays null.
    expect([calls.calls, calls.elapsed_ms, calls.input_tokens, calls.output_tokens]).toEqual([2, 900, 1000, null]);
  });

  it('keeps the engine\'s words as it writes them, never a closed vocabulary', () => {
    const body = work();
    body.authoring.calls = wire();
    // Actual repair roles, and words this SDK has not met: carried, not re-judged.
    body.authoring.calls.per_call[2].call = 'revision-repair';
    body.authoring.calls.per_call[2].stop_reason = 'max_turn_requests';
    body.authoring.calls.per_call[0].reasoning_effort = 'xhigh';
    const typed = (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;
    const rows = typed.authoring!.calls!.per_call!;
    expect(rows.map((entry) => entry.call)).toEqual(['document', 'document-repair', 'revision-repair']);
    expect([rows[2]!.stop_reason, rows[0]!.reasoning_effort]).toEqual(['max_turn_requests', 'xhigh']);
  });

  it.each(Object.keys(acts()))('types what the last line did to its question: %s', (form) => {
    const record = acts()[form]!;
    const frame = opened(work({ waiting: { kind: 'free' }, candidate: null, answered: record }));
    const raw = JSON.stringify(frame);
    expect(sessionFrame(frame, 'native-process')).toBe(frame);
    expect(JSON.stringify(frame)).toBe(raw);
    const answered: NikaSessionAnswered = (frame.snapshot.work as NikaSessionWork).answered!;
    expect(answered).toEqual(record);
    expect(answered.question).toBe('0f'.repeat(32));
  });

  it.each(RECORDED_ANSWERS)('decodes every answer record a real binary wrote (%s), unchanged', (file) => {
    for (const row of recordedAnswers(file).rows) {
      const waiting = row.after_waiting.kind === 'question' ? row.after_waiting : { kind: row.after_waiting.kind };
      const frame = opened(work({ waiting, candidate: null, answered: row.answered }));
      const raw = JSON.stringify(frame);
      expect(sessionFrame(frame, 'native-process')).toBe(frame);
      expect(JSON.stringify(frame)).toBe(raw);
      // Each row is named by the act the engine recorded, and rereading returned the same record.
      expect(row.name.startsWith(row.answered.act)).toBe(true);
      expect(row.reread_identical).toBe(true);
    }
  });

  it('reads the recorded acts as the engine wrote them, a seat default apart from a typed seat', () => {
    const byName = Object.fromEntries(RECORDED_ANSWERS.flatMap((file) => recordedAnswers(file).rows)
      .map((row) => [row.name, row]));
    expect(byName.refused_empty_answer!.answered).toMatchObject({ act: 'refused', class: 'empty_answer' });
    expect(byName.dropped!.answered).toMatchObject({ act: 'dropped', key: 'model' });
    expect(byName.waits_unpriced_model!.answered).toMatchObject({ act: 'waits', key: 'model' });
    // A sentence meant as a restatement, bound whole to a text question: a bound record, never `restated`.
    expect(byName.bound_as_typed_sentence!.answered).toMatchObject({ act: 'bound', reading: 'as_typed',
      value: byName.bound_as_typed_sentence!.line });
    expect(byName.bound_seat_default!.answered).toMatchObject({ act: 'bound', reading: 'seat_default',
      value: 'mock/echo' });
    expect(byName.bound_as_typed_seat!.answered).toMatchObject({ act: 'bound', reading: 'as_typed',
      value: 'mock/echo' });
  });

  it.each(['http', 'native-process'] as const)('types a created candidate\'s creation record, no base (%s)', (transport) => {
    const created = JSON.parse(readFileSync(CREATED, 'utf8'));
    const body = work();
    body.candidate.revision = created;
    const frame = opened(body);
    const raw = JSON.stringify(frame);
    expect(sessionFrame(frame, transport)).toBe(frame);
    expect(JSON.stringify(frame)).toBe(raw);
    const revision = (frame.snapshot.work as NikaSessionWork).candidate!.revision!;
    expect([revision.mode, revision.base_sha256, revision.candidate_sha256]).toEqual(['composed', null,
      created.candidate_sha256]);
    expect(revision.components.map((use) => [use.id, use.witness])).toEqual([['block:typed-inputs-outputs',
      'expanded']]);
  });

  it('carries acts, readings and classes this SDK has not met, and no record when no line answered', () => {
    const future = { question: '0f'.repeat(32), act: 'deferred', until: 'the next run', future_member: 'kept' };
    // An act spelled like an object's own member is one more unknown act, never a lookup into it.
    const inherited = { question: '0f'.repeat(32), act: 'constructor' };
    const unknownWords = [future, inherited, { ...acts().bound_as_typed!, reading: 'spoken' },
      { ...acts().refused!, class: 'quota_reached' }];
    for (const record of unknownWords) {
      const typed = (sessionFrame(opened(work({ answered: record })), 'http').snapshot as { work: NikaSessionWork }).work;
      expect(typed.answered).toEqual(record);
    }
    expect((sessionFrame(opened(work()), 'http').snapshot as { work: NikaSessionWork }).work.answered).toBeUndefined();
  });

  it('reads a receipt without calls, and an engine that does not project them', () => {
    const empty = work();
    empty.authoring.calls = { ...wire(), per_call: [] };
    expect((sessionFrame(opened(empty), 'http').snapshot as { work: NikaSessionWork }).work.authoring!.calls!.per_call)
      .toEqual([]);
    const older = (sessionFrame(opened(work()), 'http').snapshot as { work: NikaSessionWork }).work;
    expect('per_call' in older.authoring!.calls!).toBe(false);
  });

  it('types a revised candidate\'s compact revision, bound to its bytes', () => {
    const body = work();
    body.candidate.revision = revision();
    const typed = (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;
    const revised = typed.candidate!.revision!;
    expect(revised).toMatchObject({ mode: 'operations', base_sha256: 'c'.repeat(64), changed: ['const.max_age_hours'] });
    const [use] = revised.components;
    expect(use!.bindings[0]).toEqual({ path: 'const.max_age_hours', value: 72 });
    expect(use!.witness).toBe('expanded');
    expect(use!.future_use_member).toBe('kept');
    expect(revised.future_revision_member).toEqual({ additive: true });
    expect(work().candidate.revision).toBeNull();
  });

  it('keeps explicit null apart from absence', () => {
    const body = work({ intelligence: { author: { kind: 'deterministic', model: null, seat: null, transport: null,
      why: 'no selection: the deterministic reading prepares' }, selected: null, decision: null, effort: null } });
    body.authoring.calls = null;
    body.authoring.draft = null;
    body.authoring.candidate = null;
    const typed = (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;
    expect(typed.authoring).toMatchObject({ calls: null, draft: null, candidate: null });
    expect(typed.intelligence).toMatchObject({ selected: null, decision: null, effort: null });
    const absent = work();
    delete absent.intelligence;
    delete absent.authoring.calls;
    delete absent.candidate.files[0].content;
    const old = (sessionFrame(opened(absent), 'http').snapshot as { work: NikaSessionWork }).work;
    expect('intelligence' in old).toBe(false);
    expect('calls' in old.authoring!).toBe(false);
    expect('content' in old.candidate!.files[0]!).toBe(false);
  });

  it('types the observed Run, an unnamed identity kept null and never filled', () => {
    const body = work({ waiting: { kind: 'free' }, candidate: null,
      run: { ...observedRun(), end: { end: 'unknown', exit: 7 }, future_run_member: 'kept' } });
    const typed = (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;
    const run: NikaSessionRun = typed.run!;
    expect(run).toBe(body.run);
    expect(run.workflow_sha256).toBeNull();
    expect(run.chain_len).toBeNull();
    const end: NikaSessionRunEnd = run.end!;
    expect(end).toEqual({ end: 'unknown', exit: 7 });
    expect(run.future_run_member).toBe('kept');
    const named = work({ run: { ...observedRun(), execution: 'exe-1', workflow_sha256: 'a'.repeat(64),
      chain_head: 'h'.repeat(64), chain_len: 9 } });
    expect((sessionFrame(opened(named), 'http').snapshot as { work: NikaSessionWork }).work.run)
      .toMatchObject({ execution: 'exe-1', chain_len: 9 });
  });

  it('types the waiting question as the compiler asked it, a choice\'s options in its order', () => {
    const asked = { key: 'tone', label: 'Which tone?', type: 'choice', why: 'The digest reads it.', mandatory: false,
      options: [{ key: 'warm', label: 'Warm' }, { key: 'dry', label: 'Dry', future_option_member: 'kept' }],
      future_question_member: 'kept' };
    const waiting = (key: string) => ({ kind: 'question', key, id: 'q'.repeat(64) });
    const body = work({ waiting: waiting('tone'), candidate: null, question: asked });
    const typed = (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;
    const found: NikaSessionQuestion = typed.question!;
    expect(found).toBe(asked);
    expect(found.options!.map((option) => option.key)).toEqual(['warm', 'dry']);
    expect([found.future_question_member, found.options![1]!.future_option_member]).toEqual(['kept', 'kept']);
    // A question without options, a shape the engine does not name, and no question at all.
    for (const type of ['text', 'literal', 'other']) {
      const plain = work({ waiting: waiting('model'), candidate: null, question: { ...question(), type } });
      expect((sessionFrame(opened(plain), 'http').snapshot as { work: NikaSessionWork }).work.question)
        .toEqual({ ...question(), type });
    }
    expect((sessionFrame(opened(work()), 'http').snapshot as { work: NikaSessionWork }).work.question).toBeUndefined();
  });

  it('decodes every Run the merged host recorded, unchanged', () => {
    const review = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/session-host/eb89e1893/http-run-review.json',
      import.meta.url)), 'utf8')) as { answered: Record<string, any> }[];
    const runs = review.map((entry) => entry.answered).filter((frame) => frame.snapshot?.work?.run);
    expect(runs.length).toBeGreaterThan(0);
    for (const frame of runs) {
      const raw = JSON.stringify(frame);
      expect(sessionFrame(frame, 'http')).toBe(frame);
      expect(JSON.stringify(frame)).toBe(raw);
      expect(frame.snapshot.work.run).toMatchObject({ current: true, end: { end: 'succeeded' }, workflow_sha256: null });
    }
  });

  it('decodes every frame the host recorded before these members, unchanged', () => {
    const frames = JSON.parse(readFileSync(RECORDED, 'utf8')) as Record<string, any>[];
    for (const frame of frames) {
      const raw = JSON.stringify(frame);
      expect(sessionFrame(frame, 'native-process')).toBe(frame);
      expect(JSON.stringify(frame)).toBe(raw);
      if (frame.snapshot?.work) expect('intelligence' in frame.snapshot.work).toBe(false);
    }
  });

  it('decodes every frame a real ad70c9aa7 binary wrote through the native door, unchanged', () => {
    const walk = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/session-host/ad70c9aa7/native-walk.json',
      import.meta.url)), 'utf8')) as { step: string; frame?: Record<string, any> }[];
    const frames = walk.filter((entry) => entry.frame !== undefined);
    expect(frames.map((entry) => entry.step)).toEqual(['open', 'copy', 'consent', 'run', 'details', 'close']);
    for (const { frame } of frames) {
      const raw = JSON.stringify(frame);
      expect(sessionFrame(frame, 'native-process')).toBe(frame);
      expect(JSON.stringify(frame)).toBe(raw);
    }
    const work = (step: string): NikaSessionWork => frames.find((entry) => entry.step === step)!.frame!.snapshot.work;
    // Every snapshot states the knowledge it reads: the release this build embeds, admitted by default.
    for (const step of ['open', 'copy', 'consent', 'run', 'close']) {
      expect(work(step).knowledge).toMatchObject({ state: 'admitted', source: 'embedded', by: 'default' });
    }
    expect(work('open').knowledge!.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The deterministic compile states no other stage; the observed Run sealed its journal.
    expect(work('copy').authoring!.stages).toBeNull();
    expect(work('run').run).toMatchObject({ current: true, end: { end: 'succeeded' }, sealed: true });
    expect(work('run').run!.workflow_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['admitted', 'refused', 'unread'] as const)('types the knowledge the Session reads: %s', (state) => {
    const body = work({ knowledge: batches().knowledge[state] });
    const knowledge: NikaSessionKnowledge = decoded(body).knowledge!;
    expect(knowledge).toBe(body.knowledge);
    expect(knowledge).toEqual(batches().knowledge[state]);
  });

  it('carries a knowledge state this SDK has not met, and no knowledge when none is stated', () => {
    const later = { state: 'pinned_elsewhere', future_knowledge_member: 'kept' };
    expect(decoded(work({ knowledge: later })).knowledge).toEqual(later);
    const nameless = { ...batches().knowledge.admitted, version: null };
    expect(decoded(work({ knowledge: nameless })).knowledge!.version).toBeNull();
    expect(decoded(work()).knowledge).toBeUndefined();
  });

  it('types the line a refused knowledge source holds, exactly as typed', () => {
    const body = work({ waiting: batches().waiting.knowledge_choice, candidate: null,
      knowledge: batches().knowledge.refused });
    const waiting: NikaSessionWaiting = decoded(body).waiting;
    expect(waiting).toBe(body.waiting);
    expect(waiting.line).toBe('  summarize « today\'s » news\n');
  });

  it('types the compile stage times as its decision record states them, never summed', () => {
    const body = work();
    body.authoring.stages = batches().stages;
    const stages: NikaSessionStageTimes = decoded(body).authoring!.stages!;
    expect(stages).toBe(body.authoring.stages);
    expect(stages.qualification_ms).toBe(41870);
    // A trial never attempted has no time: `null`, never `0`.
    expect(stages.trials.map((trial) => [trial.attempt, trial.elapsed_ms, trial.runtime_bound_ms]))
      .toEqual([['completed', 1912, 30000], ['never_attempted', null, 30000]]);
    // A record that states neither stage, and an engine before stages.
    const quiet = work();
    quiet.authoring.stages = null;
    expect(decoded(quiet).authoring!.stages).toBeNull();
    expect('stages' in decoded(work()).authoring!).toBe(false);
  });

  it('types a conversation an intelligence leads: its values, delegations and questions asked together', () => {
    const { bindings, delegations, questions } = batches().conversation;
    const body = work({ waiting: batches().waiting.questions, candidate: null, bindings, delegations, questions });
    const typed = decoded(body);
    const values: NikaSessionBinding[] = typed.bindings!;
    expect(values).toBe(body.bindings);
    expect(values.map((value) => [value.role, value.value, value.provenance.kind, value.provenance.message]))
      .toEqual([['output_path', './news/digest.md', 'offered', 'u2'],
        ['read_source', 'https://www.lemonde.fr/', 'delegated', 'u1']]);
    expect(values[0]!.provenance).toMatchObject({ question: 'plan', option: 'recommended' });
    expect(values[1]!.provenance.excerpt).toBe('tu les choisis');
    const delegated: NikaSessionDelegation[] = typed.delegations!;
    expect(delegated).toEqual([{ message: 'u1', excerpt: 'tu les choisis', scope: 'read_source' }]);
    const asked: NikaSessionAskedQuestion[] = typed.questions!;
    expect(asked.map((question) => [question.id, question.key, question.state])).toEqual([
      ['witness-plan', 'plan', 'open'], ['witness-token', 'token', 'after']]);
    expect(typed.waiting.ids).toEqual(['witness-plan']);
    expect(asked[0]!.options).toEqual([{ key: 'recommended', label: 'Oui', recommended: true,
      values: [{ role: 'output_path', value: './news/digest.md' }] }]);
    expect([asked[0]!.free_text, asked[0]!.multi_select, asked[1]!.after]).toEqual([true, false, ['plan']]);
  });

  it('carries what a conversation member gains later, and none of its keys without a leading intelligence', () => {
    const { questions } = batches().conversation;
    // A model's facts on a `run_model` offer, as the next batch adds them: carried, not judged.
    questions[0].options[0].values[0] = { role: 'run_model', value: 'deepseek/deepseek-v4-pro',
      model: { context_window: 1000000 } };
    expect(decoded(work({ questions })).questions![0]!.options[0]!.values[0]!.model)
      .toEqual({ context_window: 1000000 });
    const plain = decoded(work());
    for (const key of ['bindings', 'delegations', 'questions']) expect(key in plain).toBe(false);
  });

  it('tells a Run that sealed its journal from one cut mid-flight, and an engine before it from both', () => {
    const { stopped, cut } = batches().runs;
    const sealed = (run: Record<string, any>) => {
      const typed: NikaSessionRun = decoded(work({ waiting: { kind: 'free' }, candidate: null, run })).run!;
      expect(typed).toBe(run);
      return [typed.end!.end, typed.sealed];
    };
    expect([sealed(stopped), sealed(cut)]).toEqual([['interrupted', true], ['interrupted', false]]);
    // An engine before the flag writes none: absent, never assumed either way.
    expect(sealed(observedRun())).toEqual(['succeeded', undefined]);
  });

  it('carries the Stop vocabulary of engine ad70c9aa7: a stopping turn, its receipt and the Run outcomes', () => {
    const snapshot = (busy: Record<string, unknown> | null): NikaSessionSnapshot => ({
      snapshot: `snp_${'1'.repeat(32)}`, seq: 4, busy: busy as NikaSessionSnapshot['busy'],
      work: work({ waiting: { kind: 'free' }, candidate: null }) as NikaSessionWork });
    const stopping = { contract: CONTRACT, session: SESSION, frame: 'snapshot',
      snapshot: snapshot({ command: 'c-9', phase: 'stopping', stop_requested: true }) };
    expect(sessionFrame(stopping, 'native-process')).toBe(stopping);
    const receipt = { contract: CONTRACT, session: SESSION, frame: 'result', command: 's-9', op: 'stop',
      replayed: false, receipt: 'run_stopping', target: 'c-9',
      snapshot: snapshot({ command: 'c-9', phase: 'stopping', stop_requested: true }) };
    const stopped = sessionFrame(receipt, 'native-process') as NikaSessionResult;
    expect([stopped.receipt, stopped.target]).toEqual(['run_stopping', 'c-9']);
    for (const [kind, text] of [['run_stopped', RUN_STOPPED], ['run_aborted', RUN_ABORTED]]) {
      const settled = { contract: CONTRACT, session: SESSION, frame: 'result', command: 'c-9', op: 'submit',
        replayed: false, outcomes: [{ kind: 'run_requested', text: 'run held.nika' }, { kind, text }],
        snapshot: snapshot(null) };
      const raw = JSON.stringify(settled);
      expect((sessionFrame(settled, 'http') as NikaSessionResult).outcomes!.map((outcome) => outcome.kind))
        .toEqual(['run_requested', kind]);
      expect(JSON.stringify(settled)).toBe(raw);
    }
  });

  const malformed: [string, (body: Record<string, any>) => void, RegExp][] = [
    ['candidate files as an object', (b) => { b.candidate.files = {}; }, /work\.candidate\.files is not a list/],
    ['a candidate without its files', (b) => { delete b.candidate.files; }, /work\.candidate\.files is absent/],
    ['a file that is not an object', (b) => { b.candidate.files = ['digest.nika']; },
      /work\.candidate\.files\[0\] is not an object/],
    ['a file without its path', (b) => { delete b.candidate.files[0].path; }, /work\.candidate\.files\[0\]\.path is absent/],
    ['a witness that is not hex', (b) => { b.candidate.files[0].bytes = SECRET; },
      /work\.candidate\.files\[0\]\.bytes is not a witness/],
    ['content as a list of lines', (b) => { b.candidate.files[0].content = ['nika: digest']; },
      /work\.candidate\.files\[0\]\.content is not text/],
    ['a replaced witness that is not hex', (b) => { b.candidate.files[0].replaces = 'old'; },
      /work\.candidate\.files\[0\]\.replaces is neither a witness nor null/],
    ['a workflow flag as text', (b) => { b.candidate.files[0].workflow = 'yes'; },
      /work\.candidate\.files\[0\]\.workflow is not a boolean/],
    ['an authoring witness that is not hex', (b) => { b.authoring.candidate = SECRET; },
      /work\.authoring\.candidate is neither a witness nor null/],
    ['a draft as a number', (b) => { b.authoring.draft = 7; }, /work\.authoring\.draft is neither text nor null/],
    ['calls as a list', (b) => { b.authoring.calls = []; }, /work\.authoring\.calls is not an object/],
    ['calls without the requested model', (b) => { delete b.authoring.calls.requested_model; },
      /work\.authoring\.calls\.requested_model is absent/],
    ['a negative call count', (b) => { b.authoring.calls.calls = -1; }, /work\.authoring\.calls\.calls is not a count/],
    ['unknown usage written as text', (b) => { b.authoring.calls.input_tokens = 'unknown'; },
      /work\.authoring\.calls\.input_tokens is neither a count nor null/],
    ['a fractional elapsed time', (b) => { b.authoring.calls.elapsed_ms = 1.5; },
      /work\.authoring\.calls\.elapsed_ms is not a count/],
    ['a backend as text', (b) => { b.authoring.calls.backend = 'acp'; }, /work\.authoring\.calls\.backend is not an object/],
    ['per-call facts as an object', (b) => { b.authoring.calls = { ...wire(), per_call: {} }; },
      /work\.authoring\.calls\.per_call is not a list/],
    ['a call as text', (b) => { b.authoring.calls = { ...wire(), per_call: [SECRET] }; },
      /work\.authoring\.calls\.per_call\[0\] is not an object/],
    ['a call without its stop reason member', (b) => { b.authoring.calls = wire();
      delete b.authoring.calls.per_call[0].stop_reason; },
    /work\.authoring\.calls\.per_call\[0\]\.stop_reason is absent/],
    ['a role as a number', (b) => { b.authoring.calls = wire(); b.authoring.calls.per_call[1].call = 2; },
      /work\.authoring\.calls\.per_call\[1\]\.call is neither text nor null/],
    ['an effort as a list', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[0].reasoning_effort = [SECRET]; },
    /work\.authoring\.calls\.per_call\[0\]\.reasoning_effort is neither text nor null/],
    ['a failure kind as an object', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[1].failure_kind = { kind: 'timeout' }; },
    /work\.authoring\.calls\.per_call\[1\]\.failure_kind is neither text nor null/],
    ['an instruction digest in capitals', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[0].instruction_sha256 = 'A'.repeat(64); },
    /work\.authoring\.calls\.per_call\[0\]\.instruction_sha256 is neither a witness nor null/],
    ['negative message bytes', (b) => { b.authoring.calls = wire(); b.authoring.calls.per_call[0].message_bytes = -1; },
      /work\.authoring\.calls\.per_call\[0\]\.message_bytes is neither a count nor null/],
    ['reasoning tokens written as text', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[1].reasoning_tokens = '0'; },
    /work\.authoring\.calls\.per_call\[1\]\.reasoning_tokens is neither a count nor null/],
    ['usage reported as text', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[0].usage_reported = 'true'; },
    /work\.authoring\.calls\.per_call\[0\]\.usage_reported is neither a boolean nor null/],
    ['intelligence as text', (b) => { b.intelligence = 'claude'; }, /work\.intelligence is not an object/],
    ['intelligence without its author', (b) => { delete b.intelligence.author; }, /work\.intelligence\.author is absent/],
    ['an author without its kind', (b) => { delete b.intelligence.author.kind; },
      /work\.intelligence\.author\.kind is absent/],
    ['an author model as a number', (b) => { b.intelligence.author.model = 4; },
      /work\.intelligence\.author\.model is neither text nor null/],
    ['a selection whose readiness is text', (b) => { b.intelligence.selected.ready = 'true'; },
      /work\.intelligence\.selected\.ready is not a boolean/],
    ['a selection without its kind', (b) => { delete b.intelligence.selected.kind; },
      /work\.intelligence\.selected\.kind is absent/],
    ['a decision seat without its model', (b) => { delete b.intelligence.decision.model; },
      /work\.intelligence\.decision\.model is absent/],
    ['an effort as a number', (b) => { b.intelligence.effort = 3; }, /work\.intelligence\.effort is neither text nor null/],
    ['a revision as text', (b) => { b.candidate.revision = 'operations'; },
      /work\.candidate\.revision is not an object/],
    ['a revision without its candidate digest', (b) => { b.candidate.revision = revision();
      delete b.candidate.revision.candidate_sha256; }, /work\.candidate\.revision\.candidate_sha256 is absent/],
    ['a revision base that is not hex', (b) => { b.candidate.revision = { ...revision(), base_sha256: SECRET }; },
      /work\.candidate\.revision\.base_sha256 is neither a witness nor null/],
    ['a revision without its base member', (b) => { b.candidate.revision = revision();
      delete b.candidate.revision.base_sha256; }, /work\.candidate\.revision\.base_sha256 is absent/],
    ['changes with a number', (b) => { b.candidate.revision = { ...revision(), changed: ['const.x', 2] }; },
      /work\.candidate\.revision\.changed is not a list of text/],
    ['components as an object', (b) => { b.candidate.revision = { ...revision(), components: {} }; },
      /work\.candidate\.revision\.components is not a list/],
    ['a component without its id', (b) => { b.candidate.revision = revision();
      delete b.candidate.revision.components[0].id; }, /work\.candidate\.revision\.components\[0\]\.id is absent/],
    ['a component witness as a number', (b) => { b.candidate.revision = revision();
      b.candidate.revision.components[0].witness = 1; },
    /work\.candidate\.revision\.components\[0\]\.witness is not text/],
    ['a binding without its value', (b) => { b.candidate.revision = revision();
      delete b.candidate.revision.components[0].bindings[0].value; },
    /work\.candidate\.revision\.components\[0\]\.bindings\[0\]\.value is absent/],
    ['a component file digest that is not hex', (b) => { b.candidate.revision = revision();
      b.candidate.revision.components[0].file_sha256 = 'file'; },
    /work\.candidate\.revision\.components\[0\]\.file_sha256 is neither a witness nor null/],
    ['a Run as text', (b) => { b.run = 'succeeded'; }, /work\.run is neither an object nor null/],
    ['a Run whose currency is text', (b) => { b.run = { ...observedRun(), current: 'true' }; },
      /work\.run\.current is not a boolean/],
    ['a Run without its source hash member', (b) => { b.run = observedRun(); delete b.run.workflow_sha256; },
      /work\.run\.workflow_sha256 is absent/],
    ['a source hash as a number', (b) => { b.run = { ...observedRun(), workflow_sha256: 7 }; },
      /work\.run\.workflow_sha256 is neither text nor null/],
    ['a journal length as text', (b) => { b.run = { ...observedRun(), chain_len: '9' }; },
      /work\.run\.chain_len is neither a count nor null/],
    ['an end without its word', (b) => { b.run = { ...observedRun(), end: { exit: 7 } }; },
      /work\.run\.end\.end is absent/],
    ['an exit as text', (b) => { b.run = { ...observedRun(), end: { end: 'unknown', exit: 'seven' } }; },
      /work\.run\.end\.exit is not a count/],
    // The engine leaves the question out when none waits: a written `null` is another shape.
    ['a question as null', (b) => { b.question = null; }, /work\.question is not an object/],
    ['a question without its label', (b) => { b.question = question(); delete b.question.label; },
      /work\.question\.label is absent/],
    ['a question type as a number', (b) => { b.question = { ...question(), type: 1 }; },
      /work\.question\.type is not text/],
    ['a mandatory flag as text', (b) => { b.question = { ...question(), mandatory: 'yes' }; },
      /work\.question\.mandatory is not a boolean/],
    ['options as an object', (b) => { b.question = { ...question(), type: 'choice', options: {} }; },
      /work\.question\.options is not a list/],
    ['an option without its label', (b) => { b.question = { ...question(), type: 'choice', options: [{ key: 'a' }] }; },
      /work\.question\.options\[0\]\.label is absent/],
    // The engine leaves `answered` out when no line answered: a written `null` is another shape.
    ['an answer record as null', (b) => { b.answered = null; }, /work\.answered is not an object/],
    ['an answer record without its question', (b) => { b.answered = acts().dropped; delete b.answered.question; },
      /work\.answered\.question is absent/],
    ['an act as a number', (b) => { b.answered = { ...acts().dropped, act: 3 }; }, /work\.answered\.act is not text/],
    ['a bound answer without its value', (b) => { b.answered = acts().bound_offered_key; delete b.answered.value; },
      /work\.answered\.value is absent/],
    ['a reading as a list', (b) => { b.answered = { ...acts().bound_model_read, reading: [SECRET] }; },
      /work\.answered\.reading is not text/],
    ['a wait without its reason', (b) => { b.answered = acts().waits; delete b.answered.why; },
      /work\.answered\.why is absent/],
    ['a refusal class as an object', (b) => { b.answered = { ...acts().refused, class: { word: 'stale' } }; },
      /work\.answered\.class is not text/],
    ['a restatement without its key', (b) => { b.answered = acts().restated; delete b.answered.key; },
      /work\.answered\.key is absent/],
    // The engine leaves `knowledge` out when it states none: a written `null` is another shape.
    ['knowledge as null', (b) => { b.knowledge = null; }, /work\.knowledge is not an object/],
    ['knowledge without its state', (b) => { b.knowledge = { source: 'embedded' }; },
      /work\.knowledge\.state is absent/],
    ['an admitted release without its manifest digest', (b) => { b.knowledge = batches().knowledge.admitted;
      delete b.knowledge.manifest_sha256; }, /work\.knowledge\.manifest_sha256 is absent/],
    ['a manifest digest in capitals', (b) => { b.knowledge = { ...batches().knowledge.admitted,
      manifest_sha256: 'A'.repeat(64) }; }, /work\.knowledge\.manifest_sha256 is not a witness/],
    ['an admitted version as a number', (b) => { b.knowledge = { ...batches().knowledge.admitted, version: 2 }; },
      /work\.knowledge\.version is neither text nor null/],
    ['a refusal without its code', (b) => { b.knowledge = batches().knowledge.refused; delete b.knowledge.code; },
      /work\.knowledge\.code is absent/],
    ['a refusal cause as an object', (b) => { b.knowledge = { ...batches().knowledge.refused,
      cause: { path: SECRET } }; }, /work\.knowledge\.cause is not text/],
    ['unread knowledge without its reason', (b) => { b.knowledge = { state: 'unread' }; },
      /work\.knowledge\.why is absent/],
    ['a knowledge choice without its line', (b) => { b.waiting = { kind: 'knowledge_choice' }; },
      /work\.waiting\.line is absent/],
    ['a held line as a list', (b) => { b.waiting = { kind: 'knowledge_choice', line: [SECRET] }; },
      /work\.waiting\.line is not text/],
    ['open questions named as text', (b) => { b.waiting = { kind: 'questions', ids: 'witness-plan' }; },
      /work\.waiting\.ids is not a list of text/],
    ['stages as a list', (b) => { b.authoring.stages = []; }, /work\.authoring\.stages is not an object/],
    ['stages without their trials', (b) => { b.authoring.stages = batches().stages; delete b.authoring.stages.trials; },
      /work\.authoring\.stages\.trials is absent/],
    ['a qualification time written as text', (b) => { b.authoring.stages = { ...batches().stages,
      qualification_ms: '41870' }; }, /work\.authoring\.stages\.qualification_ms is neither a count nor null/],
    ['a trial as text', (b) => { b.authoring.stages = { ...batches().stages, trials: [SECRET] }; },
      /work\.authoring\.stages\.trials\[0\] is not an object/],
    ['a trial without its runtime bound member', (b) => { b.authoring.stages = batches().stages;
      delete b.authoring.stages.trials[1].runtime_bound_ms; },
    /work\.authoring\.stages\.trials\[1\]\.runtime_bound_ms is absent/],
    ['a negative trial time', (b) => { b.authoring.stages = batches().stages;
      b.authoring.stages.trials[0].elapsed_ms = -1; },
    /work\.authoring\.stages\.trials\[0\]\.elapsed_ms is neither a count nor null/],
    ['bindings as an object', (b) => { b.bindings = {}; }, /work\.bindings is not a list/],
    ['a binding without its provenance', (b) => { b.bindings = batches().conversation.bindings;
      delete b.bindings[0].provenance; }, /work\.bindings\[0\]\.provenance is absent/],
    ['a provenance without the line it rests on', (b) => { b.bindings = batches().conversation.bindings;
      delete b.bindings[1].provenance.message; }, /work\.bindings\[1\]\.provenance\.message is absent/],
    ['a bound value as a number', (b) => { b.bindings = batches().conversation.bindings; b.bindings[0].value = 7; },
      /work\.bindings\[0\]\.value is not text/],
    ['a delegation without the words', (b) => { b.delegations = batches().conversation.delegations;
      delete b.delegations[0].excerpt; }, /work\.delegations\[0\]\.excerpt is absent/],
    ['a question without its identity', (b) => { b.questions = batches().conversation.questions;
      delete b.questions[0].id; }, /work\.questions\[0\]\.id is absent/],
    ['a free-answer flag as text', (b) => { b.questions = batches().conversation.questions;
      b.questions[0].free_text = 'yes'; }, /work\.questions\[0\]\.free_text is not a boolean/],
    ['prerequisites as text', (b) => { b.questions = batches().conversation.questions; b.questions[1].after = 'plan'; },
      /work\.questions\[1\]\.after is not a list of text/],
    ['an option without its recommendation', (b) => { b.questions = batches().conversation.questions;
      delete b.questions[0].options[0].recommended; },
    /work\.questions\[0\]\.options\[0\]\.recommended is absent/],
    ['an offered value as a number', (b) => { b.questions = batches().conversation.questions;
      b.questions[0].options[0].values[0].value = 3; },
    /work\.questions\[0\]\.options\[0\]\.values\[0\]\.value is not text/],
    ['a sealed flag as text', (b) => { b.run = { ...batches().runs.stopped, sealed: 'true' }; },
      /work\.run\.sealed is not a boolean/],
  ];
  it.each(malformed)('refuses %s as a protocol fault naming its path, never its value', (_name, mutate, message) => {
    const body = work();
    mutate(body);
    const error = refusal(body);
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('Session work members over both doors', () => {
  const opened: NikaAuthoringSession[] = [];
  afterEach(async () => {
    for (const session of opened.splice(0)) await session.close().catch(() => {});
    delete process.env.NIKA_FAKE_SESSION_WORK;
  });

  it('carries the same members natively and over HTTP', async () => {
    process.env.NIKA_FAKE_SESSION_WORK = FIXTURE;
    const local = await new Nika({ bin: SESSION_ENGINE }).openSession();
    opened.push(local);
    const proposed = await local.submit(local.opened!.snapshot, 'draft a digest');
    const nativeWork = proposed.snapshot.work;
    const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const { pathname } = new URL(String(url));
      if (pathname === '/health') {
        return healthResponse({ engineVersion: '0.123.0', supportedCapabilities: ['check', 'executionSnapshot',
          'eventStream', 'cancel', 'jobInputs', 'compile', 'sessionHost'] });
      }
      if (pathname === '/v1/sessions' && init.method === 'POST') {
        return jsonResponse({ contract: CONTRACT, session: SESSION, frame: 'opened', event: 1, notices: [],
          snapshot: { snapshot: `snp_${'0'.repeat(32)}`, seq: 1, busy: null, work: nativeWork } }, 201);
      }
      throw new Error(`unexpected ${init.method ?? 'GET'} ${pathname}`);
    });
    const remote = await new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch })
      .openSession();
    const remoteWork = remote.opened!.snapshot.work;
    expect(remoteWork).toEqual(nativeWork);
    expect(nativeWork.candidate!.files[0]!.content).toBe(CONTENT);
    expect(nativeWork.authoring!.calls!.requested_model).toBe('claude-code/opus');
    expect(nativeWork.intelligence!.author.kind).toBe('harness');
  });

  it('refuses a malformed member on the native door', async () => {
    const broken = structuredClone(rich);
    broken.intelligence.author.kind = 4;
    const file = path.join(tmpdir(), `nika-sdk-broken-work-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(broken));
    try {
      process.env.NIKA_FAKE_SESSION_WORK = file;
      await expect(new Nika({ bin: SESSION_ENGINE }).openSession()).rejects
        .toThrow(/work\.intelligence\.author\.kind is not text/);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
