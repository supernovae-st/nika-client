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
const { judgeJourney, advance, requestedSeat, journeyDoors, sessionResult } =
  require('../scripts/packed-consumers/session-journey.cjs') as {
  judgeJourney: (report: Journey, expected: { create: string[]; edit: string[] }, requested?: string | null) => Judged;
  requestedSeat: (choice: string) => Record<string, string | null>;
  journeyDoors: (value: string | undefined) => string[];
  sessionResult: (walks: unknown[], comparisons: unknown[], journey: unknown) => string;
  advance: (session: unknown, snapshot: unknown, line: string, persona: unknown, signal: () => AbortSignal,
    report: (turn: unknown) => void) => Promise<{ waiting: string; summary: any }>;
};

const EXPECTED = { create: ['stale-60', 'boundary-72', 'stale-90'], edit: ['stale-90'] };
const CREATED = 'a'.repeat(64);
const EDITED = 'e'.repeat(64);
/** The digest of some other document a proposal may also carry. */
const OTHER = 'f'.repeat(64);
const file = (path: string, content: string) => ({ path, landing: 'update', content_sha256: content });
const authored = (revision: unknown = null, files = [file('stale.nika', CREATED)]) => ({
  intelligence: { selected: { kind: 'api', via: 'deepseek' }, author: { kind: 'provider', model: 'deepseek/x' },
    decision: { model: 'typesafe/jev', refusal: null }, effort: 'max' },
  calls: { requested_model: 'deepseek/x', calls: 2, input_tokens: 10, output_tokens: 20, elapsed_ms: 900, backend: {} },
  authoring_status: 'ready', questions: [], files, revision,
});
/** The EDIT revision as the Session states it: the created bytes revised into `candidate`. */
const revised = (candidate: string, base = CREATED) => ({ mode: 'operations', base_sha256: base,
  candidate_sha256: candidate, changed: ['const.max_age_hours'], components: [] });
