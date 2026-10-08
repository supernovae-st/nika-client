import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import type {
  NikaAuthoringSession,
  NikaSessionAuthoringCall,
  NikaSessionAuthoringCalls,
  NikaSessionCandidateFile,
  NikaSessionIntelligence,
  NikaSessionQuestion,
  NikaSessionRun,
  NikaSessionRunEnd,
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

// The carrier's wire example of `work.authoring.calls` at engine `ca5845b85`
// (`nika-session-change` `AuthoringCalls` with `per_call`, from the receipt of
// its allowlist test; keys sorted), byte for byte: one answered call, and one
// failed call whose malformed digest, unrecorded references and unsafe effort
// the engine wrote as `null`.
const CALLS_WIRE = fileURLToPath(new URL('./fixtures/session-host/work-authoring-calls-ca5845b85.json',
  import.meta.url));
const wire = (): Record<string, any> => JSON.parse(readFileSync(CALLS_WIRE, 'utf8'));

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
    const [answered, failed]: NikaSessionAuthoringCall[] = calls.per_call!;
    expect(answered).toEqual({ call: 'document', instruction_sha256: 'a'.repeat(64),
      schema_sha256: '0123456789abcdef'.repeat(4), message_bytes: 4096, references: 2, max_output_tokens: 16384,
      timeout_ms: 600000, elapsed_ms: 700, stop_reason: 'EndTurn', failure_kind: null, usage_reported: true,
      input_tokens: 1000, output_tokens: 250, reasoning_effort: 'high', reasoning_tokens: null,
      future_call_member: 'kept' });
    // A failed call names the engine's kind; what the receipt held unsafely or not at all stays null.
    expect(failed).toMatchObject({ call: 'repair', instruction_sha256: null, references: null, stop_reason: null,
      failure_kind: 'timeout', usage_reported: null, input_tokens: null, output_tokens: null, reasoning_effort: null });
    // The totals stay the receipt's own: unknown output stays null though one call reported 250.
    expect([calls.calls, calls.elapsed_ms, calls.input_tokens, calls.output_tokens]).toEqual([2, 900, 1000, null]);
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
    ['a role that is not a word', (b) => { b.authoring.calls = wire(); b.authoring.calls.per_call[1].call = SECRET; },
      /work\.authoring\.calls\.per_call\[1\]\.call is neither a word nor null/],
    ['an effort carrying punctuation', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[0].reasoning_effort = 'high; drop table'; },
    /work\.authoring\.calls\.per_call\[0\]\.reasoning_effort is neither a word nor null/],
    ['a stop reason over forty letters', (b) => { b.authoring.calls = wire();
      b.authoring.calls.per_call[0].stop_reason = 'E'.repeat(41); },
    /work\.authoring\.calls\.per_call\[0\]\.stop_reason is neither a word nor null/],
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
