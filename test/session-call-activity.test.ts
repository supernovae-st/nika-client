import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NikaProtocolError } from '../src/index.js';
import type { NikaSessionCallMark, NikaSessionEvent, NikaSessionToolMark } from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';

// Every model and tool call of a Session turn reaches the host (nika-session-host, "session call
// activity"): a model request's activity names its rank, role, requested model and state, and,
// when its producer reported them, when it left, how long it took and its tokens; a tool call
// names when it began and its reply's size. Neither carries a prompt, an answer, arguments or a
// reply. The marks are written here in the exact shapes the engine's own wire test asserts
// (`a_call_and_a_tool_name_their_time_and_size_only_when_known`).

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
