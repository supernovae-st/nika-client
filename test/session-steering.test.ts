import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaSessionRefusedError,
} from '../src/index.js';
import type { NikaAuthoringSession, NikaSessionResult } from '../src/index.js';
import { sessionFrame, sessionRefusal } from '../src/lib/session-host.js';
import { jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// What engine main 0e4e1c74f (nika#1784) adds to the Session host, read from frames a real
// 0e4e1c74f binary wrote (test/fixtures/session-host/0e4e1c74f/README.md): both doors advertise
// `sessionSteering`, and the handle sends `steer` and `follow_up` only to a door whose identity did
// (a3017c495 takes the doors but does not say so: refused here, typed, nothing written); a line the
// host cannot parse is refused `malformed` naming the valid identity it carries; and a Stop over
// Serve reaches the Run under way as it does natively. No network, no model.

type Step = { step: string; sent?: string; status?: number; frame?: Record<string, any>; snapshot?: Record<string, any> };
const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(
  `./fixtures/session-host/0e4e1c74f/${name}`, import.meta.url)), 'utf8'));
const IDENTITIES = fixture('identities.json') as Record<'0e4e1c74f' | 'a3017c495', Record<string, Record<string, any>>>;
const REFUSALS = fixture('refusals.json') as Record<'native' | 'http', Step[]>;
const STOP = fixture('run-stop.json') as Record<'native' | 'http', { steps: Step[] }>;
const SESSION_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session.mjs', import.meta.url));
const CONTRACT = 'nika/session-host@1';
const STEER = JSON.stringify({ contract: CONTRACT, op: 'steer', command: 's-1', line: 'use b instead' });
const doors = [['native', 'native-process'], ['http', 'http']] as const;
const recorded = (steps: Step[], step: string): Step => steps.find((entry) => entry.step === step)!;

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

/** A steer and a follow-up refused by the handle for want of the word, typed, each the same way. */
async function refusedBothWays(session: NikaAuthoringSession, transport: 'native-process' | 'http', said: string) {
  for (const send of [() => session.steer('use b instead', { command: 's-1' }),
    () => session.followUp('and c', { command: 'f-1' })]) {
    const error = await failure(send());
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'sessionSteering', transport });
    expect(error.message).toContain('does not advertise sessionSteering');
    expect(error.message).toContain(said);
  }
  // A caller's mistake is still told first, as one.
  expect(await failure(session.steer('x', { command: 'not an identity' }))).toBeInstanceOf(NikaConfigurationError);
}

describe('the doors\' word on the native door', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nika-steering-'));
  const opened: NikaAuthoringSession[] = [];
  afterEach(async () => {
    for (const session of opened.splice(0)) await session.close().catch(() => {});
    for (const name of ['NIKA_FAKE_SESSION_DOORS', 'NIKA_FAKE_IDENTITY_FILE', 'NIKA_FAKE_SESSION_LINES']) {
      delete process.env[name];
    }
  });
  /**
   * The fake host takes the doors either way, as a3017c495 does; the identity it prints is the one
   * the `pin` binary printed, and every line it is written is kept in `lines`.
   */
  async function open(pin: '0e4e1c74f' | 'a3017c495', lines: string): Promise<NikaAuthoringSession> {
    const identity = path.join(scratch, `identity-${pin}.json`);
    writeFileSync(identity, JSON.stringify(IDENTITIES[pin].native));
    Object.assign(process.env, { NIKA_FAKE_SESSION_DOORS: '1', NIKA_FAKE_IDENTITY_FILE: identity,
      NIKA_FAKE_SESSION_LINES: lines });
    const session = await new Nika({ bin: SESSION_ENGINE }).openSession();
    opened.push(session);
    return session;
  }
  const written = (lines: string) => readFileSync(lines, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  it('refuses a steer and a follow-up itself on an engine whose identity lacks the word: nothing written', async () => {
    expect(IDENTITIES.a3017c495.native.supportedCapabilities).not.toContain('sessionSteering');
    const lines = path.join(scratch, 'lines-a3017c495.ndjson');
    const session = await open('a3017c495', lines);
    await refusedBothWays(session, 'native-process', 'Nothing was sent');
    // No line reached the host and no identity was bound: `s-1` is free for a submit.
    expect((await session.submit(session.opened!.snapshot, 'hello', { command: 's-1' })).op).toBe('submit');
    expect(written(lines).map((line) => line.op)).toEqual(['submit']);
  });

  it('writes them to an engine whose identity lists the word, as 0e4e1c74f prints it', async () => {
    expect(IDENTITIES['0e4e1c74f'].native.supportedCapabilities).toContain('sessionSteering');
    const lines = path.join(scratch, 'lines-0e4e1c74f.ndjson');
    const session = await open('0e4e1c74f', lines);
    const steered = await session.steer('use b instead', { command: 's-1' });
    expect([steered.op, steered.receipt, steered.target]).toEqual(['steer', 'nothing_to_steer', null]);
    expect(written(lines)).toEqual([JSON.parse(STEER)]);
  });
});

