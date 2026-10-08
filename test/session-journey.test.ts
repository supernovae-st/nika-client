import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The real-intelligence journey's persona and judge
// (scripts/packed-consumers/session-journey.cjs), on scripted Sessions and
// synthetic transcripts: the persona answers only what it was told to, and
// the judge reads each leg's own evidence and postconditions. The journey
// itself runs against a frozen engine binary and a real seat in
// scripts/run-session-parity-e2e.mjs.

const require = createRequire(import.meta.url);
type Journey = { module_system: string; door: string; steps: any[]; error: any };
type Judged = { verdict: string; checks: { name: string; verdict: string; why?: string }[] };
const { judgeJourney, advance } = require('../scripts/packed-consumers/session-journey.cjs') as {
  judgeJourney: (report: Journey, expected: { create: string[]; edit: string[] }) => Judged;
  advance: (session: unknown, snapshot: unknown, line: string, persona: unknown, signal: () => AbortSignal,
    report: (turn: unknown) => void) => Promise<{ waiting: string; summary: any }>;
};

const EXPECTED = { create: ['stale-60', 'boundary-72', 'stale-90'], edit: ['stale-90'] };
const CREATED = 'a'.repeat(64);
const EDITED = 'e'.repeat(64);
const EDITED_CONTENT = 'f'.repeat(64);
const authored = (revision: unknown = null, content = 'c'.repeat(64)) => ({
  intelligence: { selected: { kind: 'api', via: 'deepseek' }, author: { kind: 'provider', model: 'deepseek/x' },
    decision: { model: 'typesafe/jev', refusal: null }, effort: 'max' },
  calls: { requested_model: 'deepseek/x', calls: 2, input_tokens: 10, output_tokens: 20, elapsed_ms: 900, backend: {} },
  authoring_status: 'ready', questions: [], files: [{ path: 'stale.nika', landing: 'create', content_sha256: content }],
  revision,
});
const leg = (name: string, savedSha: string, ids: string[], evidence: unknown) => [
  { step: `${name}_reached`, waiting: 'consent', key: null, outcomes: ['proposal'], turns: 1, evidence },
  { step: `${name}_save`, outcomes: ['facts'], saved_bytes_are_previewed: true, saved_sha256: savedSha,
    save_ran_nothing: true },
  { step: `${name}_run`, outcomes: ['run_requested', 'facts'] },
  { step: `${name}_run_observed`, deadline: false, busy: false, saved: 'stale.nika', saved_sha256: savedSha,
    run: { current: true, workflow: 'stale.nika', end: { end: 'succeeded' }, workflow_sha256: savedSha },
    report: { count: ids.length, ids } },
];
function journey(): Journey {
  return { module_system: 'esm', door: 'native', error: null, steps: [
    { step: 'create_open', frame: 'opened' },
    ...leg('create', CREATED, EXPECTED.create, authored()),
    { step: 'edit_open', frame: 'opened', created_sha256: CREATED },
    ...leg('edit', EDITED, EXPECTED.edit, authored({ mode: 'operations', base_sha256: CREATED,
      candidate_sha256: EDITED_CONTENT, changed: ['const.max_age_hours'], components: [] }, EDITED_CONTENT)),
  ] };
}
function edit(report: Journey, name: string, change: Record<string, unknown>): Journey {
  return { ...report, steps: report.steps.map((step) => (step.step === name ? { ...step, ...change } : step)) };
}
const verdictOf = (judged: Judged, name: RegExp) => judged.checks.filter((check) => name.test(check.name))
  .map((check) => check.verdict);

