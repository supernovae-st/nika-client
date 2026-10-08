import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The journey (scripts/packed-consumers/session-journey.cjs) walked end to end over a SCRIPTED
// Session: no engine, no model. The scripted Session proposes, saves the proposed bytes into a
// temporary project and "runs" by writing the report a leg's threshold selects, so the journey's
// own mechanics are witnessed: the persona's answer rules, the exact saved bytes, the real check
// of them, the Run window, and the capture of each leg's world before the next leg changes it.

const require = createRequire(import.meta.url);
type Journey = { module_system: string; door: string; steps: any[]; error: any };
const journey = require('../scripts/packed-consumers/session-journey.cjs') as ((sdk: unknown, config: unknown) =>
  Promise<Journey>) & { judgeJourney: (report: Journey, expected: unknown, requested?: string | null,
    worldChecks?: Record<string, unknown[]> | null) => { verdict: string; checks: { name: string; verdict: string;
      why?: string }[] } };
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const SINK = 'http://127.0.0.1:1/notifications/hook';
const WORKFLOW = (threshold: number) => `nika: stale\nconst:\n  max_age_hours: ${threshold}\ntasks: {}\n`;

type Seat = Record<string, unknown> | null;

/**
 * One scripted Session over `project`: words propose, `yes` saves, `run it` writes the report,
 * first asking the declared input `runInput` when one is named. `seat` names the selection its
 * opened frame shows and the one every later frame shows.
 */
function scriptedSession(project: string, asked: string | null, sent: string[], runInput: string | null = null,
  seat: { opened: Seat; prepared: Seat } | null = null) {
  let seq = 1;
  let created: string | null = null;
  const files = () => (existsSync(path.join(project, 'stale.nika'))
    ? readFileSync(path.join(project, 'stale.nika'), 'utf8') : null);
  let work: Record<string, any> = { contract: 'nika/session-work@0', root: project, request: {}, authoring: null,
    intelligence: { selected: seat === null ? { kind: 'api', via: 'deepseek' } : seat.prepared,
      author: { kind: 'provider', model: 'deepseek/x' } },
    waiting: { kind: 'free' }, candidate: null, saved: null, requested: null, run: null, rail: {} };
  let pending: string | null = null;
  const snapshot = () => ({ snapshot: `snp-${seq}`, seq, busy: null, work: structuredClone(work) });
  const result = (outcomes: Record<string, unknown>[]) => {
    seq += 1;
    return { frame: 'result', event: seq, op: 'submit', replayed: false, outcomes, snapshot: snapshot() };
  };
  const propose = (content: string, revision: unknown) => {
    pending = content;
    work = { ...work, waiting: { kind: 'consent', proposal: 'p' }, authoring: { status: 'ready', questions: [],
      diagnostics: [], calls: { requested_model: 'deepseek/x', calls: 2, input_tokens: 1, output_tokens: 2,
        elapsed_ms: 3, backend: null } },
    candidate: { files: [{ path: 'stale.nika', bytes: 'b'.repeat(64), content, landing: 'create' }], revision } };
    return result([{ kind: 'proposal' }]);
  };
  const opened = { frame: 'opened', event: 1, snapshot: snapshot() };
  if (seat !== null) opened.snapshot.work.intelligence.selected = seat.opened;
  return {
    opened,
    async submit(_shown: unknown, line: string) {
      sent.push(line);
      if (line === 'yes' && pending !== null) {
        writeFileSync(path.join(project, 'stale.nika'), pending);
        pending = null;
        work = { ...work, waiting: { kind: 'free' }, candidate: null, saved: { workflow: 'stale.nika' } };
        return result([{ kind: 'facts' }]);
      }
      const runNow = (outcomes: Record<string, unknown>[]) => {
        const bytes = files()!;
        const threshold = Number(/max_age_hours: (\d+)/.exec(bytes)![1]);
        mkdirSync(path.join(project, 'out'), { recursive: true });
        const ids = threshold === 48 ? ['stale-60', 'boundary-72', 'stale-90'] : ['stale-90'];
        writeFileSync(path.join(project, 'out', 'report.json'), JSON.stringify({ count: ids.length, ids }));
        work = { ...work, waiting: { kind: 'free' }, run: { current: true, workflow: 'stale.nika',
          end: { end: 'succeeded' }, workflow_sha256: sha256(bytes), trace: '.nika/traces/run.ndjson' } };
        return result(outcomes);
      };
      if (line === 'run it' && runInput !== null) {
        work = { ...work, waiting: { kind: 'input', name: runInput } };
        return result([{ kind: 'run_requested' }, { kind: 'input', text: `The value of ${runInput}?` }]);
      }
      if (line === 'run it') return runNow([{ kind: 'run_requested' }, { kind: 'facts' }]);
      if (work.waiting.kind === 'input') return runNow([{ kind: 'facts' }]);
      if (asked !== null && work.waiting.kind !== 'question' && line.startsWith('Create')) {
        work = { ...work, waiting: { kind: 'question', key: asked } };
        return result([{ kind: 'question', text: 'Where should the notification be sent?' }]);
      }
      if (work.waiting.kind === 'question') {
        work = { ...work, waiting: { kind: 'free' } };
        created = WORKFLOW(48);
        return propose(created, null);
      }
      if (line.startsWith('Create')) {
        created = WORKFLOW(48);
        return propose(created, null);
      }
      const base = files()!;
      const revised = WORKFLOW(72);
      return propose(revised, { mode: 'operations', base_sha256: sha256(base), candidate_sha256: sha256(revised),
        changed: ['const.max_age_hours'], components: [] });
    },
    async snapshot() { return snapshot(); },
    async details() { return { frame: 'details', text: 'Details · scripted: how the last workflow was built' }; },
    async close() { return { frame: 'closed' }; },
  };
}