const leg = (name: string, savedSha: string, ids: string[], evidence: unknown) => [
  { step: `${name}_reached`, waiting: 'consent', key: null, outcomes: ['proposal'], turns: 1, evidence },
  { step: `${name}_save`, outcomes: ['facts'], saved: 'stale.nika', saved_bytes_are_previewed: true,
    saved_sha256: savedSha, save_ran_nothing: true },
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
    ...leg('edit', EDITED, EXPECTED.edit, authored(revised(EDITED), [file('stale.nika', EDITED)])),
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
    const elsewhere = authored(revised(EDITED, 'b'.repeat(64)), [file('stale.nika', EDITED)]);
    const judged = judgeJourney(edit(journey(), 'edit_reached', { evidence: elsewhere }), EXPECTED);
    expect(verdictOf(judged, /revises the created bytes/)).toEqual(['failed']);
    expect(judged.verdict).toBe('failed');
  });

  // Root review of 5229cf6 (P2): the revision must bind the workflow the consent saved and the Run
  // ran, never whichever proposed file happens to carry its digest.
  const wrongDocument: [string, unknown][] = [
    ['a revision naming another proposed file than the one saved and run',
      authored(revised(OTHER), [file('stale.nika', EDITED), file('other.nika', OTHER)])],
    ['a revision and its file that agree, but not with the bytes saved and run',
      authored(revised(OTHER), [file('stale.nika', OTHER)])],
    ['a revision whose bytes were proposed under another path than the one saved',
      authored(revised(EDITED), [file('other.nika', EDITED)])],
    ['a revision whose digest names bytes nobody proposed',
      authored(revised('d'.repeat(64)), [file('stale.nika', EDITED)])],
  ];
  it.each(wrongDocument)('fails %s', (_name, evidence) => {
    const judged = judgeJourney(edit(journey(), 'edit_reached', { evidence }), EXPECTED);
    expect(verdictOf(judged, /revises the created bytes/)).toEqual(['failed']);
    expect(judged.verdict).toBe('failed');
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

// Root review of 5229cf6 (second P2): an explicitly empty door selection reported a journey that
// walked no door, and the runner could still be green.
describe('a requested journey walks at least one door, or the run says so', () => {
  it('reads the door selection strictly', () => {
    expect(journeyDoors(undefined)).toEqual(['native', 'http']);
    expect(journeyDoors('native')).toEqual(['native']);
    expect(journeyDoors(' http , native ')).toEqual(['http', 'native']);
    for (const refused of ['', ',', 'native,', 'smtp', 'native,native', 'NATIVE']) {
      expect(() => journeyDoors(refused), refused).toThrow(/NIKA_SESSION_JOURNEY_DOORS names native and\/or http/);
    }
  });

  const walk = (verdict: string, exercised = true) => ({ exercised, verdict });
  const equal = { equal: true };

  it('is green only when every walk, comparison and journey door passed', () => {
    expect(sessionResult([walk('passed')], [equal], { ran: false })).toBe('green');
    expect(sessionResult([walk('passed')], [equal], { ran: true, doors: [walk('passed')] })).toBe('green');
  });

  it('never reports a requested journey that walked no door as green', () => {
    expect(sessionResult([walk('passed')], [equal], { ran: true, doors: [] })).toBe('not_exercised');
  });

  it('carries a journey door\'s failure or gap into the run', () => {
    expect(sessionResult([walk('passed')], [equal], { ran: true, doors: [walk('failed')] })).toBe('failed');
    expect(sessionResult([walk('passed')], [equal], { ran: true, doors: [walk('passed'), walk('x', false)] }))
      .toBe('not_exercised');
  });

  it('never reports walks that did not happen as green', () => {
    expect(sessionResult([], [], { ran: false })).toBe('not_exercised');
    expect(sessionResult([walk('passed', false)], [equal], { ran: false })).toBe('not_exercised');
    expect(sessionResult([walk('passed')], [{ equal: null }], { ran: false })).toBe('not_exercised');
    expect(sessionResult([walk('passed')], [{ equal: false }], { ran: false })).toBe('failed');
  });
});

describe('a journey counts for the seat the Session actually selected', () => {
  it('reads a first-screen answer in the Session\'s own vocabulary', () => {
    expect(requestedSeat('1 acp:claude-code/opus')).toEqual({ kind: 'harness', via: 'claude-code', model: 'opus',
      transport: 'acp' });
    expect(requestedSeat('2 deepseek/deepseek-v4-flash')).toEqual({ kind: 'api', via: 'deepseek',
      model: 'deepseek-v4-flash', transport: null });
    expect(requestedSeat('1 codex')).toEqual({ kind: 'harness', via: 'codex', model: null, transport: null });
    expect(requestedSeat('4')).toEqual({ kind: 'none', via: null, model: null, transport: null });
  });

  const seatCheck = (judged: Judged) => judged.checks.find((check) => /requested intelligence/.test(check.name));

  it('credits the requested seat when the Session selected it', () => {
    expect(seatCheck(judgeJourney(journey(), EXPECTED, '2 deepseek'))).toMatchObject({ verdict: 'passed' });
  });

  it('never relabels a choice kept before the journey as the requested one', () => {
    const judged = judgeJourney(journey(), EXPECTED, '1 acp:claude-code/opus');
    expect(seatCheck(judged)).toMatchObject({ verdict: 'not_exercised',
      why: 'the Session opened on a choice kept before this journey, never asked the first screen' });
    expect(judged.verdict).toBe('not_exercised');
  });

  it('fails a first-screen answer the Session did not honor', () => {
    const answered = { ...journey(), steps: [{ step: 'create_turn', turn: 0, said: 'intelligence_choice' },
      ...journey().steps] };
    expect(seatCheck(judgeJourney(answered, EXPECTED, '1 acp:claude-code/opus'))).toMatchObject({ verdict: 'failed' });
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
