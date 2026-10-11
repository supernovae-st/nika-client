import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaConfigurationError, NikaProtocolError, NikaSessionRefusedError } from '../src/index.js';
import type {
  NikaAuthoringSession,
  NikaSessionEvent,
  NikaSessionModelFacts,
  NikaSessionQueuedLine,
  NikaSessionResult,
  NikaSessionStopped,
  NikaSessionToolMark,
  NikaSessionWork,
} from '../src/index.js';
import { sessionCommand, sessionFrame } from '../src/lib/session-host.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The Session doors (nika/session-host@1, additive; engine main from a3017c495, first written on the
// doors branch at f8da375e7): `steer` and `follow_up` queue a line for the conversation's run under
// way, a stopped conversation turn says how far the Stop reached and what it returned, an activity
// names the tool step it observed, and an offered model carries this machine's facts. The wire
// examples are the engine's own tests at f8da375e7 (main a3017c495 writes the same wire), then the
// frames a real a3017c495 binary wrote on both doors; the native door runs the fake host with
// NIKA_FAKE_SESSION_DOORS, the HTTP door a mocked fetch. No network, no model. Each door here
// advertises `sessionSteering` (engine 0e4e1c74f), the word without which the handle sends no such
// line at all (test/session-steering.test.ts).

const DOORS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/session-host/doors-f8da375e7.json',
  import.meta.url)), 'utf8')) as Record<string, any>;
type Recorded = { step: string; frame?: Record<string, any>; snapshot?: Record<string, any> };
type RecordedWalk = { steps: Recorded[]; activity?: Record<string, any>[] };
// Each conversation led by a loopback author, a script on 127.0.0.1 (see the fixture's README).
const RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/session-host/a3017c495/doors.json',
  import.meta.url)), 'utf8')) as Record<'native' | 'http', Record<'steer' | 'models' | 'stop' | 'full', RecordedWalk>>;
