import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NikaProtocolError } from '../src/index.js';
import type { NikaSessionCallMark, NikaSessionEvent, NikaSessionToolMark } from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';

// Every model and tool call of a Session turn reaches the host (nika-session-host, "session call
// activity"): a model request's activity names its rank, role, requested model and state, and,
// when its producer reported them, when it left, how long it took and its tokens; a tool call
// names when it began and its reply's size. Neither carries a prompt, an answer or arguments, and
// a tool step's reply only once it failed. The marks are written here in the exact shapes the
// engine's own wire test asserts (`a_call_and_a_tool_name_their_time_and_size_only_when_known`),
// then read as a real 90d2472cd binary wrote them on both doors.

const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'cd'.repeat(16)}`;
const SECRET = 'sk-planted-secret-value-0123456789';
const activity = (body: Record<string, unknown>) => ({ contract: CONTRACT, session: SESSION, frame: 'activity',
  event: 3, command: 'c-1', phase: 'authoring', note: 'deepseek/deepseek-v4-pro · 250 ms', done: false, ...body });
const timedCall = () => ({ ordinal: 2, role: 'conversation', model: 'deepseek/deepseek-v4-pro', state: 'finished',
  at_ms: 1000, elapsed_ms: 250, input_tokens: 4570, output_tokens: 41 });

function refusal(value: unknown): NikaProtocolError {
  try {
    sessionFrame(value, 'http');
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

describe('a model request names its time and tokens, only when known', () => {
  it('types the call a model activity reports, as the engine writes it', () => {
    const value = activity({ call: timedCall() });
    const event = sessionFrame(value, 'native-process') as unknown as NikaSessionEvent;
    expect(event).toBe(value);
    const call: NikaSessionCallMark = event.call!;
    expect([call.ordinal, call.role, call.model, call.state]).toEqual([2, 'conversation', 'deepseek/deepseek-v4-pro', 'finished']);
    expect([call.at_ms, call.elapsed_ms, call.input_tokens, call.output_tokens]).toEqual([1000, 250, 4570, 41]);
  });

  it('carries a call that reported none of them, as an earlier engine writes it', () => {
    const bare = { ordinal: 1, role: 'conversation', model: 'deepseek/deepseek-v4-pro', state: 'started' };
    const call = (sessionFrame(activity({ call: bare }), 'http') as unknown as NikaSessionEvent).call!;
    expect([call.at_ms, call.elapsed_ms, call.input_tokens, call.output_tokens]).toEqual([undefined, undefined, undefined, undefined]);
  });

  const broken: [string, Record<string, unknown>, RegExp][] = [
    ['a rank that is not a count', { ...timedCall(), ordinal: -1 }, /activity\.call\.ordinal is not a count/],
    ['no rank', { ...timedCall(), ordinal: undefined }, /activity\.call\.ordinal is absent/],
    ['a model that is not text', { ...timedCall(), model: [SECRET] }, /activity\.call\.model is not text/],
    ['tokens as text', { ...timedCall(), input_tokens: SECRET }, /activity\.call\.input_tokens is not a count/],
    ['a time that is not a whole count', { ...timedCall(), at_ms: 1.5 }, /activity\.call\.at_ms is not a count/],
  ];
  it.each(broken)('refuses %s as a protocol fault naming its path, never its value', (_name, call, message) => {
    const error = refusal(JSON.parse(JSON.stringify(activity({ call }))));
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('a tool call names when it began and its reply size', () => {
  it('types them beside the step it observed', () => {
    const value = activity({ phase: 'checking', note: 'verify · 42 ms', done: true,
      tool: { call: 'toolu_1', name: 'verify', state: 'finished', elapsed_ms: 42, at_ms: 900, reply_bytes: 312 } });
    const tool: NikaSessionToolMark = (sessionFrame(value, 'http') as unknown as NikaSessionEvent).tool!;
    expect([tool.elapsed_ms, tool.at_ms, tool.reply_bytes]).toEqual([42, 900, 312]);
  });

  it('refuses a reply size that is not a count, naming its path and never its value', () => {
    const value = activity({ tool: { call: 'toolu_1', name: 'verify', state: 'finished', reply_bytes: SECRET } });
    const error = refusal(value);
    expect(error.message).toMatch(/activity\.tool\.reply_bytes is not a count/);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

// Each conversation led by a loopback author, a script on 127.0.0.1 that reports 1000 input and
// 100 output tokens for every request (see the fixture's README).
type Door = 'native' | 'http';
type Walk = 'steer' | 'models' | 'stop' | 'full';
const RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/session-host/90d2472cd/activity.json',
  import.meta.url)), 'utf8')) as Record<Door, Record<Walk, Record<string, any>[]>>;
const WALKS: Walk[] = ['steer', 'models', 'stop', 'full'];
const DOORS: [Door, 'native-process' | 'http'][] = [['native', 'native-process'], ['http', 'http']];
const CALL_MEMBERS = ['at_ms', 'elapsed_ms', 'input_tokens', 'model', 'ordinal', 'output_tokens', 'role', 'state'];
const TOOL_MEMBERS = ['at_ms', 'call', 'elapsed_ms', 'name', 'reply', 'reply_bytes', 'state'];
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const untimed = (frames: Record<string, any>[]) => frames.map((frame) => {
  const mark = { ...(frame.call ?? frame.tool) };
  delete mark.at_ms;
  delete mark.elapsed_ms;
  return { phase: frame.phase, done: frame.done, [frame.call ? 'call' : 'tool']: mark };
});

describe('the marks a real 90d2472cd binary wrote, on both doors', () => {
  it.each(DOORS)('decodes every recorded %s frame unchanged', (door, transport) => {
    for (const walk of WALKS) {
      expect(RECORDED[door][walk].length).toBeGreaterThan(0);
      for (const frame of RECORDED[door][walk]) {
        const raw = JSON.stringify(frame);
        expect(sessionFrame(frame, transport)).toBe(frame);
        expect(JSON.stringify(frame)).toBe(raw);
      }
    }
  });

  it.each(DOORS)('reads each %s model request started, then finished with tokens or cancelled', (door, transport) => {
    const calls = (walk: Walk) => RECORDED[door][walk].filter((frame) => frame.call)
      .map((frame) => (sessionFrame(frame, transport) as unknown as NikaSessionEvent).call!);
    const states = (walk: Walk) => calls(walk).map((call) => [call.ordinal, call.state]);
    expect(states('steer')).toEqual([1, 2, 3, 4].flatMap((n) => [[n, 'started'], [n, 'finished']]));
    expect(states('models')).toEqual([[1, 'started'], [1, 'finished']]);
    // A Stop while the request is held cancels it.
    expect(states('stop')).toEqual([[1, 'started'], [1, 'cancelled']]);
    expect(states('full')).toEqual([[1, 'started'], [1, 'cancelled']]);
    for (const call of WALKS.flatMap(calls)) {
      expect([call.role, call.model]).toEqual(['conversation', 'vllm/agent-seat']);
      expect(Object.keys(call).filter((key) => !CALL_MEMBERS.includes(key))).toEqual([]);
      expect(isCount(call.at_ms)).toBe(true);
      if (call.state === 'started') {
        expect([call.elapsed_ms, call.input_tokens, call.output_tokens]).toEqual([undefined, undefined, undefined]);
      }
      if (call.state !== 'started') expect(isCount(call.elapsed_ms)).toBe(true);
      // Tokens as the author reported them, and none for a request the Stop cancelled.
      if (call.state === 'finished') expect([call.input_tokens, call.output_tokens]).toEqual([1000, 100]);
      if (call.state === 'cancelled') expect([call.input_tokens, call.output_tokens]).toEqual([undefined, undefined]);
    }
  });

  it.each(DOORS)('reads each %s tool step with when it began, its reply size and why it failed', (door, transport) => {
    const tools = (walk: Walk) => RECORDED[door][walk].filter((frame) => frame.tool)
      .map((frame) => (sessionFrame(frame, transport) as unknown as NikaSessionEvent).tool!);
    const steps = (walk: Walk) => tools(walk).map((tool) => [tool.name, tool.state]);
    expect(steps('steer')).toEqual([['models', 'started'], ['models', 'failed'], ['language', 'started'],
      ['language', 'failed']]);
    expect(steps('models')).toEqual([['ask', 'started'], ['ask', 'finished']]);
    expect([...tools('stop'), ...tools('full')]).toEqual([]);
    const failed = tools('steer').filter((tool) => tool.state === 'failed');
    expect(failed.map((tool) => tool.reply)).toEqual(['no model role ``: run, author or decision',
      'no language topic ``: schema, catalog, examples or template']);
    for (const tool of failed) expect(tool.reply_bytes).toBe(Buffer.byteLength(tool.reply!));
    for (const tool of [...tools('steer'), ...tools('models')]) {
      expect(Object.keys(tool).filter((key) => !TOOL_MEMBERS.includes(key))).toEqual([]);
      expect(isCount(tool.at_ms)).toBe(true);
      if (tool.state === 'started') {
        expect([tool.elapsed_ms, tool.reply_bytes, tool.reply]).toEqual([undefined, undefined, undefined]);
      }
      if (tool.state !== 'started') expect([isCount(tool.elapsed_ms), isCount(tool.reply_bytes)]).toEqual([true, true]);
      if (tool.state !== 'failed') expect(tool.reply).toBeUndefined();
    }
  });

  it('finds both doors writing the same marks apart from their times', () => {
    for (const walk of WALKS) expect(untimed(RECORDED.http[walk])).toEqual(untimed(RECORDED.native[walk]));
  });
});