function fakeSdk(project: string, asked: string | null, sent: string[], runInput: string | null = null) {
  return { Nika: class { openSession = async () => scriptedSession(project, asked, sent, runInput); } };
}

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function world() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nika-sdk-journey-world-'));
  scratches.push(dir);
  const project = path.join(dir, 'project');
  mkdirSync(project);
  const check = path.join(dir, 'fake-check.mjs');
  writeFileSync(check, '#!/usr/bin/env node\nconsole.log(`checked ${process.argv[3]} in ${process.cwd()}`);\n');
  chmodSync(check, 0o755);
  return { dir, project, check };
}

describe('a journey walked over a scripted Session', () => {
  it('records the exact saved bytes, their real check, the Run window and each leg\'s own world', async () => {
    const { dir, project, check } = world();
    const sent: string[] = [];
    const report = await journey(fakeSdk(project, null, sent), { door: 'native', bin: '/x', project,
      moduleSystem: 'esm', choice: null, answers: {}, create: 'Create the stale report', edit: 'Raise to 72',
      checkBin: check, snapshots: path.join(dir, 'legs'), capture: ['out'] });
    expect(report.error).toBeNull();
    const step = (name: string) => report.steps.find((entry) => entry.step === name);
    const save = step('create_save');
    expect(Buffer.from(save.saved_base64, 'base64').toString('utf8')).toBe(WORKFLOW(48));
    expect(save.saved_sha256).toBe(sha256(WORKFLOW(48)));
    expect(save.check).toMatchObject({ rc: 0, error: null });
    expect(save.check.text).toContain('checked stale.nika in');
    const created = step('create_run_observed');
    expect(created.window.started_at).toBeLessThanOrEqual(created.window.observed_at);
    // The CREATE leg's world as its Run left it, although the EDIT Run rewrote the project's report.
    expect(JSON.parse(readFileSync(path.join(created.snapshot.dir, 'out', 'report.json'), 'utf8')))
      .toEqual({ count: 3, ids: ['stale-60', 'boundary-72', 'stale-90'] });
    expect(JSON.parse(readFileSync(path.join(project, 'out', 'report.json'), 'utf8'))).toEqual({ count: 1,
      ids: ['stale-90'] });
    const edited = step('edit_run_observed');
    expect(JSON.parse(readFileSync(path.join(edited.snapshot.dir, 'out', 'report.json'), 'utf8')).ids)
      .toEqual(['stale-90']);
    expect(sent).toEqual(['Create the stale report', 'yes', 'run it', 'Raise to 72', 'yes', 'run it']);
    const judged = journey.judgeJourney(report, { create: ['stale-60', 'boundary-72', 'stale-90'],
      edit: ['stale-90'] });
    expect(judged.checks.filter((entry) => entry.verdict !== 'passed')).toEqual([]);
  });

  it('answers a question by a persona rule on its asking words, and says why', async () => {
    const { dir, project, check } = world();
    const sent: string[] = [];
    const report = await journey(fakeSdk(project, 'const.target', sent), { door: 'native', bin: '/x', project,
      moduleSystem: 'esm', choice: null, create: 'Create the stale report', edit: 'Raise to 72', checkBin: check,
      snapshots: path.join(dir, 'legs'), capture: ['out'],
      answers: [{ text: 'notification', line: SINK, why: 'the observed sink address' }] });
    expect(sent.slice(0, 2)).toEqual(['Create the stale report', SINK]);
    expect(report.steps.find((entry) => entry.step === 'create_turn' && entry.turn === 1).said)
      .toBe('answer const.target (the observed sink address)');
  });

  it('gives a Run\'s declared input only by a persona rule on its name, then observes the Run', async () => {
    const { dir, project, check } = world();
    const sent: string[] = [];
    const report = await journey(fakeSdk(project, null, sent, 'sink_url'), { door: 'native', bin: '/x', project,
      moduleSystem: 'esm', choice: null, create: 'Create the stale report', edit: 'Raise to 72', checkBin: check,
      snapshots: path.join(dir, 'legs'), capture: ['out'],
      answers: [{ key: 'sink|url', line: SINK, why: 'the observed sink address' }] });
    expect(sent).toEqual(['Create the stale report', 'yes', 'run it', SINK, 'Raise to 72', 'yes', 'run it', SINK]);
    expect(report.steps.find((entry) => entry.step === 'create_run_input'))
      .toMatchObject({ input: 'sink_url', said: 'the observed sink address' });
    const judged = journey.judgeJourney(report, { create: ['stale-60', 'boundary-72', 'stale-90'],
      edit: ['stale-90'] });
    expect(judged.verdict).toBe('passed');
  });

  it('stops at once when a Run waits on an input no rule answers, saying what it waits on', async () => {
    const { dir, project, check } = world();
    const sent: string[] = [];
    const started = Date.now();
    const report = await journey(fakeSdk(project, null, sent, 'sink_url'), { door: 'native', bin: '/x', project,
      moduleSystem: 'esm', choice: null, answers: {}, create: 'Create the stale report', edit: 'Raise to 72',
      checkBin: check, snapshots: path.join(dir, 'legs'), capture: ['out'] });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sent.slice(0, 3)).toEqual(['Create the stale report', 'yes', 'run it']);
    expect(report.steps.find((entry) => entry.step === 'create_run_observed')).toMatchObject({ deadline: false,
      run: null, waiting: { kind: 'input', name: 'sink_url' } });
    const judged = journey.judgeJourney(report, { create: ['stale-60', 'boundary-72', 'stale-90'],
      edit: ['stale-90'] });
    expect(judged.checks.find((entry) => entry.name === 'the CREATE Run of the saved workflow succeeded'))
      .toMatchObject({ verdict: 'not_exercised', why: 'the Session waits on input sink_url, which the persona does not answer' });
    expect(judged.verdict).toBe('not_exercised');
  });

  it('keeps the draft a judge held, with its digest, when no proposal is reached', async () => {
    const { dir, project, check } = world();
    const held = WORKFLOW(48);
    const sdk = { Nika: class {
      openSession = async () => {
        const session = scriptedSession(project, null, []);
        return { ...session, submit: async (shown: unknown, line: string) => {
          const settled = await session.submit(shown, line);
          // The judge held the candidate: shown as the draft, never offered.
          settled.snapshot.work = { ...settled.snapshot.work, waiting: { kind: 'free' }, candidate: null,
            authoring: { ...settled.snapshot.work.authoring, status: 'incomplete', draft: held } };
          return settled;
        } };
      };
    } };
    const report = await journey(sdk, { door: 'native', bin: '/x', project, moduleSystem: 'esm', choice: null,
      answers: {}, create: 'Create the stale report', edit: 'Raise to 72', checkBin: check,
      snapshots: path.join(dir, 'legs'), capture: ['out'] });
    const reached = report.steps.find((entry) => entry.step === 'create_reached');
    expect(reached).toMatchObject({ waiting: 'free', draft: held, draft_sha256: sha256(held),
      details: 'Details · scripted: how the last workflow was built' });
    // The raw work rides along, every member as the Session showed it.
    expect(reached.work).toMatchObject({ waiting: { kind: 'free' }, candidate: null,
      authoring: { status: 'incomplete', draft: held } });
    expect(journey.judgeJourney(report, null).checks.find((entry) => /CREATE leg reached/.test(entry.name)))
      .toMatchObject({ verdict: 'not_exercised' });
  });

  it('ends a leg on a cut wait as the harness bound it is, keeping the Session as it was then', async () => {
    const { dir, project, check } = world();
    const sdk = { Nika: class {
      openSession = async () => {
        const session = scriptedSession(project, null, []);
        return { ...session,
          submit: async (shown: unknown, line: string, options: { command: string }) => {
            if (line === 'run it') {
              throw Object.assign(new Error('session: the wait was cut'), { name: 'NikaSessionWaitError',
                command: options.command });
            }
            return session.submit(shown, line);
          },
          snapshot: async () => ({ ...(await session.snapshot()), busy: { command: 'create-run', phase: 'running',
            stop_requested: false } }) };
      };
    } };
    const report = await journey(sdk, { door: 'native', bin: '/x', project, moduleSystem: 'esm', choice: null,
      answers: {}, create: 'Create the stale report', edit: 'Raise to 72', checkBin: check, waitMs: 4321,
      snapshots: path.join(dir, 'legs'), capture: ['out'] });
    expect(report.error).toBeNull();
    expect(report.steps.find((entry) => entry.step === 'create_harness_bound')).toMatchObject({ bound: 'turn_wait',
      limit_ms: 4321, command: 'create-run', busy: { command: 'create-run', phase: 'running' },
      why: 'the harness stopped waiting for create-run after 4321 ms: an observation bound of this harness, never a '
        + 'product limit' });
    // The Save was observed before the bound; the Run and what follows were not.
    const judged = journey.judgeJourney(report, { create: [], edit: [] });
    expect(judged.checks.find((entry) => /CREATE consent/.test(entry.name))).toMatchObject({ verdict: 'passed' });
    expect(judged.checks.filter((entry) => /CREATE (Run|report)/.test(entry.name)).map((entry) => entry.verdict))
      .toEqual(['not_exercised', 'not_exercised', 'not_exercised']);
    expect(judged.verdict).toBe('not_exercised');
  });

  it('stops at a question no rule answers, never guessing', async () => {
    const { dir, project, check } = world();
    const sent: string[] = [];
    const report = await journey(fakeSdk(project, 'const.target', sent), { door: 'native', bin: '/x', project,
      moduleSystem: 'esm', choice: null, create: 'Create the stale report', edit: 'Raise to 72', checkBin: check,
      snapshots: path.join(dir, 'legs'), capture: ['out'], answers: [{ key: 'webhook', line: SINK, why: 'sink' }] });
    expect(sent).toEqual(['Create the stale report']);
    expect(report.steps.find((entry) => entry.step === 'create_reached')).toMatchObject({ waiting: 'question',
      key: 'const.target' });
  });
});