describe('a real-intelligence journey is judged leg by leg', () => {
  it('passes a journey whose CREATE and EDIT keep every law', () => {
    const judged = judgeJourney(journey(), EXPECTED);
    expect(judged.checks.filter((check) => check.verdict !== 'passed')).toEqual([]);
    expect(judged.verdict).toBe('passed');
  });

  it('withholds both legs when the CREATE words never reached a proposal', () => {
    const stuck = { ...journey(), steps: [{ step: 'create_open' }, { step: 'create_reached', waiting: 'question',
      key: 'const.webhook_endpoint', outcomes: ['question'], evidence: authored() }] };
    const judged = judgeJourney(stuck, EXPECTED);
    expect(judged.checks.map((check) => [check.name, check.verdict, check.why])).toEqual([
      ['the CREATE leg reached a proposal', 'not_exercised', 'the Session waits on question (const.webhook_endpoint)'],
      ['the EDIT leg reached a proposal', 'not_exercised', 'an earlier leg stopped first'],
    ]);
    expect(judged.verdict).toBe('not_exercised');
  });

  it('never credits a model for a proposal the deterministic reading prepared', () => {
    const deterministic = { ...authored(), calls: null, intelligence: { author: { kind: 'deterministic' } } };
    const judged = judgeJourney(edit(journey(), 'create_reached', { evidence: deterministic }), EXPECTED);
    expect(verdictOf(judged, /a model authored the CREATE/)).toEqual(['not_exercised']);
  });

  it('fails an EDIT proposal that does not revise the created bytes', () => {
    const elsewhere = authored({ mode: 'replaced', base_sha256: 'b'.repeat(64), candidate_sha256: EDITED_CONTENT,
      changed: [], components: [] }, EDITED_CONTENT);
    const judged = judgeJourney(edit(journey(), 'edit_reached', { evidence: elsewhere }), EXPECTED);
    expect(verdictOf(judged, /revises the created bytes/)).toEqual(['failed']);
    expect(judged.verdict).toBe('failed');
  });

  it('fails a revision whose digest names other bytes than the ones proposed', () => {
    const judged = judgeJourney(edit(journey(), 'edit_reached', { evidence: authored({ mode: 'operations',
      base_sha256: CREATED, candidate_sha256: 'd'.repeat(64), changed: [], components: [] }, EDITED_CONTENT) }),
    EXPECTED);
    expect(verdictOf(judged, /revises the created bytes/)).toEqual(['failed']);
  });

  it('fails a report that holds other tickets than the threshold selects', () => {
    const judged = judgeJourney(edit(journey(), 'edit_run_observed', { report: { count: 3, ids: EXPECTED.create } }),
      EXPECTED);
    expect(verdictOf(judged, /EDIT report/)).toEqual(['failed']);
  });

  it('fails a Run of other bytes, or one that did not succeed', () => {
    for (const run of [{ current: true, workflow: 'stale.nika', end: { end: 'succeeded' }, workflow_sha256: 'x' },
      { current: true, workflow: 'stale.nika', end: { end: 'failed' }, workflow_sha256: CREATED }, null]) {
      const judged = judgeJourney(edit(journey(), 'create_run_observed', { run }), EXPECTED);
      expect(verdictOf(judged, /CREATE Run of the saved bytes/)).toEqual(['failed']);
    }
  });

  it('withholds the Run and its report when the Session started none', () => {
    const judged = judgeJourney(edit(journey(), 'edit_run', { outcomes: ['run_requested', 'run_not_started'] }),
      EXPECTED);
    expect(verdictOf(judged, /EDIT Run|EDIT report/)).toEqual(['not_exercised', 'not_exercised']);
  });

  it('fails a Save that ran something or saved other bytes', () => {
    expect(verdictOf(judgeJourney(edit(journey(), 'create_save', { save_ran_nothing: false }), EXPECTED),
      /CREATE consent/)).toEqual(['failed']);
    expect(verdictOf(judgeJourney(edit(journey(), 'edit_save', { saved_bytes_are_previewed: false }), EXPECTED),
      /EDIT consent/)).toEqual(['failed']);
  });

  it('fails a journey that stopped, keeping its partial transcript', () => {
    const judged = judgeJourney({ ...journey(), error: { name: 'NikaSessionWaitError', message: 'cut' } }, EXPECTED);
    expect(judged).toEqual({ verdict: 'failed', checks: [{ name: 'the journey completed', verdict: 'failed',
      observed: { name: 'NikaSessionWaitError', message: 'cut' } }] });
  });
});

describe('the persona answers only what it was told to', () => {
  const snapshot = (kind: string, extra: Record<string, unknown> = {}) => ({ snapshot: `snp-${kind}`, seq: 1, busy: null,
    work: { waiting: { kind, ...extra }, authoring: null, candidate: null, intelligence: null } });
  function scripted(kinds: [string, Record<string, unknown>?][]) {
    const sent: string[] = [];
    const session = {
      submit: async (_shown: unknown, line: string) => {
        sent.push(line);
        const [kind, extra] = kinds.shift()!;
        return { frame: 'result', event: sent.length, op: 'submit', replayed: false, outcomes: [{ kind: 'reply' }],
          snapshot: snapshot(kind, extra) };
      },
    };
    return { session, sent };
  }
  const signal = () => AbortSignal.timeout(1000);

  it('answers the first screen with its choice, then stops at the consent', async () => {
    const { session, sent } = scripted([['intelligence_choice'], ['consent', { proposal: 'p' }]]);
    const reached = await advance(session, snapshot('free'), 'Create it',
      { choice: '2 deepseek/deepseek-v4-flash', acceptCost: false, answers: {} }, signal, () => {});
    expect(sent).toEqual(['Create it', '2 deepseek/deepseek-v4-flash']);
    expect(reached.waiting).toBe('consent');
  });

  it('stops at a cost choice it was not authorized to accept, and accepts one it was', async () => {
    const refused = scripted([['cost_choice'], ['consent']]);
    const stopped = await advance(refused.session, snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: {} }, signal, () => {});
    expect([refused.sent, stopped.waiting]).toEqual([['Create it'], 'cost_choice']);
    const allowed = scripted([['cost_choice'], ['consent']]);
    const accepted = await advance(allowed.session, snapshot('free'), 'Create it',
      { choice: '1', acceptCost: true, answers: {} }, signal, () => {});
    expect([allowed.sent, accepted.waiting]).toEqual([['Create it', 'yes'], 'consent']);
  });

  it('answers a question only from its table, and stops on any other', async () => {
    const known = scripted([['question', { key: 'const.webhook_endpoint' }], ['consent']]);
    await advance(known.session, snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: { 'const.webhook_endpoint': 'https://hooks.example/x' } }, signal,
      () => {});
    expect(known.sent).toEqual(['Create it', 'https://hooks.example/x']);
    const unknown = scripted([['question', { key: 'const.audience' }]]);
    const stopped = await advance(unknown.session, snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: { 'const.webhook_endpoint': 'x' } }, signal, () => {});
    expect([unknown.sent, stopped.waiting, stopped.summary.key]).toEqual([['Create it'], 'question', 'const.audience']);
  });

  it('never consents for the person and never answers a gate', async () => {
    for (const kind of ['gate', 'run_review', 'input', 'activation', 'free']) {
      const { session, sent } = scripted([[kind]]);
      const reached = await advance(session, snapshot('free'), 'Create it',
        { choice: '1', acceptCost: true, answers: {} }, signal, () => {});
      expect([sent, reached.waiting]).toEqual([['Create it'], kind]);
    }
  });
});