const SESSION_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session.mjs', import.meta.url));
const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'ab'.repeat(16)}`;
const SECRET = 'sk-planted-secret-value-0123456789';
const clone = <T>(value: T): T => structuredClone(value);

function work(extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    contract: 'nika/session-work@0', root: '/srv/project', request: { goal: null, decisions: [], unresolved: [] },
    authoring: null, waiting: { kind: 'free' }, candidate: null, saved: null, requested: null, run: null,
    rail: { draft: 'pending', saved: 'pending', checked: 'pending', active: 'pending', run: 'pending' },
    ...extra,
  };
}
const snapshot = (seq: number, busy: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) => ({
  snapshot: `snp_${String(seq).padStart(32, '0')}`, seq, busy, work: work(extra) });
const frame = (body: Record<string, unknown>) => ({ contract: CONTRACT, session: SESSION, ...body });
const busyOn = (queued?: unknown[]) => ({ command: 'c-1', phase: 'preparing', stop_requested: false,
  ...(queued === undefined ? {} : { queued }) });

function refusal(value: unknown, transport: 'http' | 'native-process' = 'http'): NikaProtocolError {
  try {
    sessionFrame(value, transport);
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('the Session doors on the wire', () => {
  it.each(['steer', 'follow_up'] as const)('encodes a %s exactly as the engine reads one: identity and line', (op) => {
    const command = sessionCommand(op, { command: 'c-7' }, { line: 'use b instead' });
    expect(command.body).toBe(DOORS.commands[op]);
    expect([command.op, command.command, command.line]).toEqual([op, 'c-7', 'use b instead']);
    // The SDK's identity rule holds for these commands as for every other.
    expect(() => sessionCommand(op, { command: 'use b instead' }, { line: 'x' })).toThrow(NikaConfigurationError);
  });

  it('types a queued receipt, the queue a busy snapshot shows and the lines the work keeps', () => {
    const queued = clone(DOORS.queued);
    const result = frame({ frame: 'result', event: 7, command: 's-1', op: 'steer', replayed: false, receipt: 'queued',
      queued, target: 'c-1', snapshot: snapshot(3, busyOn([clone(DOORS.queued)])) });
    const typed = sessionFrame(result, 'http') as unknown as NikaSessionResult;
    expect(typed).toBe(result);
    const line: NikaSessionQueuedLine = typed.queued!;
    expect(line).toEqual({ id: 'l1', mode: 'steer', line: 'use b instead', state: 'waiting' });
    expect(typed.snapshot.busy!.queued!.map((entry) => entry.id)).toEqual(['l1']);
    const entered = { ...clone(DOORS.queued), state: 'entered', cite: 'u2' };
    const kept = sessionFrame(frame({ frame: 'snapshot', snapshot: snapshot(4, null, { queued: [entered] }) }), 'http');
    expect(((kept.snapshot as { work: NikaSessionWork }).work.queued as NikaSessionQueuedLine[])[0]!.cite).toBe('u2');
  });

  it.each(['not_reading', 'nothing_to_steer', 'blank', 'full', 'a_word_this_sdk_has_not_met'])(
    'carries the receipt %s as the engine writes it', (receipt) => {
      const result = frame({ frame: 'result', event: 8, command: 'f-1', op: 'follow_up', replayed: false, receipt,
        target: receipt === 'nothing_to_steer' ? null : 'c-1', snapshot: snapshot(3, busyOn()) });
      expect((sessionFrame(result, 'native-process') as unknown as NikaSessionResult).receipt).toBe(receipt);
    });

  it('types a stopped conversation turn: how far the Stop reached, the lines returned, the draft kept', () => {
    const stopped = clone(DOORS.stopped);
    const result = frame({ frame: 'result', event: 9, command: 'c-1', op: 'submit', replayed: false,
      outcomes: [stopped], snapshot: snapshot(5) });
    const outcome = (sessionFrame(result, 'http') as unknown as NikaSessionResult).outcomes![0] as NikaSessionStopped;
    expect(outcome).toBe(stopped);
    expect([outcome.reach, outcome.candidate, outcome.unsent![0]!.state]).toEqual(['agent_cancelled', 2, 'returned']);
    expect(outcome.text).toContain('« and c »');
    // Between steps, nothing returned, no draft named: the shorter shape.
    const quiet = clone(DOORS.stopped_between_steps);
    expect(sessionFrame(frame({ frame: 'result', event: 10, command: 'c-2', op: 'submit', replayed: false,
      outcomes: [quiet], snapshot: snapshot(6) }), 'http')).toMatchObject({ outcomes: [quiet] });
  });

  it('types the tool step an activity observed, never its arguments', () => {
    const activity = frame({ frame: 'activity', event: 4, command: 'c-1', ...clone(DOORS.activity) });
    const event = sessionFrame(activity, 'native-process') as unknown as NikaSessionEvent;
    const tool: NikaSessionToolMark = event.tool!;
    expect(tool).toEqual({ call: 'toolu_1', name: 'verify', state: 'finished', elapsed_ms: 42 });
    // A step still under way has no time yet; an activity without a tool step carries none.
    const started = frame({ frame: 'activity', event: 3, command: 'c-1', phase: 'checking', note: 'verify', done: false,
      tool: { call: 'toolu_1', name: 'verify', state: 'started' } });
    expect((sessionFrame(started, 'http') as unknown as NikaSessionEvent).tool!.elapsed_ms).toBeUndefined();
    expect('tool' in sessionFrame(frame({ frame: 'activity', event: 2, command: 'c-1', phase: 'authoring' }), 'http'))
      .toBe(false);
  });

  it('types the facts this machine states for an offered model, and none for one it does not know', () => {
    const question = { id: 'witness-run', key: 'run_model', question: 'Quel modèle ?', state: 'open',
      options: [{ key: 'chat', label: 'DeepSeek', recommended: true, values: [clone(DOORS.offered_model)] },
        { key: 'imaginary', label: 'Imaginary', recommended: false, values: [clone(DOORS.offered_unknown_model)] }],
      free_text: false, multi_select: false };
    const typed = (sessionFrame(frame({ frame: 'snapshot', snapshot: snapshot(2, null, { questions: [question] }) }),
      'http').snapshot as { work: NikaSessionWork }).work;
    const options = typed.questions![0]!.options;
    const facts: NikaSessionModelFacts = options[0]!.values[0]!.choice!;
    expect(facts).toEqual(DOORS.offered_model.choice);
    expect(options[1]!.values[0]!.choice).toBeUndefined();
    // An unknown price is absent, never zero.
    const unpriced = { ...clone(DOORS.offered_model), choice: clone(DOORS.unpriced_facts) };
    question.options[0]!.values = [unpriced];
    const plain = (sessionFrame(frame({ frame: 'snapshot', snapshot: snapshot(2, null, { questions: [question] }) }),
      'http').snapshot as { work: NikaSessionWork }).work;
    expect('output_usd_per_million' in plain.questions![0]!.options[0]!.values[0]!.choice!).toBe(false);
  });

  const queuedResult = (mutate: (body: Record<string, any>) => void) => {
    const body = frame({ frame: 'result', event: 7, command: 's-1', op: 'steer', replayed: false, receipt: 'queued',
      queued: clone(DOORS.queued), target: 'c-1', snapshot: snapshot(3, busyOn([clone(DOORS.queued)])) }) as any;
    mutate(body);
    return body;
  };
  const malformed: [string, () => unknown, RegExp][] = [
    ['a queued line as text', () => queuedResult((b) => { b.queued = 'l1'; }), /result\.queued is not an object/],
    ['a queued line without its identity', () => queuedResult((b) => { delete b.queued.id; }),
      /result\.queued\.id is absent/],
    ['an entered line without its citation', () => queuedResult((b) => { b.queued.state = 'entered'; }),
      /result\.queued\.cite is absent/],
    ['a busy queue as an object', () => queuedResult((b) => { b.snapshot.busy.queued = {}; }),
      /busy\.queued is not a list/],
    ['a busy queued line with its mode as a number', () => queuedResult((b) => { b.snapshot.busy.queued[0].mode = 1; }),
      /busy\.queued\[0\]\.mode is not text/],
    ['a stopped turn without its reach', () => frame({ frame: 'result', event: 9, command: 'c-1', op: 'submit',
      replayed: false, outcomes: [{ ...clone(DOORS.stopped), reach: undefined }], snapshot: snapshot(5) }),
    /result\.outcomes\[0\]\.reach is absent/],
    ['a draft revision as text', () => frame({ frame: 'result', event: 9, command: 'c-1', op: 'submit',
      replayed: false, outcomes: [{ ...clone(DOORS.stopped), candidate: '2' }], snapshot: snapshot(5) }),
    /result\.outcomes\[0\]\.candidate is not a count/],
    ['returned lines as an object', () => frame({ frame: 'result', event: 9, command: 'c-1', op: 'submit',
      replayed: false, outcomes: [{ ...clone(DOORS.stopped), unsent: { line: SECRET } }], snapshot: snapshot(5) }),
    /result\.outcomes\[0\]\.unsent is not a list/],
    ['a tool step without its name', () => frame({ frame: 'activity', event: 4, command: 'c-1',
      tool: { call: 'toolu_1', state: 'started' } }), /activity\.tool\.name is absent/],
    ['a negative tool time', () => frame({ frame: 'activity', event: 4, command: 'c-1',
      tool: { ...clone(DOORS.activity.tool), elapsed_ms: -1 } }), /activity\.tool\.elapsed_ms is not a count/],
    ['work lines as text', () => frame({ frame: 'snapshot', snapshot: snapshot(4, null, { queued: SECRET }) }),
      /work\.queued is not a list/],
    ['model facts without their route', () => frame({ frame: 'snapshot', snapshot: snapshot(2, null, { questions: [{
      id: 'w', key: 'run_model', question: 'q', state: 'open', free_text: false, multi_select: false,
      options: [{ key: 'k', label: 'l', recommended: true, values: [{ ...clone(DOORS.offered_model),
        choice: { ...clone(DOORS.offered_model.choice), via: undefined } }] }] }] }) }),
    /work\.questions\[0\]\.options\[0\]\.values\[0\]\.choice\.via is absent/],
    ['a price written as text', () => frame({ frame: 'snapshot', snapshot: snapshot(2, null, { questions: [{
      id: 'w', key: 'run_model', question: 'q', state: 'open', free_text: false, multi_select: false,
      options: [{ key: 'k', label: 'l', recommended: true, values: [{ ...clone(DOORS.offered_model),
        choice: { ...clone(DOORS.offered_model.choice), output_usd_per_million: '1.1' } }] }] }] }) }),
    /work\.questions\[0\]\.options\[0\]\.values\[0\]\.choice\.output_usd_per_million is not a price/],
  ];
  it.each(malformed)('refuses %s as a protocol fault naming its path, never its value', (_name, build, message) => {
    const body = JSON.parse(JSON.stringify(build()));
    const error = refusal(body);
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('the Session doors over the native door', () => {
  const opened: NikaAuthoringSession[] = [];
  /** `doors`: the doors and their word; `claimed`: the word without the doors (a host breaking its word). */
  async function open(host: 'doors' | 'claimed' = 'doors'): Promise<NikaAuthoringSession> {
    if (host === 'doors') process.env.NIKA_FAKE_SESSION_DOORS = '1';
    else process.env.NIKA_FAKE_SESSION_STEERING = '1';
    const session = await new Nika({ bin: SESSION_ENGINE }).openSession();
    opened.push(session);
    return session;
  }
  afterEach(async () => {
    for (const session of opened.splice(0)) await session.close().catch(() => {});
    delete process.env.NIKA_FAKE_SESSION_DOORS;
    delete process.env.NIKA_FAKE_SESSION_STEERING;
  });
  /** Until the turn under way is the one `command` names. */
  async function underway(session: NikaAuthoringSession, command: string): Promise<void> {
    for (const until = Date.now() + 5000; Date.now() < until;) {
      if ((await session.snapshot()).busy?.command === command) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`${command} never ran`);
  }

  it('queues lines for the conversation\'s run under way and tells what became of each', async () => {
    const session = await open();
    const turn = session.submit(session.opened!.snapshot, 'slow digest of the news', { command: 'c-1' });
    await underway(session, 'c-1');
    const steered = await session.steer('use b instead', { command: 's-1' });
    expect([steered.op, steered.receipt, steered.target]).toEqual(['steer', 'queued', 'c-1']);
    expect(steered.queued).toEqual({ id: 'l1', mode: 'steer', line: 'use b instead', state: 'waiting' });
    const followed = await session.followUp('and c', { command: 'f-1' });
    expect([followed.op, followed.queued!.id, followed.queued!.mode]).toEqual(['follow_up', 'l2', 'follow_up']);
    expect((await session.steer('   ', { command: 's-2' })).receipt).toBe('blank');
    expect((await session.snapshot()).busy!.queued!.map((entry) => entry.id)).toEqual(['l1', 'l2']);
    const settled = await turn;
    expect(settled.snapshot.busy).toBeNull();
    expect(settled.snapshot.work.queued!.map((entry) => [entry.id, entry.state, entry.cite]))
      .toEqual([['l1', 'entered', 'u2'], ['l2', 'entered', 'u3']]);
  });

  it('answers nothing_to_steer with no turn, replays its receipt, and binds the identity to its bytes', async () => {
    const session = await open();
    const first = await session.steer('use b instead', { command: 's-1' });
    expect([first.receipt, first.target, first.replayed]).toEqual(['nothing_to_steer', null, false]);
    const again = await session.steer('use b instead', { command: 's-1' });
    expect([again.receipt, again.replayed, again.event]).toEqual(['nothing_to_steer', true, first.event]);
    // The same identity with other bytes is refused on this handle before anything is written.
    const other = await failure(session.followUp('use b instead', { command: 's-1' }));
    expect(other).toBeInstanceOf(NikaConfigurationError);
  });

  it('returns the queued lines unsent when the person stops the conversation\'s turn', async () => {
    const session = await open();
    const turn = session.submit(session.opened!.snapshot, 'slow digest of the news', { command: 'c-1' });
    await underway(session, 'c-1');
    await session.followUp('then c', { command: 'f-1' });
    expect((await session.stop({ command: 'x-1' })).receipt).toBe('stop_requested');
    const settled = await turn;
    const stopped = settled.outcomes![0] as NikaSessionStopped;
    expect([stopped.kind, stopped.reach, stopped.unsent!.map((entry) => [entry.id, entry.state])])
      .toEqual(['stopped', 'between_steps', [['l1', 'returned']]]);
    expect(stopped.text).toContain('not sent: « then c »');
    expect(settled.snapshot.work.queued![0]!.state).toBe('returned');
  });

  it('shows the tool steps of the conversation\'s run in its events', async () => {
    const session = await open();
    await session.submit(session.opened!.snapshot, 'slow digest of the news', { command: 'c-1' });
    const tools: NikaSessionToolMark[] = [];
    for await (const event of session.events({ signal: AbortSignal.timeout(2000) })) {
      if (event.tool) tools.push(event.tool);
      if (event.frame === 'result') break;
    }
    expect(tools.map((tool) => [tool.state, tool.elapsed_ms ?? null])).toEqual([['started', null], ['finished', 42]]);
  });

  // A host whose identity claims `sessionSteering` without the doors refuses the line it cannot parse
  // naming no command, as one without the doors does (machine.rs at ad70c9aa7): the refusal is still
  // the steer's, in line order, and the Session goes on.
  it('takes a host\'s refusal naming no command as its line\'s, in write order, and the Session goes on', async () => {
    const session = await open('claimed');
    const reading = session.snapshot();
    const error = await failure(session.steer('use b instead', { command: 's-1' }));
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'malformed', line: 'use b instead' });
    expect(error.message).toContain('unknown op `steer`');
    expect((await reading).snapshot).toMatch(/^snp_/);
    // Written before a read, the line's refusal still answers the line, and the read its reply.
    const refused = failure(session.followUp('and c', { command: 'f-1' }));
    const after = session.snapshot();
    expect(await refused).toMatchObject({ code: 'malformed', line: 'and c' });
    expect((await after).busy).toBeNull();
    // The host recorded nothing for it: the identity is free for another command.
    expect((await session.submit(session.opened!.snapshot, 'hello', { command: 's-1' })).op).toBe('submit');
  });
});

describe('the Session doors over HTTP', () => {
  function server(answer: (body: Record<string, any>) => Response) {
    const calls: { method: string; path: string; body: string | null }[] = [];
    const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const { pathname } = new URL(String(url));
      const method = init.method ?? 'GET';
      calls.push({ method, path: pathname, body: (init.body as string) ?? null });
      if (pathname === '/health') {
        return healthResponse({ engineVersion: '0.123.0', supportedCapabilities: ['check', 'executionSnapshot',
          'eventStream', 'cancel', 'jobInputs', 'compile', 'sessionHost', 'sessionSteering'] });
      }
      if (method === 'POST' && pathname === '/v1/sessions') {
        return jsonResponse(frame({ frame: 'opened', event: 1, snapshot: snapshot(1), notices: [] }), 201);
      }
      if (method === 'POST' && pathname === `/v1/sessions/${SESSION}/commands`) {
        return answer(JSON.parse(String(init.body)));
      }
      throw new Error(`unexpected ${method} ${pathname}`);
    });
    return { client: new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch }),
      calls };
  }

  it('posts a steer and a follow-up to the command route with the engine\'s own bytes', async () => {
    const { client, calls } = server((body) => jsonResponse(frame({ frame: 'result', event: 2, command: body.command,
      op: body.op, replayed: false, receipt: 'queued', queued: { ...clone(DOORS.queued), mode: body.op },
      target: 'c-1', snapshot: snapshot(2, busyOn([clone(DOORS.queued)])) })));
    const session = await client.openSession();
    const steered = await session.steer('use b instead', { command: 'c-7' });
    expect([steered.receipt, steered.target, steered.queued!.id]).toEqual(['queued', 'c-1', 'l1']);
    const followed = await session.followUp('use b instead', { command: 'c-8' });
    expect(followed.queued!.mode).toBe('follow_up');
    const posted = calls.filter((call) => call.path.endsWith('/commands')).map((call) => call.body);
    expect(posted).toEqual([DOORS.commands.steer, DOORS.commands.follow_up.replace('"c-7"', '"c-8"')]);
  });

  // A resident refuses a line it cannot parse `malformed`, naming the identity it carries (http.rs at
  // 0e4e1c74f): the refusal answers that line's request, the line kept.
  it('carries the host\'s refusal of a line, naming its command and keeping the line', async () => {
    const { client } = server((body) => jsonResponse(frame({ frame: 'refused', session: SESSION, error: 'malformed',
      message: 'the line is not one this host reads', command: body.command }), 400));
    const session = await client.openSession();
    const error = await failure(session.steer('use b instead', { command: 'c-7' }));
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'malformed', status: 400, command: 'c-7', line: 'use b instead' });
    expect((error as NikaSessionRefusedError).message).toContain('the line is not one this host reads');
  });
});

describe('the Session doors a real a3017c495 binary wrote, on both doors', () => {
  const doors = [['native', 'native-process'], ['http', 'http']] as const;
  type Transport = (typeof doors)[number][1];
  const frameOf = (walk: RecordedWalk, step: string): Record<string, any> =>
    walk.steps.find((entry) => entry.step === step)!.frame!;
  const result = (walk: RecordedWalk, step: string, transport: Transport): NikaSessionResult =>
    sessionFrame(frameOf(walk, step), transport) as unknown as NikaSessionResult;

  it.each(doors)('decodes every frame the %s door wrote, unchanged', (door, transport) => {
    const recorded = RECORDED[door];
    expect(Object.fromEntries(Object.entries(recorded).map(([walk, { steps }]) =>
      [walk, steps.map((entry) => entry.step)]))).toEqual({
      steer: ['steer_without_turn', 'steer', 'follow_up', 'blank', 'busy', 'settled', 'steer_after_turn'],
      models: ['settled'], stop: ['follow_up', 'stop', 'settled'], full: ['steer_32', 'steer_33'],
    });
    for (const walk of Object.values(recorded)) {
      for (const value of [...walk.steps.flatMap((entry) => entry.frame ?? []), ...(walk.activity ?? [])]) {
        const raw = JSON.stringify(value);
        expect(sessionFrame(value, transport)).toBe(value);
        expect(JSON.stringify(value)).toBe(raw);
      }
    }
    // A snapshot read returns the snapshot alone: decoded here in the frame that carried it.
    const read = recorded.steer.steps.find((entry) => entry.step === 'busy')!.snapshot!;
    const carried = { contract: CONTRACT, frame: 'snapshot', session: frameOf(recorded.steer, 'steer').session,
      snapshot: read };
    expect(sessionFrame(carried, transport).snapshot).toBe(read);
  });

  it.each(doors)('answers each line with its receipt, bound to the turn it found (%s)', (door, transport) => {
    const { steer, full } = RECORDED[door];
    const before = result(steer, 'steer_without_turn', transport);
    expect([before.op, before.receipt, before.target, before.queued]).toEqual(['steer', 'nothing_to_steer', null,
      undefined]);
    const steered = result(steer, 'steer', transport);
    expect([steered.receipt, steered.target]).toEqual(['queued', 'c-1']);
    const line: NikaSessionQueuedLine = steered.queued!;
    expect(line).toEqual({ id: 'l1', mode: 'steer', line: 'use b instead', state: 'waiting' });
    expect(result(steer, 'follow_up', transport).queued).toEqual({ id: 'l2', mode: 'follow_up', line: 'and c',
      state: 'waiting' });
    const blank = result(steer, 'blank', transport);
    expect([blank.receipt, blank.target, blank.queued]).toEqual(['blank', 'c-1', undefined]);
    // While the run reads them, the busy turn shows both lines waiting.
    const busy = steer.steps.find((entry) => entry.step === 'busy')!.snapshot!.busy;
    expect([busy.command, busy.queued.map((entry: NikaSessionQueuedLine) => [entry.id, entry.state])])
      .toEqual(['c-1', [['l1', 'waiting'], ['l2', 'waiting']]]);
    // Settled: the steering line entered as the person's next cited line, the follow-up after it.
    const settled = result(steer, 'settled', transport);
    expect([settled.op, settled.outcomes!.map((outcome) => outcome.kind), settled.snapshot.busy])
      .toEqual(['submit', ['reply'], null]);
    expect(settled.snapshot.work.queued!.map((entry) => [entry.id, entry.mode, entry.state, entry.cite]))
      .toEqual([['l1', 'steer', 'entered', 'u2'], ['l2', 'follow_up', 'entered', 'u3']]);
    expect(result(steer, 'steer_after_turn', transport)).toMatchObject({ receipt: 'nothing_to_steer', target: null });
    // A run takes 32 lines at this engine: the 32nd is queued, the 33rd refused `full`.
    expect(result(full, 'steer_32', transport).queued).toMatchObject({ id: 'l32', mode: 'steer', state: 'waiting' });
    const refused = result(full, 'steer_33', transport);
    expect([refused.receipt, refused.target, refused.queued, refused.snapshot.busy!.queued!.length])
      .toEqual(['full', 'c-1', undefined, 32]);
  });

  it.each(doors)('settles a stopped conversation turn with the line it returned unsent (%s)', (door, transport) => {
    const { stop } = RECORDED[door];
    expect(result(stop, 'follow_up', transport).queued).toEqual({ id: 'l1', mode: 'follow_up', line: 'then stop',
      state: 'waiting' });
    expect(result(stop, 'stop', transport)).toMatchObject({ op: 'stop', receipt: 'stop_requested', target: 'c-1' });
    const settled = result(stop, 'settled', transport);
    expect(settled.outcomes).toHaveLength(1);
    const stopped = settled.outcomes![0] as NikaSessionStopped;
    expect([stopped.kind, stopped.reach, stopped.candidate]).toEqual(['stopped', 'request_dropped', undefined]);
    expect(stopped.unsent).toEqual([{ id: 'l1', mode: 'follow_up', line: 'then stop', state: 'returned' }]);
    expect(stopped.text).toContain('a request already sent may still be billed');
    expect(stopped.text).toContain('not sent: « then stop »');
    expect(settled.snapshot.work.queued!.map((entry) => [entry.id, entry.state])).toEqual([['l1', 'returned']]);
  });

  it.each(doors)('types the tool steps the run observed, never their arguments (%s)', (door, transport) => {
    const marks = (walk: RecordedWalk): NikaSessionToolMark[] =>
      walk.activity!.map((value) => (sessionFrame(value, transport) as unknown as NikaSessionEvent).tool!);
    const failed = marks(RECORDED[door].steer);
    expect(failed.map((tool) => [tool.name, tool.state])).toEqual([['models', 'started'], ['models', 'failed']]);
    const asked = marks(RECORDED[door].models);
    expect(asked.map((tool) => [tool.name, tool.state])).toEqual([['ask', 'started'], ['ask', 'finished']]);
    for (const [started, ended] of [failed, asked]) {
      expect(ended!.call).toBe(started!.call);
      expect(started!.elapsed_ms).toBeUndefined();
      expect(Number.isInteger(ended!.elapsed_ms)).toBe(true);
      expect(ended!.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
    for (const tool of [...failed, ...asked]) {
      expect(['call', 'elapsed_ms', 'name', 'state']).toEqual(expect.arrayContaining(Object.keys(tool)));
    }
  });

  it.each(doors)('types the facts this machine states for an offered run model, none invented (%s)', (door,
    transport) => {
    const settled = result(RECORDED[door].models, 'settled', transport);
    expect(settled.outcomes).toEqual([{ kind: 'question', key: 'model', text: 'Which model runs the workflow?' }]);
    const [question] = settled.snapshot.work.questions!;
    expect([question!.role, question!.state]).toEqual(['run_model', 'open']);
    const offered = question!.options.map((option) => [option.key, option.values[0]!.value, option.values[0]!.choice]);
    expect(offered.map(([key, value]) => [key, value])).toEqual([['catalogue', 'deepseek/deepseek-v4-pro'],
      ['loopback', 'vllm/agent-seat'], ['invented', 'acme/imaginary-1']]);
    // A catalogue route without its key here: its facts, not configured, with the listed price.
    const facts = offered[0]![2] as NikaSessionModelFacts;
    expect(facts).toMatchObject({ role: 'run', model: 'deepseek/deepseek-v4-pro', via: 'deepseek', class: 'api',
      configured: false, billing: 'api_metered' });
    expect(facts.output_usd_per_million).toBeGreaterThan(0);
    // Neither the loopback route's model nor an invented one is offered here for a run: no facts.
    expect([offered[1]![2], offered[2]![2]]).toEqual([undefined, undefined]);
  });

  it('writes the same frames on both doors, apart from identities, the project root and timings', () => {
    const plain = (door: 'native' | 'http') => JSON.stringify(RECORDED[door])
      .replace(/ses_[0-9a-f]{32}/g, 'ses').replace(/snp_[0-9a-f]{32}/g, 'snp')
      .replace(/\/private\/tmp\/nika-doors-(?:native|http)-[a-z]+-[A-Za-z0-9]{6}/g, 'root')
      .replace(/"elapsed_ms":\d+/g, '"elapsed_ms":0').replace(/ · \d+ ms"/g, ' · ms"');
    expect(plain('http')).toBe(plain('native'));
  });
});
