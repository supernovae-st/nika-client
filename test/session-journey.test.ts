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
type Judged = { verdict: string; checks: { name: string; verdict: string; why?: string }[]; legs: Record<string, any> };
const { judgeJourney, journeyDenominators, advance, requestedSeat, journeyDoors, sessionResult } =
  require('../scripts/packed-consumers/session-journey.cjs') as {
  judgeJourney: (report: Journey, expected: { create: string[]; edit: string[] }, requested?: string | null,
    worldChecks?: unknown, effort?: string | null) => Judged;
  journeyDenominators: (doors: unknown[]) => Record<string, any>;
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
    const runOf = (run: unknown) => judgeJourney(edit(journey(), 'create_run_observed', { run }), EXPECTED);
    const other = runOf({ current: true, workflow: 'stale.nika', end: { end: 'succeeded' }, workflow_sha256: 'x' });
    expect(verdictOf(other, /CREATE Run/)).toEqual(['passed', 'failed']);
    const failed = runOf({ current: true, workflow: 'stale.nika', end: { end: 'failed' }, workflow_sha256: CREATED });
    expect(verdictOf(failed, /CREATE Run/)).toEqual(['failed', 'passed']);
    expect(verdictOf(runOf(null), /CREATE Run/)).toEqual(['failed', 'not_exercised']);
  });

  it('leaves the bytes a Run ran unproven when the Session names no source hash, never passed', () => {
    // Both session-host doors observe a Run without its identity leg at 4271f09ef: the source
    // hash is null there, so the saved bytes are neither proven nor contradicted.
    const judged = judgeJourney(edit(journey(), 'create_run_observed', { run: { current: true,
      workflow: 'stale.nika', end: { end: 'succeeded' }, workflow_sha256: null } }), EXPECTED);
    expect(verdictOf(judged, /CREATE Run/)).toEqual(['passed', 'not_exercised']);
    expect(judged.checks.find((entry) => entry.name === 'the CREATE Run ran the saved bytes')!.why)
      .toBe('the Session names no source hash of the bytes its Run ran');
    expect(judged.verdict).toBe('not_exercised');
  });

  it('withholds the Run and its report when the Session started none', () => {
    const judged = judgeJourney(edit(journey(), 'edit_run', { outcomes: ['run_requested', 'run_not_started'] }),
      EXPECTED);
    expect(verdictOf(judged, /EDIT Run|EDIT report/)).toEqual(['not_exercised', 'not_exercised', 'not_exercised']);
  });

  it('withholds the Run and its report when the Run waits on what the persona was never told', () => {
    const judged = judgeJourney(edit(journey(), 'edit_run_observed', { run: null, deadline: false,
      waiting: { kind: 'input', name: 'sink_url', key: null } }), EXPECTED);
    expect(verdictOf(judged, /EDIT Run|EDIT report/)).toEqual(['not_exercised', 'not_exercised', 'not_exercised']);
    expect(judged.checks.find((entry) => entry.name === 'the EDIT Run ran the saved bytes')!.why)
      .toBe('the Session waits on input sink_url, which the persona does not answer');
  });

  it('fails a Save that ran something or saved other bytes', () => {
    expect(verdictOf(judgeJourney(edit(journey(), 'create_save', { save_ran_nothing: false }), EXPECTED),
      /CREATE consent/)).toEqual(['failed']);
    expect(verdictOf(judgeJourney(edit(journey(), 'edit_save', { saved_bytes_are_previewed: false }), EXPECTED),
      /EDIT consent/)).toEqual(['failed']);
  });

  it('fails a journey a genuine fault stopped, keeping its partial transcript', () => {
    const { legs, ...judged } = judgeJourney({ ...journey(), error: { name: 'NikaProtocolError',
      message: 'malformed frame' } }, EXPECTED);
    expect(judged).toEqual({ verdict: 'failed', checks: [{ name: 'the journey completed', verdict: 'failed',
      observed: { name: 'NikaProtocolError', message: 'malformed frame' } }] });
    // The fault stopped the EDIT leg: the CREATE leg keeps the verdicts of its own evidence.
    expect([legs.create.outcome, legs.edit.outcome, legs.edit.why]).toEqual(['passed', 'failed',
      'the journey completed']);
  });

  it('reports a Run the harness stopped watching as its observation bound, never a failed Run', () => {
    const judged = judgeJourney(edit(journey(), 'create_run_observed', { deadline: true, observation_ms: 5000,
      busy: true, run: null }), EXPECTED);
    expect(verdictOf(judged, /CREATE Run|CREATE report/)).toEqual(['not_exercised', 'not_exercised', 'not_exercised']);
    expect(judged.checks.find((entry) => entry.name === 'the CREATE Run of the saved workflow succeeded')!.why)
      .toBe('the harness stopped watching the Run after 5000 ms: an observation bound of this harness, never a '
        + 'product limit');
    expect(judged.verdict).toBe('not_exercised');
  });

  it('withholds what a leg did not reach after the harness stopped waiting, never failing it', () => {
    const steps = journey().steps.filter((entry) => !/^create_(run|save)|^edit_/.test(entry.step));
    const why = 'the harness stopped waiting for create-save after 5000 ms: an observation bound of this harness, '
      + 'never a product limit';
    const judged = judgeJourney({ ...journey(), steps: [...steps, { step: 'create_harness_bound', bound: 'turn_wait',
      limit_ms: 5000, command: 'create-save', why, busy: { command: 'create-save', phase: 'running' } }] }, EXPECTED);
    expect(verdictOf(judged, /CREATE leg reached/)).toEqual(['passed']);
    expect(judged.checks.filter((entry) => /CREATE (consent|Run|report)/.test(entry.name))
      .map((entry) => [entry.verdict, entry.why])).toEqual([['not_exercised', why], ['not_exercised', why],
      ['not_exercised', why], ['not_exercised', why]]);
    expect(verdictOf(judged, /EDIT leg reached/)).toEqual(['not_exercised']);
    expect(judged.verdict).toBe('not_exercised');
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
  // Root re-review of a7b3aa2: the engine keeps a named model whole (`split_seat`), as its own
  // test pins `1 acp:claude-code/claude-opus-5-5[1m]` → model `claude-code/claude-opus-5-5[1m]`.
  it('projects a first-screen answer as the Session projects its selection', () => {
    expect(requestedSeat('1 acp:claude-code/claude-opus-5-5[1m]')).toEqual({ kind: 'harness', via: 'claude-code',
      model: 'claude-code/claude-opus-5-5[1m]', transport: 'acp' });
    expect(requestedSeat('2 deepseek/deepseek-v4-flash')).toEqual({ kind: 'api', via: 'deepseek',
      model: 'deepseek/deepseek-v4-flash', transport: null });
    expect(requestedSeat('1 codex')).toEqual({ kind: 'harness', via: 'codex', model: null, transport: 'native' });
    expect(requestedSeat('1')).toEqual({ kind: 'harness', via: null, model: null, transport: 'native' });
    // An empty side names no model: the whole name is the provider, as `split_seat` keeps it.
    expect(requestedSeat('2 deepseek/')).toEqual({ kind: 'api', via: 'deepseek/', model: null, transport: null });
    expect(requestedSeat('4')).toEqual({ kind: 'none', via: null, model: null, transport: null });
  });

  // Each leg's Session is judged on its own: CREATE first, then EDIT.
  const seatChecks = (judged: Judged) => judged.checks.filter((check) => /prepared with the requested/.test(check.name));
  const selectedIn = (selected: unknown) => ({ ...authored(), intelligence: { ...authored().intelligence, selected } });
  /** Both legs reach their proposal with `selected`, as one kept choice shows it in each Session. */
  const selecting = (selected: Record<string, unknown>) => edit(edit(journey(), 'create_reached',
    { evidence: selectedIn(selected) }), 'edit_reached', { evidence: selectedIn(selected) });
  const answeredFirstScreen = (report: Journey): Journey => ({ ...report,
    steps: [{ step: 'create_turn', turn: 0, said: 'intelligence_choice' }, ...report.steps] });
  const verdicts = (judged: Judged) => seatChecks(judged).map((check) => check.verdict);

  it('credits the requested seat when each leg\'s Session selected it', () => {
    expect(seatChecks(judgeJourney(journey(), EXPECTED, '2 deepseek')).map((check) => [check.name, check.verdict]))
      .toEqual([['the CREATE Session prepared with the requested intelligence', 'passed'],
        ['the EDIT Session prepared with the requested intelligence', 'passed']]);
  });

  it('credits an explicitly named model exactly as the engine projects it', () => {
    const api = selecting({ kind: 'api', via: 'deepseek', transport: null, model: 'deepseek/deepseek-v4-flash',
      locus: 'DeepSeek API', ready: true, refusal: null });
    expect(verdicts(judgeJourney(answeredFirstScreen(api), EXPECTED, '2 deepseek/deepseek-v4-flash')))
      .toEqual(['passed', 'passed']);
    const claude = { kind: 'harness', via: 'claude-code', transport: 'acp', model: 'claude-code/claude-opus-5-5[1m]',
      locus: 'Claude app', ready: true, refusal: null };
    const requested = '1 acp:claude-code/claude-opus-5-5[1m]';
    expect(verdicts(judgeJourney(answeredFirstScreen(selecting(claude)), EXPECTED, requested)))
      .toEqual(['passed', 'passed']);
    // The same app reached natively is not the ACP seat requested.
    expect(verdicts(judgeJourney(answeredFirstScreen(selecting({ ...claude, transport: 'native' })), EXPECTED,
      requested))).toEqual(['failed', 'failed']);
  });

  it('never relabels a choice kept before the journey as the requested one', () => {
    const judged = judgeJourney(journey(), EXPECTED, '1 acp:claude-code/opus');
    expect(seatChecks(judged)).toEqual(['CREATE', 'EDIT'].map((leg) => expect.objectContaining({
      name: `the ${leg} Session prepared with the requested intelligence`, verdict: 'not_exercised',
      why: 'the Session opened on a choice kept before this journey, never asked the first screen' })));
    expect(judged.verdict).toBe('not_exercised');
  });

  it('fails a first-screen answer the Session did not honor', () => {
    expect(verdicts(judgeJourney(answeredFirstScreen(journey()), EXPECTED, '1 acp:claude-code/opus')))
      .toEqual(['failed', 'failed']);
  });

  it('fails an EDIT Session that prepared with another seat than the journey\'s first-screen answer', () => {
    const seat = { kind: 'api', via: 'deepseek', transport: null, model: 'deepseek/deepseek-v4-pro' };
    const flash = edit(answeredFirstScreen(selecting(seat)), 'edit_reached',
      { evidence: selectedIn({ ...seat, model: 'deepseek/deepseek-flash' }) });
    const judged = judgeJourney(flash, EXPECTED, '2 deepseek/deepseek-v4-pro');
    expect(verdicts(judged)).toEqual(['passed', 'failed']);
    expect(judged.verdict).toBe('failed');
  });

  it('reads a leg that asked the first screen again from its own answer on', () => {
    const seat = { kind: 'api', via: 'deepseek', transport: null, model: 'deepseek/deepseek-v4-pro' };
    const report = answeredFirstScreen(selecting(seat));
    // The EDIT Session opened with no choice and asked again; before its answer it showed none.
    const reasked = { ...report, steps: report.steps.flatMap((entry) => (entry.step !== 'edit_open' ? [entry] : [
      { ...entry, intelligence: { selected: { kind: 'none', ready: false } } },
      { step: 'edit_turn', turn: 0, said: 'words', evidence: selectedIn({ kind: 'none', ready: false }) },
      { step: 'edit_turn', turn: 1, said: 'intelligence_choice', evidence: selectedIn(seat) }])) };
    expect(verdicts(judgeJourney(reasked, EXPECTED, '2 deepseek/deepseek-v4-pro'))).toEqual(['passed', 'passed']);
  });

  it('withholds the EDIT Session\'s seat and scope when it never opened', () => {
    const opened = { step: 'create_open', opened_with: 'intelligence', intelligence: { selected: { kind: 'api',
      via: 'deepseek', model: 'deepseek/deepseek-v4-pro', scope: 'conversation' } } };
    const stuck = { ...journey(), steps: [opened, { step: 'create_reached', waiting: 'question', key: 'k',
      outcomes: ['question'], evidence: selectedIn(opened.intelligence.selected) }] };
    const judged = judgeJourney(stuck, EXPECTED, '2 deepseek/deepseek-v4-pro');
    expect(judged.checks.filter((check) => /EDIT Session/.test(check.name)).map((check) => [check.verdict, check.why]))
      .toEqual([['not_exercised', 'an earlier leg stopped first'], ['not_exercised', 'an earlier leg stopped first']]);
    expect(judged.verdict).toBe('not_exercised');
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
  // The leg's own sender: one line, one command identity.
  const via = (session: { submit: (shown: unknown, line: string, options?: unknown) => Promise<unknown> }) =>
    (shown: unknown, line: string, command: string) => session.submit(shown, line, { command });

  it('answers the first screen with its choice, then stops at the consent', async () => {
    const { session, sent } = scripted([['intelligence_choice'], ['consent', { proposal: 'p' }]]);
    const reached = await advance(via(session), snapshot('free'), 'Create it',
      { choice: '2 deepseek/deepseek-v4-flash', acceptCost: false, answers: {} }, () => {});
    expect(sent).toEqual(['Create it', '2 deepseek/deepseek-v4-flash']);
    expect(reached.waiting).toBe('consent');
  });

  it('stops at a cost choice it was not authorized to accept, and accepts one it was', async () => {
    const refused = scripted([['cost_choice'], ['consent']]);
    const stopped = await advance(via(refused.session), snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: {} }, () => {});
    expect([refused.sent, stopped.waiting]).toEqual([['Create it'], 'cost_choice']);
    const allowed = scripted([['cost_choice'], ['consent']]);
    const accepted = await advance(via(allowed.session), snapshot('free'), 'Create it',
      { choice: '1', acceptCost: true, answers: {} }, () => {});
    expect([allowed.sent, accepted.waiting]).toEqual([['Create it', 'yes'], 'consent']);
  });

  it('answers a question only from its table, and stops on any other', async () => {
    const known = scripted([['question', { key: 'const.webhook_endpoint' }], ['consent']]);
    await advance(via(known.session), snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: { 'const.webhook_endpoint': 'https://hooks.example/x' } }, () => {});
    expect(known.sent).toEqual(['Create it', 'https://hooks.example/x']);
    const unknown = scripted([['question', { key: 'const.audience' }]]);
    const stopped = await advance(via(unknown.session), snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: { 'const.webhook_endpoint': 'x' } }, () => {});
    expect([unknown.sent, stopped.waiting, stopped.summary.key]).toEqual([['Create it'], 'question', 'const.audience']);
  });

  it('stops answering after its own turn bound, keeping what the Session shows, never claiming a result', async () => {
    const asks = Array.from({ length: 30 }, (): [string, Record<string, unknown>] =>
      ['question', { key: 'const.again' }]);
    const { session, sent } = scripted(asks);
    const reached = await advance(via(session), snapshot('free'), 'Create it',
      { choice: '1', acceptCost: false, answers: { 'const.again': 'once more' } }, () => {});
    expect(sent).toHaveLength(24);
    expect(reached.waiting).toBe('harness_bound');
    expect(reached.summary).toMatchObject({ waiting: 'question', key: 'const.again', turns: 24,
      harness: { bound: 'persona_turns', limit: 24,
        why: 'the persona answered 24 lines and stopped: an observation bound of this harness, never a product limit' } });
    const judged = judgeJourney(edit(journey(), 'create_reached', reached.summary), EXPECTED);
    expect(judged.checks.find((entry) => entry.name === 'the CREATE leg reached a proposal')).toMatchObject({
      verdict: 'not_exercised', why: 'the persona answered 24 lines and stopped: an observation bound of this '
        + 'harness, never a product limit; the Session waits on question (const.again)' });
  });

  it('never consents for the person and never answers a gate', async () => {
    for (const kind of ['gate', 'run_review', 'input', 'activation', 'free']) {
      const { session, sent } = scripted([[kind]]);
      const reached = await advance(via(session), snapshot('free'), 'Create it',
        { choice: '1', acceptCost: true, answers: {} }, () => {});
      expect([sent, reached.waiting]).toEqual([['Create it'], kind]);
    }
  });
});

