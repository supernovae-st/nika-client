import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NikaProtocolError } from '../src/index.js';
import type { NikaSessionEvent, NikaSessionGate, NikaSessionResult, NikaSessionToolMark } from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';

// Two additive members of nika/session-host@1 written for the Session writer (ADR-148 points 11 and
// 12, lanes/sdk/session-patches; engine pending): a failed tool step's activity says why (`tool.reply`,
// the tool's reply as a host may show it), and a gate outcome carries the values its message shows
// (`values`) and names the keys it withheld (`withheld`). The frames are written here in the exact
// shapes the patched engine's own wire tests assert; no engine writes them yet.

const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'ef'.repeat(16)}`;
const SECRET = 'sk-planted-secret-value-0123456789';
const frame = (body: Record<string, unknown>) => ({ contract: CONTRACT, session: SESSION, ...body });
const work = {
  contract: 'nika/session-work@0', root: '/srv/project', request: { goal: null, decisions: [], unresolved: [] },
  authoring: null, waiting: { kind: 'free' }, candidate: null, saved: null, requested: null, run: null,
  rail: { draft: 'pending', saved: 'pending', checked: 'pending', active: 'pending', run: 'pending' },
};
const snapshot = { snapshot: `snp_${'0'.repeat(31)}2`, seq: 2, busy: null, work };
const failedStep = () => frame({ frame: 'activity', event: 5, command: 'c-1', phase: 'authoring',
  note: 'compose failed · 9 ms', done: true,
  tool: { call: 'toolu_c', name: 'compose', state: 'failed', elapsed_ms: 9,
    reply: 'no block serves `feeds`: the key [redacted] expired' } });
const gate = (extra: Record<string, unknown> = {}) => ({ kind: 'gate', trace: '.nika/traces/t.ndjson',
  task: 'approve', text: 'the run paused at `approve` and asks you:\n  Release #7 to finance@example.test?',
  ...extra });
const paused = (outcome: Record<string, unknown>) => frame({ frame: 'result', event: 6, command: 'c-2', op: 'submit',
  replayed: false, outcomes: [outcome], snapshot });
const SHOWN = { sno: 7, to: 'finance@example.test', item: 'Laptop batch', description: 'Q4 refresh',
  requested_by: 'ana', amount: 1250.5 };

function refusal(value: unknown): NikaProtocolError {
  try {
    sessionFrame(value, 'http');
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

describe('a failed tool step says why (ADR-148 point 11)', () => {
  it('types the reply a failed step carries, and none on a step that did not fail', () => {
    const value = failedStep();
    const event = sessionFrame(value, 'native-process') as unknown as NikaSessionEvent;
    expect(event).toBe(value);
    const tool: NikaSessionToolMark = event.tool!;
    expect([tool.state, tool.reply]).toEqual(['failed', 'no block serves `feeds`: the key [redacted] expired']);
    const finished = frame({ frame: 'activity', event: 4, command: 'c-1', phase: 'checking', note: 'verify · 42 ms',
      done: true, tool: { call: 'toolu_v', name: 'verify', state: 'finished', elapsed_ms: 42 } });
    expect((sessionFrame(finished, 'http') as unknown as NikaSessionEvent).tool!.reply).toBeUndefined();
  });

  it('refuses a reply that is not text as a protocol fault naming its path, never its value', () => {
    const value = failedStep() as Record<string, any>;
    value.tool.reply = { said: SECRET };
    const error = refusal(value);
    expect(error.message).toMatch(/activity\.tool\.reply is not text/);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('a gate shows its values (ADR-148 point 12)', () => {
  it('types the values the message shows and the keys withheld, as the pause wrote them', () => {
    const value = paused(gate({ values: SHOWN, withheld: { credential: 'secret', signature: 'secret' } }));
    const typed = sessionFrame(value, 'http') as unknown as NikaSessionResult;
    expect(typed).toBe(value);
    const outcome = typed.outcomes![0] as NikaSessionGate;
    expect([outcome.kind, outcome.task]).toEqual(['gate', 'approve']);
    expect(outcome.values).toEqual(SHOWN);
    expect(outcome.withheld).toEqual({ credential: 'secret', signature: 'secret' });
    // Each value shown is in the gate's words as the message renders it.
    for (const shown of ['7', 'finance@example.test']) expect(outcome.text).toContain(shown);
  });

  it('carries a gate whose pause wrote none, as an older engine writes it', () => {
    const outcome = (sessionFrame(paused(gate()), 'native-process') as unknown as NikaSessionResult)
      .outcomes![0] as NikaSessionGate;
    expect([outcome.values, outcome.withheld]).toEqual([undefined, undefined]);
  });

  const broken: [string, Record<string, unknown>, RegExp][] = [
    ['values as a list', gate({ values: [SECRET] }), /outcomes\[0\]\.values is not an object/],
    ['a withheld reason as a number', gate({ withheld: { credential: 1 } }), /outcomes\[0\]\.withheld is not an object of words/],
    ['a gate without its task', { ...gate(), task: undefined }, /outcomes\[0\]\.task is absent/],
  ];
  it.each(broken)('refuses %s as a protocol fault naming its path, never its value', (_name, outcome, message) => {
    const error = refusal(JSON.parse(JSON.stringify(paused(outcome))));
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});