describe('a journey opened with the conversation\'s own intelligence', () => {
  const WORDS = '2 deepseek/deepseek-v4-pro';
  const selected = (extra: Record<string, unknown> = {}) => ({ kind: 'api', via: 'deepseek',
    model: 'deepseek/deepseek-v4-pro', transport: null, ready: true, scope: 'conversation', ...extra });
  const FLASH = selected({ model: 'deepseek/deepseek-flash' });
  /** One selection in every frame of a Session. */
  const throughout = (seat: Seat) => ({ opened: seat, prepared: seat });
  /**
   * A scripted SDK whose n-th Session shows `seats[n]` (the last one past the list): one selection
   * in its opened frame, one in every frame after it. What openSession was asked is recorded;
   * `onOpen` runs at each open.
   */
  function chosenSdk(project: string, seats: { opened: Seat; prepared: Seat }[], asked: unknown[], onOpen = () => {}) {
    let opens = 0;
    return { Nika: class {
      openSession = async (options: unknown) => {
        asked.push(options);
        onOpen();
        const seat = seats[Math.min(opens, seats.length - 1)]!;
        opens += 1;
        return scriptedSession(project, null, [], null, seat);
      };
    } };
  }
  function homeWithKeptChoice() {
    const { dir, project, check } = world();
    const home = path.join(dir, 'home');
    mkdirSync(path.join(home, '.nika'), { recursive: true });
    writeFileSync(path.join(home, '.nika', 'session-intelligence.json'), '{"kind":"api","via":"deepseek"}\n');
    vi.stubEnv('HOME', home);
    return { dir, project, check, home };
  }
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const config = (dir: string, project: string, check: string) => ({ door: 'native', bin: '/x', project,
    moduleSystem: 'esm', choice: null, intelligence: WORDS, answers: {}, create: 'Create the stale report',
    edit: 'Raise to 72', checkBin: check, snapshots: path.join(dir, 'legs'), capture: ['out'] });
  const verdict = (judged: { checks: { name: string; verdict: string }[] }, name: RegExp) =>
    judged.checks.filter((entry) => name.test(entry.name)).map((entry) => entry.verdict);
  const TICKETS = { create: ['stale-60', 'boundary-72', 'stale-90'], edit: ['stale-90'] };
  const SEAT_AND_SCOPE = /Session prepared with the requested intelligence|conversation alone/;
  const named = (judged: { checks: { name: string; verdict: string; observed?: any }[] }, name: string) =>
    judged.checks.find((entry) => entry.name === name)!;
  /** One journey over a fresh project and HOME, judged for WORDS: only the seat can fail it. */
  async function judgedFor(seats: { opened: Seat; prepared: Seat }[]) {
    const { dir, project, check } = homeWithKeptChoice();
    return journey.judgeJourney(await journey(chosenSdk(project, seats, []), config(dir, project, check)), TICKETS,
      WORDS);
  }

  it('opens each Session with the words, holds them for the conversation and keeps nothing for the operator', async () => {
    const { dir, project, check } = homeWithKeptChoice();
    const asked: unknown[] = [];
    // Every frame of both Sessions shows the requested seat, held for this conversation.
    const report = await journey(chosenSdk(project, [throughout(selected())], asked), config(dir, project, check));
    expect(asked).toEqual([expect.objectContaining({ intelligence: WORDS }), expect.objectContaining({ intelligence: WORDS })]);
    const judged = journey.judgeJourney(report, TICKETS, WORDS);
    expect(judged.checks.filter((entry) => /requested intelligence|kept choice/.test(entry.name))
      .map((entry) => [entry.name, entry.verdict])).toEqual([
      ['the CREATE Session prepared with the requested intelligence', 'passed'],
      ['the CREATE Session holds the requested intelligence for this conversation alone', 'passed'],
      ['the EDIT Session prepared with the requested intelligence', 'passed'],
      ['the EDIT Session holds the requested intelligence for this conversation alone', 'passed'],
      ['the operator\'s kept choice is byte-identical across the journey', 'passed'],
    ]);
    // Each leg is read in every frame its Session showed, the EDIT one included.
    expect(named(judged, 'the EDIT Session prepared with the requested intelligence').observed.frames
      .map((frame: { at: string }) => frame.at)).toEqual(['edit_open', 'edit_turn 0', 'edit_reached']);
    expect(judged.verdict).toBe('passed');
  });

  it('fails another seat, an operator-scoped selection, or a kept choice the journey rewrote', async () => {
    expect(verdict(await judgedFor([throughout(FLASH)]), /prepared with the requested intelligence/))
      .toEqual(['failed', 'failed']);
    expect(verdict(await judgedFor([throughout(selected({ scope: 'operator_default' }))]), /conversation alone/))
      .toEqual(['failed', 'failed']);
    const rewritten = homeWithKeptChoice();
    const rewrote = await journey(chosenSdk(rewritten.project, [throughout(selected())], [], () => writeFileSync(
      path.join(rewritten.home, '.nika', 'session-intelligence.json'), '{"kind":"harness"}\n')),
    config(rewritten.dir, rewritten.project, rewritten.check));
    expect(verdict(journey.judgeJourney(rewrote, null, WORDS), /kept choice/)).toEqual(['failed']);
  });

  // Independent review of 006bc2c: the judge read the selection at the CREATE open only, so a
  // Session that opened on the requested seat and then prepared with another passed.
  it('fails a Session that opens on the requested seat and prepares CREATE and EDIT with another', async () => {
    const operatorFlash = { ...FLASH, scope: 'operator_default' };
    const judged = await judgedFor([{ opened: selected(), prepared: operatorFlash }, throughout(operatorFlash)]);
    expect(verdict(judged, SEAT_AND_SCOPE)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(named(judged, 'the CREATE Session prepared with the requested intelligence').observed.other
      .map((frame: { at: string }) => frame.at)).toEqual(['create_turn 0', 'create_reached']);
    expect(judged.verdict).toBe('failed');
  });

  it.each([
    ['opens and prepares EDIT with another seat', throughout(FLASH), ['edit_open', 'edit_turn 0', 'edit_reached']],
    ['opens EDIT on the requested seat and prepares it with another', { opened: selected(), prepared: FLASH },
      ['edit_turn 0', 'edit_reached']],
  ])('fails a journey whose CREATE holds the requested seat and whose EDIT %s', async (_name, edit, frames) => {
    const judged = await judgedFor([throughout(selected()), edit]);
    expect(verdict(judged, SEAT_AND_SCOPE)).toEqual(['passed', 'passed', 'failed', 'passed']);
    expect(named(judged, 'the EDIT Session prepared with the requested intelligence').observed.other
      .map((frame: { at: string }) => frame.at)).toEqual(frames);
    expect(judged.verdict).toBe('failed');
  });

  it('never passes a leg whose opened or reached frame shows no selection', async () => {
    const unseenReached = await judgedFor([{ opened: selected(), prepared: null }]);
    expect(verdict(unseenReached, SEAT_AND_SCOPE)).toEqual(Array(4).fill('not_exercised'));
    expect(named(unseenReached, 'the CREATE Session prepared with the requested intelligence'))
      .toMatchObject({ why: 'no selection was observed at create_reached' });
    const unseenOpen = await judgedFor([{ opened: null, prepared: selected() }]);
    expect(named(unseenOpen, 'the EDIT Session holds the requested intelligence for this conversation alone'))
      .toMatchObject({ verdict: 'not_exercised', why: 'no selection scope was observed at edit_open' });
    expect([unseenReached.verdict, unseenOpen.verdict]).toEqual(['not_exercised', 'not_exercised']);
  });
});

describe('a world module states each leg\'s postconditions', () => {
  async function walked() {
    const { dir, project, check } = world();
    return journey(fakeSdk(project, null, []), { door: 'native', bin: '/x', project, moduleSystem: 'esm',
      choice: null, answers: {}, create: 'Create the stale report', edit: 'Raise to 72', checkBin: check,
      snapshots: path.join(dir, 'legs'), capture: ['out'] });
  }
  const pass = (name: string) => ({ name, verdict: 'passed', observed: {} });

  it('passes when the world\'s checks pass, beside the journey\'s identity checks', async () => {
    const judged = journey.judgeJourney(await walked(), null, null, { create: [pass('oracle CREATE')],
      edit: [pass('oracle EDIT')] });
    expect(judged.verdict).toBe('passed');
    expect(judged.checks.map((entry) => entry.name)).toContain('oracle EDIT');
    expect(judged.checks.some((entry) => /tickets/.test(entry.name))).toBe(false);
  });

  it('fails a failed world check, withholds a leg the world did not judge, refuses a malformed one', async () => {
    const report = await walked();
    expect(journey.judgeJourney(report, null, null, { create: [pass('a')],
      edit: [{ name: 'oracle EDIT', verdict: 'failed', observed: { class: 'WRONG_VALUE' } }] }).verdict).toBe('failed');
    const silent = journey.judgeJourney(report, null, null, { create: [pass('a')] });
    expect(silent.checks.find((entry) => entry.name === 'the EDIT world postconditions hold'))
      .toMatchObject({ verdict: 'not_exercised', why: 'the world judged nothing for this leg' });
    expect(journey.judgeJourney(report, null, null, { create: [pass('a')], edit: [{ verdict: 'great' }] }).verdict)
      .toBe('failed');
  });
});
