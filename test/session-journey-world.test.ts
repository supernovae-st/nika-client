import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

/** One scripted Session over `project`: words propose, `yes` saves, `run it` writes the report. */
function scriptedSession(project: string, asked: string | null, sent: string[]) {
  let seq = 1;
  let created: string | null = null;
  const files = () => (existsSync(path.join(project, 'stale.nika'))
    ? readFileSync(path.join(project, 'stale.nika'), 'utf8') : null);
  let work: Record<string, any> = { contract: 'nika/session-work@0', root: project, request: {}, authoring: null,
    intelligence: { selected: { kind: 'api', via: 'deepseek' }, author: { kind: 'provider', model: 'deepseek/x' } },
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
  return {
    opened: { frame: 'opened', event: 1, snapshot: snapshot() },
    async submit(_shown: unknown, line: string) {
      sent.push(line);
      if (line === 'yes' && pending !== null) {
        writeFileSync(path.join(project, 'stale.nika'), pending);
        pending = null;
        work = { ...work, waiting: { kind: 'free' }, candidate: null, saved: { workflow: 'stale.nika' } };
        return result([{ kind: 'facts' }]);
      }
      if (line === 'run it') {
        const bytes = files()!;
        const threshold = Number(/max_age_hours: (\d+)/.exec(bytes)![1]);
        mkdirSync(path.join(project, 'out'), { recursive: true });
        const ids = threshold === 48 ? ['stale-60', 'boundary-72', 'stale-90'] : ['stale-90'];
        writeFileSync(path.join(project, 'out', 'report.json'), JSON.stringify({ count: ids.length, ids }));
        work = { ...work, run: { current: true, workflow: 'stale.nika', end: { end: 'succeeded' },
          workflow_sha256: sha256(bytes), trace: '.nika/traces/run.ndjson' } };
        return result([{ kind: 'run_requested' }, { kind: 'facts' }]);
      }
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
    async close() { return { frame: 'closed' }; },
  };
}

function fakeSdk(project: string, asked: string | null, sent: string[]) {
  return { Nika: class { openSession = async () => scriptedSession(project, asked, sent); } };
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