describe('each leg is summarized for a requalification table', () => {
  /** One ACP authoring call's receipts: invoked, then its end. */
  const receipt = (end: string) => [{ status: 'invoking', requested_effort: 'max' },
    { status: end, transmitted_effort: end === 'returned' ? 'max' : undefined,
      configured_effort: end === 'returned' ? 'max' : undefined }];
  const harnessed = (records: unknown[]) => ({ ...authored(), calls: { ...authored().calls,
    calls: records.filter((record) => (record as { status: string }).status === 'invoking').length,
    backend: { kind: 'harness_infer', transport: 'acp', observed: records } } });
  /** A CREATE that never reached a proposal: the Session free (or waiting) after its turn. */
  const stopped = (evidence: unknown, waiting = 'free') => ({ ...journey(), steps: [{ step: 'create_open', open_ms: 5 },
    { step: 'create_turn', turn: 0, evidence }, { step: 'create_reached', waiting, key: null, outcomes: ['facts'],
      evidence, timing: { submit_to_settled_ms: 900, author_ms: 800 } }] });
  /** A component as `nika-session-change` serializes a revision's use of it. */
  const used = (witness: string) => ({ id: 'block:stale-filter-report', version: 'r1', release: '2'.repeat(64),
    file_sha256: null, bindings: [{ path: 'const.max_age_hours', value: 72 }], witness });

  it('passes both legs of a full route, its timing and the reuse its EDIT witnessed', () => {
    const reused = journey();
    const editReached = reused.steps.find((entry) => entry.step === 'edit_reached');
    editReached.evidence = authored({ ...revised(EDITED), components: [used('expanded')] },
      [file('stale.nika', EDITED)]);
    const { legs } = judgeJourney(reused, EXPECTED);
    expect([legs.create.outcome, legs.edit.outcome]).toEqual(['passed', 'passed']);
    expect([legs.create.attempted, legs.edit.attempted]).toEqual([true, true]);
    // The tickets world's CREATE states no revision: its reuse is not observable, never "none".
    expect(legs.create.reuse).toMatchObject({ observable: false, reused: [], present_in_run: [] });
    expect(legs.edit.reuse).toMatchObject({ observable: true, candidate_sha256: EDITED, saved_exact: true,
      ran_exact: true, reused: ['block:stale-filter-report'], present_in_run: ['block:stale-filter-report'] });
    expect(legs.edit.reuse.components[0]).toMatchObject({ witness: 'expanded', bindings: [{ path: 'const.max_age_hours',
      value: 72 }] });
    // A succeeded Run of those bytes may still have skipped the component's branch: structural
    // presence is witnessed, its nodes' execution is never claimed.
    expect(Object.keys(legs.edit.reuse).filter((key) => /execut/.test(key))).toEqual([]);
  });

  it('names reuse by expansion in the saved bytes, the Run a separate fact', () => {
    const witnessed = (change: Record<string, unknown>, at: string) => {
      const report = edit(journey(), at, change);
      report.steps.find((entry) => entry.step === 'edit_reached').evidence = authored({ ...revised(EDITED),
        components: [used('expanded'), { ...used('revised'), id: 'block:other' }] }, [file('stale.nika', EDITED)]);
      return judgeJourney(report, EXPECTED).legs.edit;
    };
    // A Run of other bytes: the saved workflow still holds the expansion, no Run holds it, the leg fails.
    const ranElsewhere = witnessed({ run: { current: true, workflow: 'stale.nika', end: { end: 'succeeded' },
      workflow_sha256: OTHER } }, 'edit_run_observed');
    expect(ranElsewhere.reuse).toMatchObject({ saved_exact: true, ran_exact: false,
      reused: ['block:stale-filter-report'], present_in_run: [] });
    expect(ranElsewhere.outcome).toBe('failed');
    // The exact bytes ran but the Run failed: present in no succeeded Run.
    const failedRun = witnessed({ run: { current: true, workflow: 'stale.nika', end: { end: 'failed' },
      workflow_sha256: EDITED } }, 'edit_run_observed');
    expect(failedRun.reuse).toMatchObject({ ran_exact: true, reused: ['block:stale-filter-report'],
      present_in_run: [] });
    // Saved bytes other than the ones the revision witnessed: nothing is reused, a revised use never.
    const savedElsewhere = witnessed({ saved_sha256: OTHER }, 'edit_save');
    expect(savedElsewhere.reuse).toMatchObject({ saved_exact: false, reused: [], present_in_run: [] });
    expect(savedElsewhere.reuse.components.map((use: { witness: string }) => use.witness))
      .toEqual(['expanded', 'revised']);
  });

  it('tells a semantic hold from a provider failure by the calls\' own ends', () => {
    const held = judgeJourney(stopped(harnessed([...receipt('returned'), ...receipt('returned')])), EXPECTED);
    expect(held.legs.create).toMatchObject({ attempted: true, outcome: 'semantic_hold', why: 'the Session waits on free',
      calls: { invoked: 2, returned: 2, failed: 0 }, timing: { open_ms: 5, submit_to_settled_ms: 900, author_ms: 800 } });
    const failed = judgeJourney(stopped(harnessed(receipt('failed'))), EXPECTED);
    expect(failed.legs.create).toMatchObject({ outcome: 'provider_failure',
      calls: { invoked: 1, returned: 0, failed: 1 } });
    const timedOut = judgeJourney(stopped(harnessed([...receipt('timed_out'), ...receipt('cancelled')])), EXPECTED);
    expect(timedOut.legs.create).toMatchObject({ outcome: 'provider_failure',
      calls: { invoked: 2, timed_out: 1, cancelled: 1 } });
    // One answered call among failed ones is no provider failure: the verifier held what it answered.
    const mixed = judgeJourney(stopped(harnessed([...receipt('failed'), ...receipt('returned')])), EXPECTED);
    expect(mixed.legs.create.outcome).toBe('semantic_hold');
    // An EDIT behind a stopped CREATE was never attempted.
    expect(held.legs.edit).toMatchObject({ attempted: false, outcome: 'not_attempted' });
  });

  it('reads the engine\'s per-call rows when no harness receipt names the ends', () => {
    const rows = (...ends: Record<string, unknown>[]) => ({ ...authored(), calls: { ...authored().calls,
      calls: ends.length, backend: { kind: 'direct_api' }, per_call: ends.map((end, index) => ({ call: index === 0
        ? 'document' : 'document-repair', elapsed_ms: 10, stop_reason: null, failure_kind: null, ...end })) } });
    const refused = judgeJourney(stopped(rows({ failure_kind: 'provider_error' }, { failure_kind: 'timeout' })),
      EXPECTED);
    expect(refused.legs.create).toMatchObject({ outcome: 'provider_failure',
      calls: { invoked: 2, failed: 1, timed_out: 1, complete: true, incomplete: [] } });
    expect(refused.legs.create.per_call).toEqual([
      { call: 'document', elapsed_ms: 10, stop_reason: null, failure_kind: 'provider_error' },
      { call: 'document-repair', elapsed_ms: 10, stop_reason: null, failure_kind: 'timeout' }]);
    const held = judgeJourney(stopped(rows({ stop_reason: 'EndTurn' })), EXPECTED);
    expect(held.legs.create.outcome).toBe('semantic_hold');
  });

  it('claims no class the evidence does not show', () => {
    // Calls counted with no receipt of how they ended: neither a hold nor a provider failure.
    const unknown = judgeJourney(stopped(authored()), EXPECTED);
    expect(unknown.legs.create).toMatchObject({ outcome: 'not_exercised', calls: { complete: false } });
    expect(unknown.legs.create.why).toBe('the receipts are incomplete: create_turn 0 counts 2 authoring call(s) '
      + 'but its receipt holds 0; create_reached counts 2 authoring call(s) but its receipt holds 0');
    // A question the persona was not told to answer is no hold either.
    const asked = judgeJourney(stopped(harnessed(receipt('returned')), 'question'), EXPECTED);
    expect(asked.legs.create.outcome).toBe('not_exercised');
    // A Session showing a seat other than the one requested: its hold is never that seat's.
    const unseated = judgeJourney(stopped(harnessed(receipt('returned'))), EXPECTED, '1 acp:claude-code/opus[1m]');
    expect(unseated.legs.create).toMatchObject({ outcome: 'not_exercised',
      why: 'the Session opened on a choice kept before this journey, never asked the first screen' });
    // A wrong report fails the leg, named by its check.
    const wrong = judgeJourney(edit(journey(), 'create_run_observed', { report: { count: 1, ids: ['stale-60'] } }),
      EXPECTED);
    expect(wrong.legs.create).toMatchObject({ outcome: 'failed',
      why: 'the CREATE report holds exactly the expected tickets' });
  });

  it('fails only the leg a fault stopped, never a CREATE its own evidence passed', () => {
    const afterCreate = judgeJourney({ ...journey(), error: { message: 'the EDIT frame was malformed' } }, EXPECTED);
    expect([afterCreate.verdict, afterCreate.legs.create.outcome, afterCreate.legs.edit.outcome])
      .toEqual(['failed', 'passed', 'failed']);
    // A fault inside CREATE fails it; its EDIT was never attempted.
    const inCreate = { ...journey(), error: { message: 'the save frame was malformed' } };
    inCreate.steps = inCreate.steps.filter((entry) => entry.step.startsWith('create_'));
    const failed = judgeJourney(inCreate, EXPECTED);
    expect([failed.legs.create.outcome, failed.legs.create.why, failed.legs.edit.outcome])
      .toEqual(['failed', 'the journey completed', 'not_attempted']);
  });

  it('counts a first submit the Session accepted though the harness stopped waiting', () => {
    const cut = (busy: unknown) => ({ ...journey(), steps: [{ step: 'create_open', open_ms: 5 },
      { step: 'create_harness_bound', bound: 'turn_wait', limit_ms: 1000, command: 'words-0', busy, waiting: null,
        evidence: null, why: 'the harness stopped waiting for words-0 after 1000 ms: an observation bound of this '
          + 'harness, never a product limit' }] });
    const accepted = judgeJourney(cut({ command: 'words-0', phase: 'preparing', stop_requested: false }), EXPECTED);
    expect(accepted.legs.create).toMatchObject({ attempted: true, outcome: 'not_exercised',
      why: 'the harness stopped waiting for words-0 after 1000 ms: an observation bound of this harness, never a '
        + 'product limit' });
    expect(accepted.legs.edit).toMatchObject({ attempted: false, outcome: 'not_attempted' });
    expect(journeyDenominators([{ door: 'native', exercised: true, ...accepted }])).toMatchObject({
      create: { attempted: 1, not_exercised: 1 }, edit: { attempted: 0 }, full_routes: { passed: 0, of: 1 } });
    // Busy on nothing, or on another command: no submit of these words is shown accepted.
    for (const busy of [null, { command: 'words-1', phase: 'preparing', stop_requested: false }]) {
      expect(judgeJourney(cut(busy), EXPECTED).legs.create.attempted).toBe(false);
    }
  });

  it('draws no cause from incomplete call receipts, keeping their partial counts', () => {
    // Three calls declared, one receipt pair: the two other ends are unknown.
    const partial = { ...harnessed(receipt('failed')), calls: { ...harnessed(receipt('failed')).calls, calls: 3 } };
    const judged = judgeJourney(stopped(partial), EXPECTED);
    expect(judged.legs.create).toMatchObject({ attempted: true, outcome: 'not_exercised',
      calls: { invoked: 1, returned: 0, failed: 1, complete: false } });
    expect(judged.legs.create.why).toBe('the receipts are incomplete: create_turn 0 counts 3 authoring call(s) '
      + 'but its receipt holds 1; create_reached counts 3 authoring call(s) but its receipt holds 1');
    // An invocation with no end, or an end with no invocation, proves no cause either.
    const unended = judgeJourney(stopped(harnessed([{ status: 'invoking', requested_effort: 'max' }])), EXPECTED);
    expect(unended.legs.create).toMatchObject({ outcome: 'not_exercised', calls: { invoked: 1, complete: false } });
    const orphan = judgeJourney(stopped(harnessed([{ status: 'failed' }])), EXPECTED);
    expect(orphan.legs.create.outcome).toBe('not_exercised');
    // Two ends for one invocation: the second closes nothing.
    const doubled = judgeJourney(stopped(harnessed([...receipt('failed'), { status: 'failed' }])), EXPECTED);
    expect(doubled.legs.create).toMatchObject({ outcome: 'not_exercised', calls: { invoked: 1, failed: 1,
      complete: false } });
    expect(doubled.legs.create.why).toContain('failed record with no invocation before it');
  });

  it('counts each leg only where its words were sent', () => {
    const door = (judged: Judged, exercised = true) => ({ door: 'native', exercised, ...judged });
    const full = door(judgeJourney(journey(), EXPECTED));
    const held = door(judgeJourney(stopped(harnessed(receipt('returned'))), EXPECTED));
    const failed = door(judgeJourney(stopped(harnessed(receipt('failed'))), EXPECTED));
    const unexercised = { door: 'http', exercised: false, why: 'the engine identity lists no sessionHost' };
    expect(journeyDenominators([full, held, failed, unexercised])).toEqual({
      create: { attempted: 3, passed: 1, semantic_hold: 1, provider_failure: 1, failed: 0, not_exercised: 0 },
      edit: { attempted: 1, passed: 1, semantic_hold: 0, provider_failure: 0, failed: 0, not_exercised: 0 },
      full_routes: { passed: 1, of: 3 },
      law: 'an EDIT behind a stopped CREATE was never attempted and counts in no EDIT denominator' });
  });
});
