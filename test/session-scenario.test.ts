import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The real-door Session qualification's judge and parity
// (scripts/packed-consumers/session-scenario.cjs), on synthetic transcripts
// shaped as the scenario records a walk: what must hold on one door, and what
// two walks must say alike. The walks themselves run against a frozen engine
// binary in scripts/run-session-parity-e2e.mjs.

const require = createRequire(import.meta.url);
type Transcript = { module_system: string; door: string; session: string | null; steps: any[]; error: any };
const { judgeSession, sessionParity, landedExactly, SHARED_STEPS, MODULE_STEPS } =
  require('../scripts/packed-consumers/session-scenario.cjs') as {
    judgeSession: (report: Transcript) => { verdict: string; checks: { name: string; verdict: string; why?: string }[] };
    sessionParity: (left: Transcript, right: Transcript, steps?: string[]) => { equal: boolean; differences: any[] };
    landedExactly: (previewed: { content?: unknown } | undefined, landed: Buffer | null) => boolean | null;
    SHARED_STEPS: string[];
    MODULE_STEPS: string[];
  };

const BYTES = 'b'.repeat(64);
/** The sha256 of the saved workflow's bytes, as the walk records it. */
const SAVED = 'a'.repeat(64);
/** The Run a Session observed of the saved workflow, as `work.run` carries it. */
const OBSERVED = { current: true, workflow: 'compiled-workflow.nika', end: { end: 'succeeded' },
  trace: '.nika/traces/run.ndjson', execution: 'exe-1', workflow_sha256: SAVED, chain_head: 'h'.repeat(64), chain_len: 9 };
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
    saved_sha256: SAVED, run_output_before_run: false },
    { step: 'stop_idle', ...frame({ event: 7, op: 'stop', receipt: 'nothing_to_stop', seq: 3, waiting: 'free',
      candidate: null, saved: 'compiled-workflow.nika' }) },
    { step: 'run', ...frame({ event: 12, outcomes: ['run_requested', 'facts'], seq: 4, waiting: 'free', candidate: null,
      saved: 'compiled-workflow.nika' }) },
    { step: 'run_observed', deadline: false, busy: false, waiting: 'free',
      requested: { workflow: 'compiled-workflow.nika', inputs: [], world: {} }, run: OBSERVED,
      run_is_saved_workflow: true, run_ran_saved_bytes: true, run_succeeded: true,
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
    expect(verdictOf(judged, /wrote the copy/)).toBe('failed');
  });

  // Root review of 9649759 (P2): the file alone never proves the Run. Each mutation touches only
  // the observed Run (or the polling outcome); the rest of the walk, the output included, is green.
  const runOnly: [string, Record<string, unknown>, RegExp][] = [
    ['no observed Run', { run: null }, /observed the requested Run end/],
    ['a Run with no observed end', { run: { ...OBSERVED, end: null } }, /observed the requested Run end/],
    ['a failed Run', { run: { ...OBSERVED, end: { end: 'failed' } } }, /succeeded and wrote/],
    ['a paused Run', { run: { ...OBSERVED, end: { end: 'paused' } } }, /succeeded and wrote/],
    ['a Run of another workflow', { run: { ...OBSERVED, workflow: 'other.nika' } }, /ran the saved bytes/],
    ['a Run of other bytes', { run: { ...OBSERVED, workflow_sha256: 'd'.repeat(64) } }, /ran the saved bytes/],
    ['a Run kept from before the Save', { run: { ...OBSERVED, current: false } }, /ran the saved bytes/],
    ['a polling deadline reached', { deadline: true }, /observed the requested Run end/],
    ['a Run still under way', { busy: true }, /observed the requested Run end/],
  ];
  it.each(runOnly)('fails %s, whatever the project world shows', (_name, change, check) => {
    const judged = judgeSession(edit(walk('native'), 'run_observed', change));
    expect(verdictOf(judged, check)).toBe('failed');
    expect(judged.verdict).toBe('failed');
  });

  it('withholds every Run check when the Session started none or could not observe it', () => {
    for (const said of ['run_not_started', 'run_unobserved']) {
      const judged = judgeSession(edit(walk('http'), 'run', { outcomes: ['run_requested', said] }));
      for (const check of [/observed the requested Run end/, /ran the saved bytes/, /wrote the copy/]) {
        expect(verdictOf(judged, check)).toBe('not_exercised');
      }
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

describe('the saved bytes are compared with the previewed content, byte for byte', () => {
  // Root review of 9649759 (P1): `bytes` is a BLAKE3 witness; the exact bytes are `content`.
  const CONTENT = '# Copie\r\nnika: copy\r\n# « Relevé — semaine » ✓ 🦋\ttab\nfin sans retour';

  it('accepts exactly the previewed bytes, CRLF and multibyte text included', () => {
    expect(landedExactly({ content: CONTENT }, Buffer.from(CONTENT, 'utf8'))).toBe(true);
  });

  it('refuses one changed byte, a lost CR and a missing file', () => {
    const changed = Buffer.from(CONTENT, 'utf8');
    changed[changed.length - 1] ^= 0x01;
    expect(landedExactly({ content: CONTENT }, changed)).toBe(false);
    expect(landedExactly({ content: CONTENT }, Buffer.from(CONTENT.replaceAll('\r\n', '\n'), 'utf8'))).toBe(false);
    expect(landedExactly({ content: CONTENT }, null)).toBe(false);
  });

  it('leaves the bytes unverified when the engine projects no content, never a pass', () => {
    expect(landedExactly({}, Buffer.from(CONTENT, 'utf8'))).toBeNull();
    expect(landedExactly(undefined, Buffer.from(CONTENT, 'utf8'))).toBeNull();
    expect(landedExactly({ content: 42 }, Buffer.from('42'))).toBeNull();
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