describe('the doors\' word on the HTTP door', () => {
  const open = recorded(REFUSALS.http, 'open').frame!;
  const session = open.session as string;
  /** A resident answering as the recorded one did, its `/health` the one `health` names. */
  function resident(health: Record<string, any>) {
    const calls: { method: string; path: string; body: string | null }[] = [];
    const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const { pathname } = new URL(String(url));
      const method = init.method ?? 'GET';
      calls.push({ method, path: pathname, body: (init.body as string) ?? null });
      if (pathname === '/health') return jsonResponse(health);
      if (method === 'POST' && pathname === '/v1/sessions') return jsonResponse(open, 201);
      if (method === 'GET' && pathname === `/v1/sessions/${session}`) {
        return jsonResponse({ contract: CONTRACT, frame: 'snapshot', session, snapshot: open.snapshot });
      }
      if (method === 'POST' && pathname === `/v1/sessions/${session}/commands` && init.body === STEER) {
        return jsonResponse(recorded(REFUSALS.http, 'steer_no_turn').frame);
      }
      throw new Error(`unexpected ${method} ${pathname}`);
    });
    return { client: new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch }),
      calls };
  }
  const posted = (calls: { path: string; body: string | null }[]) =>
    calls.filter((call) => call.path.endsWith('/commands')).map((call) => call.body);

  it.each(['openSession', 'attachSession'] as const)(
    'refuses them itself through %s when /health lacks the word: nothing posted', async (how) => {
      expect(IDENTITIES.a3017c495.http.supportedCapabilities).not.toContain('sessionSteering');
      const { client, calls } = resident(IDENTITIES.a3017c495.http);
      const handle = how === 'openSession' ? await client.openSession() : await client.attachSession(session);
      await refusedBothWays(handle, 'http', 'Nothing was posted');
      expect(posted(calls)).toEqual([]);
    });

  it('posts them to a resident whose /health lists the word, as 0e4e1c74f serves it', async () => {
    const { client, calls } = resident(IDENTITIES['0e4e1c74f'].http);
    const handle = await client.openSession();
    const steered = await handle.steer('use b instead', { command: 's-1' });
    expect(steered).toEqual(recorded(REFUSALS.http, 'steer_no_turn').frame);
    expect(posted(calls)).toEqual([STEER]);
  });

  it('opens no Session on a resident started without --sessions, as 0e4e1c74f serves it', async () => {
    const { client, calls } = resident(IDENTITIES['0e4e1c74f'].http_without_sessions);
    expect(await failure(client.openSession())).toMatchObject({ capability: 'sessionHost', transport: 'http' });
    expect(calls.map((call) => call.path)).toEqual(['/health']);
  });
});

describe('a line the host cannot parse, as 0e4e1c74f refuses it', () => {
  it.each(doors)('is refused malformed, naming the valid identity it carries (%s)', (door, transport) => {
    const steps = REFUSALS[door];
    for (const [step, command] of [['unknown_op_named', 'c-9'], ['steer_without_line', 'c-8'],
      ['unknown_op_invalid_identity', undefined], ['not_json', undefined]] as const) {
      const { frame, status } = recorded(steps, step);
      const raw = JSON.stringify(frame);
      expect(sessionFrame(frame, transport)).toBe(frame);
      expect(JSON.stringify(frame)).toBe(raw);
      expect([frame!.frame, frame!.error, frame!.command]).toEqual(['refused', 'malformed', command]);
      if (door === 'http') expect(status).toBe(400);
      const error = sessionRefusal(frame!, transport, status ?? 0);
      expect(error).toBeInstanceOf(NikaSessionRefusedError);
      expect([error.code, error.command]).toEqual(['malformed', command]);
    }
    // The Session goes on: the next steer is answered, then the close.
    expect(recorded(steps, 'steer_no_turn').frame).toMatchObject({ frame: 'result', op: 'steer', command: 's-1',
      receipt: 'nothing_to_steer', target: null });
    expect(steps.at(-1)!.frame!.frame).toBe('closed');
  });
});

describe('a Stop of the Run a turn executes, as 0e4e1c74f settles it', () => {
  it.each(doors)('reaches the Run: run_stopping, then run_stopped, the Run interrupted and sealed (%s)',
    (door, transport) => {
      const { steps } = STOP[door];
      for (const step of ['stop', 'settled', 'stop_replayed']) {
        const { frame } = recorded(steps, step);
        const raw = JSON.stringify(frame);
        expect(sessionFrame(frame, transport)).toBe(frame);
        expect(JSON.stringify(frame)).toBe(raw);
      }
      const held = recorded(steps, 'held').snapshot!;
      expect(held.busy).toEqual({ command: 'c-1', phase: 'running', stop_requested: false });
      const result = (step: string) => recorded(steps, step).frame as unknown as NikaSessionResult;
      const stop = result('stop');
      expect([stop.op, stop.receipt, stop.target, stop.replayed, stop.snapshot.busy])
        .toEqual(['stop', 'run_stopping', 'c-1', false, { command: 'c-1', phase: 'stopping', stop_requested: true }]);
      const settled = result('settled');
      expect(settled.outcomes!.map((outcome) => outcome.kind)).toEqual(['run_requested', 'facts', 'run_stopped']);
      expect(settled.snapshot.work.run).toMatchObject({ current: true, workflow: 'held.nika',
        end: { end: 'interrupted' }, sealed: true });
      const replay = result('stop_replayed');
      expect([replay.receipt, replay.replayed, replay.event]).toEqual(['run_stopping', true, stop.event]);
    });
});
