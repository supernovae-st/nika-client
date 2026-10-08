import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The real-door Session qualification's judge and parity
// (scripts/packed-consumers/session-scenario.cjs), on synthetic transcripts
// shaped as the scenario records a walk: what must hold on one door, and what
// two walks must say alike. The walks themselves run against a frozen engine
// binary in scripts/run-session-parity-e2e.mjs.

const require = createRequire(import.meta.url);
type Transcript = { module_system: string; door: string; session: string | null; steps: any[]; error: any };
const { judgeSession, sessionParity, SHARED_STEPS, MODULE_STEPS } =
  require('../scripts/packed-consumers/session-scenario.cjs') as {
    judgeSession: (report: Transcript) => { verdict: string; checks: { name: string; verdict: string; why?: string }[] };
    sessionParity: (left: Transcript, right: Transcript, steps?: string[]) => { equal: boolean; differences: any[] };
    SHARED_STEPS: string[];
    MODULE_STEPS: string[];
  };

const BYTES = 'b'.repeat(64);
const FILE = { path: 'compiled-workflow.nika', bytes: BYTES, landing: 'create', workflow: true };
const frame = (overrides: Record<string, unknown>) => ({ frame: 'result', event: null, op: 'submit', replayed: false,
  receipt: null, outcomes: [], seq: 2, waiting: 'consent', candidate: [FILE], saved: null, requested: null, run: null,
  ...overrides });

/** A walk as a keyless door answers it, every law kept. */
function walk(door: 'native' | 'http', moduleSystem = 'cjs'): Transcript {
  const steps: any[] = [
    { step: 'open', ...frame({ frame: 'opened', event: 1, op: null, seq: 1, waiting: 'free', candidate: null }),
      root_is_project: true },
    { step: 'proposal', ...frame({ event: 4, outcomes: ['proposal'] }) },
    { step: 'preview', files: [FILE], landed_before_consent: [false] },
    { step: 'stale_answer', refused: true, error: 'NikaSessionRefusedError', code: 'stale_snapshot', line: 'yes', seq: 2,
      saved_after: null },
    { step: 'same_command_same_bytes', ...frame({ event: 4, replayed: true, outcomes: ['proposal'] }), same_outcomes: true },
    door === 'native'
      ? { step: 'same_command_other_bytes', refused: true, error: 'NikaConfigurationError', code: null, line: null,
        seq: null, seq_after: 2 }
      : { step: 'same_command_other_bytes', refused: true, error: 'NikaSessionRefusedError', code: 'command_conflict',
        line: 'no', seq: 2, seq_after: 2 },
    { step: 'details', names_current_snapshot: true, has_text: true },
    door === 'native'
      ? { step: 'cross_session_answer', refused: true, error: 'NikaSessionRefusedError', code: 'unknown_snapshot',
        line: 'yes', seq: 1, other_session: true, other_saved: null }
      : { step: 'second_session_same_project', refused: true, error: 'NikaSessionRefusedError', code: 'session_live',
        line: null, seq: null, names_live: true },
    { step: 'consent', ...frame({ event: 6, outcomes: ['facts'], seq: 3, waiting: 'free', candidate: null,
      saved: 'compiled-workflow.nika' }), saved_is_previewed_path: true, saved_bytes_are_previewed: true,
    saved_sha256: BYTES, run_output_before_run: false },
    { step: 'stop_idle', ...frame({ event: 7, op: 'stop', receipt: 'nothing_to_stop', seq: 3, waiting: 'free',
      candidate: null, saved: 'compiled-workflow.nika' }) },
    { step: 'run', ...frame({ event: 12, outcomes: ['run_requested', 'facts'], seq: 4, waiting: 'free', candidate: null,
      saved: 'compiled-workflow.nika' }) },
    { step: 'run_observed', busy: false, waiting: 'free', requested: {}, run: { end: 'succeeded' },
      output_sha256: 'c'.repeat(64), output_is_source: true },
    { step: 'stop_racing_a_turn', receipt: 'stop_requested', target: 'c-5',
      settled: frame({ event: 16, outcomes: ['cancelled'], seq: 5, waiting: 'free', candidate: null }),
      candidate_current: false, second_landed: false },
    { step: 'close', ...frame({ frame: 'closed', event: 17, op: null, seq: 5, waiting: 'free', candidate: null }) },
    { step: 'events', kinds: ['opened', 'accepted', 'result', 'closed'], numbers: [1, 2, 4, 17], ended: 'closed',
      resumed_is_suffix: true, resumed_has_no_replay: true },
    { step: 'restart_answer', refused: true, error: 'NikaSessionRefusedError', code: 'unknown_snapshot', line: 'yes',
      seq: 1, new_session: true, reopened_saved: null },
  ];
  if (door === 'http') {
    steps.push({ step: 'attach_closed_session', refused: true, error: 'NikaSessionRefusedError',
      code: 'session_not_found', line: null, seq: null });
  }
  return { module_system: moduleSystem, door, session: 'ses_1', steps, error: null };
}

function edit(transcript: Transcript, name: string, change: Record<string, unknown>): Transcript {
  return { ...transcript, steps: transcript.steps.map((step) => (step.step === name ? { ...step, ...change } : step)) };
}

const verdictOf = (judged: ReturnType<typeof judgeSession>, name: RegExp) =>
  judged.checks.find((check) => name.test(check.name))?.verdict;

describe('a real-door Session walk is judged by the host\'s laws', () => {
  it.each(['native', 'http'] as const)('passes a %s walk that keeps every law', (door) => {
    const judged = judgeSession(walk(door));
    expect(judged.checks.filter((check) => check.verdict !== 'passed')).toEqual([]);
    expect(judged.verdict).toBe('passed');
  });

  it('fails a stale answer the door accepted', () => {
    const judged = judgeSession(edit(walk('native'), 'stale_answer', { refused: false, code: null, saved_after: 'x' }));
    expect(judged.verdict).toBe('failed');
    expect(verdictOf(judged, /earlier snapshot/)).toBe('failed');
  });

  it('fails a replay that ran the turn again', () => {
    const judged = judgeSession(edit(walk('http'), 'same_command_same_bytes', { replayed: false, event: 9 }));
    expect(verdictOf(judged, /recorded result/)).toBe('failed');
  });

  it('fails a conflict the resident answered with anything but command_conflict', () => {
    const judged = judgeSession(edit(walk('http'), 'same_command_other_bytes', { error: 'NikaConfigurationError',
      code: null }));
    expect(verdictOf(judged, /other bytes/)).toBe('failed');
  });

  it('fails a Save whose bytes are not the previewed ones, or that ran', () => {
    expect(verdictOf(judgeSession(edit(walk('native'), 'consent', { saved_bytes_are_previewed: false })),
      /exactly the previewed/)).toBe('failed');
    expect(verdictOf(judgeSession(edit(walk('native'), 'consent', { run_output_before_run: true })),
      /runs nothing/)).toBe('failed');
  });

  it('leaves the saved bytes unverified when the engine projects no candidate content', () => {
    const judged = judgeSession(edit(walk('http'), 'consent', { saved_bytes_are_previewed: null }));
    expect(verdictOf(judged, /exactly the previewed/)).toBe('not_exercised');
    expect(verdictOf(judged, /runs nothing/)).toBe('passed');
  });

  it('fails a Run whose output is not the source it copies', () => {
    const judged = judgeSession(edit(walk('native'), 'run_observed', { output_is_source: false }));
    expect(verdictOf(judged, /same project world/)).toBe('failed');
  });

  it('withholds the Run postcondition when the Session started none or could not observe it', () => {
    for (const said of ['run_not_started', 'run_unobserved']) {
      const judged = judgeSession(edit(walk('http'), 'run', { outcomes: ['run_requested', said] }));
      expect(verdictOf(judged, /same project world/)).toBe('not_exercised');
      expect(judged.verdict).toBe('not_exercised');
    }
  });

  it('withholds the Stop law when the turn settled before the Stop', () => {
    const judged = judgeSession(edit(walk('native'), 'stop_racing_a_turn', { receipt: 'nothing_to_stop' }));
    expect(verdictOf(judged, /late result/)).toBe('not_exercised');
  });

  it('fails a Stop that let the late result become current', () => {
    const judged = judgeSession(edit(walk('native'), 'stop_racing_a_turn', { candidate_current: true }));
    expect(verdictOf(judged, /late result/)).toBe('failed');
  });

  it('fails a resumed event view that repeats or misses events', () => {
    const judged = judgeSession(edit(walk('http'), 'events', { resumed_is_suffix: false }));
    expect(verdictOf(judged, /resumed/)).toBe('failed');
  });

  it('fails an old snapshot answered after a restart', () => {
    const judged = judgeSession(edit(walk('native'), 'restart_answer', { refused: false, code: null }));
    expect(verdictOf(judged, /restart/)).toBe('failed');
  });

  it('fails a walk that stopped, keeping its partial transcript', () => {
    const partial = { ...walk('native'), steps: walk('native').steps.slice(0, 3),
      error: { name: 'NikaSessionWaitError', message: 'stopped waiting', code: null, at: 'preview' } };
    expect(judgeSession(partial)).toEqual({ verdict: 'failed', checks: [{ name: 'the walk completed',
      verdict: 'failed', observed: partial.error }] });
  });
});

describe('two walks compare step by step', () => {
  it('finds the doors alike up to the Save, whatever error class refuses other bytes', () => {
    expect(sessionParity(walk('native'), walk('http'), SHARED_STEPS)).toEqual({ equal: true, steps: SHARED_STEPS,
      differences: [] });
  });

  it('names a door that numbered an event differently', () => {
    const parity = sessionParity(walk('native'), edit(walk('http'), 'proposal', { event: 5 }), SHARED_STEPS);
    expect(parity.equal).toBe(false);
    expect(parity.differences.map((difference) => difference.step)).toEqual(['proposal']);
  });

  it('names a door that proposed other bytes', () => {
    const other = edit(walk('http'), 'preview', { files: [{ ...FILE, bytes: 'd'.repeat(64) }] });
    expect(sessionParity(walk('native'), other).differences.map((difference) => difference.step)).toEqual(['preview']);
  });

  it('finds both module systems alike on one door, timed steps aside', () => {
    const esm = edit(walk('native', 'esm'), 'stop_racing_a_turn', { receipt: 'nothing_to_stop' });
    expect(sessionParity(walk('native', 'cjs'), esm, MODULE_STEPS).equal).toBe(true);
  });
});
