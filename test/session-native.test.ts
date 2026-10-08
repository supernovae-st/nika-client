import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Nika,
  NikaAuthoringSession,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaSessionRefusedError,
  NikaSessionWaitError,
} from '../src/index.js';
import type { NikaSessionEvent, NikaSessionResult } from '../src/index.js';

// The native door of the authoring Session (`nika session --json`, contract
// nika/session-host@1 v2) against a SYNTHETIC fake host that plays the
// contract's laws; recorded fixtures from the real doors replace it. These
// tests pin the SDK's handle: what it sends, how it routes frames, and that it
// never decides what a line means.

const SESSION_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session.mjs', import.meta.url));
const argvLog = path.join(tmpdir(), `nika-sdk-session-native-${process.pid}.log`);
const opened: NikaAuthoringSession[] = [];

async function open(): Promise<NikaAuthoringSession> {
  process.env.NIKA_FAKE_ARGV_LOG = argvLog;
  const session = await new Nika({ bin: SESSION_ENGINE }).openSession();
  opened.push(session);
  return session;
}

afterEach(async () => {
  for (const session of opened.splice(0)) await session.close().catch(() => {});
  for (const key of ['NIKA_FAKE_ARGV_LOG', 'NIKA_FAKE_NO_SESSION_HOST', 'NIKA_FAKE_SESSION_LOCKED']) delete process.env[key];
  rmSync(argvLog, { force: true });
});

function argv(): string[][] {
  return existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('native authoring Session', () => {
  it('refuses an engine without the host before any Session process exists', async () => {
    process.env.NIKA_FAKE_NO_SESSION_HOST = '1';
    process.env.NIKA_FAKE_ARGV_LOG = argvLog;
    const error = await failure(new Nika({ bin: SESSION_ENGINE }).openSession());
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'sessionHost', transport: 'native-process' });
    expect(argv()).toEqual([['--sdk-identity']]);
  });

  it('surfaces a held project Session as the host refused it', async () => {
    process.env.NIKA_FAKE_SESSION_LOCKED = '1';
    const error = await failure(new Nika({ bin: SESSION_ENGINE }).openSession());
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'session_unavailable', operation: 'session' });
  });

  it('opens on the opened event and reads snapshot and details as the engine wrote them', async () => {
    const session = await open();
    expect(argv()).toEqual([['--sdk-identity'], ['session', '--json']]);
    expect(session.id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(session.opened).toMatchObject({ frame: 'opened', event: 1, notices: ['fake host'] });
    const snapshot = await session.snapshot();
    expect(snapshot).toEqual(session.opened!.snapshot);
    expect(snapshot.work).toMatchObject({ contract: 'nika/session-work@0', waiting: { kind: 'free' },
      future_work_member: { additive: true } });
    expect(await session.details()).toMatchObject({ frame: 'details', snapshot: snapshot.snapshot,
      text: `details of ${snapshot.snapshot}` });
  });

  it('submits a line against the snapshot it answers and carries the exact candidate bytes', async () => {
    const session = await open();
    const first = await session.snapshot();
    const proposed = await session.submit(first, 'draft a digest');
    expect(proposed).toMatchObject({ frame: 'result', op: 'submit', replayed: false,
      outcomes: [{ kind: 'proposal', text: 'Save digest.nika?' }] });
    const candidate = proposed.snapshot.work.candidate as { files: { content: string }[] };
    expect(candidate.files[0]!.content).toBe('# Digest 🦋\nnika: digest\n# « Relevé — semaine »\ntasks: {}\n');
    expect(proposed.snapshot.work.waiting).toEqual({ kind: 'consent', proposal: 'p'.repeat(64) });
    // Preview before Save: nothing saved yet; the consent is its own line, against its own snapshot.
    expect(proposed.snapshot.work.saved).toBeNull();
    const saved = await session.submit(proposed.snapshot, 'yes');
    expect(saved.outcomes).toEqual([{ kind: 'reply', text: 'Saved digest.nika' }]);
    expect(saved.snapshot.work.saved).toMatchObject({ workflow: 'digest.nika' });
    expect(saved.snapshot.work.requested).toBeNull();
  });

  it('refuses an answer to a snapshot that is no longer current, keeping the line for its owner', async () => {
    const session = await open();
    const first = await session.snapshot();
    const proposed = await session.submit(first, 'draft a digest');
    const error = await failure(session.submit(first, 'yes'));
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'stale_snapshot', line: 'yes' });
    expect((error as NikaSessionRefusedError).snapshot?.snapshot).toBe(proposed.snapshot.snapshot);
    // Nothing reached the runtime: the proposal still waits for its consent.
    expect((await session.snapshot()).work.waiting).toMatchObject({ kind: 'consent' });
    const unknown = await failure(session.submit('snp_never_published', 'yes'));
    expect(unknown).toMatchObject({ code: 'unknown_snapshot' });
  });

  it('replays a command sent again with the same bytes and refuses other bytes under its identity', async () => {
    const session = await open();
    const first = await session.snapshot();
    const original = await session.submit(first, 'hello', { command: 'c-1' });
    const again = await session.submit(first, 'hello', { command: 'c-1' });
    expect(original.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, command: 'c-1', outcomes: original.outcomes });
    expect(again.event).toBeUndefined();
    const conflict = await failure(session.submit(first, 'other words', { command: 'c-1' }));
    expect(conflict).toMatchObject({ code: 'command_conflict', command: 'c-1', line: 'other words' });
  });

  it('answers reads during a turn, refuses a second line as busy, and settles a Stop by the turn itself', async () => {
    const session = await open();
    const first = await session.snapshot();
    const turn = session.submit(first, 'slow draft', { command: 'slow-1' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const during = await session.snapshot();
    expect(during.busy).toMatchObject({ command: 'slow-1', phase: 'preparing' });
    expect(await session.details()).toMatchObject({ frame: 'details' });
    const busy = await failure(session.submit(during, 'another line'));
    expect(busy).toMatchObject({ code: 'busy', line: 'another line' });
    const receipt = await session.stop({ command: 'stop-1' });
    expect(receipt).toMatchObject({ op: 'stop', receipt: 'stop_requested', target: 'slow-1' });
    const settled = await turn;
    expect(settled.outcomes!.at(-1)).toEqual({ kind: 'cancelled', text: 'stopped', withdrawn: true });
    expect(settled.snapshot.work.candidate).toBeNull();
    expect((await session.stop()).receipt).toBe('nothing_to_stop');
  });

  it('stops waiting without stopping the turn, and reads its result by sending the command again', async () => {
    const session = await open();
    const first = await session.snapshot();
    const controller = new AbortController();
    const waiting = session.submit(first, 'slow draft', { command: 'cut-1', signal: controller.signal });
    controller.abort();
    const error = await failure(waiting);
    expect(error).toBeInstanceOf(NikaSessionWaitError);
    expect(error).toMatchObject({ command: 'cut-1' });
    const result = await session.submit(first, 'slow draft', { command: 'cut-1' });
    expect(result.outcomes).toMatchObject([{ kind: 'proposal' }]);
  });

  it('streams events with cursors and replays the ones it retains', async () => {
    const session = await open();
    const seen: NikaSessionEvent[] = [];
    const reading = (async () => {
      for await (const event of session.events({ after: `${session.id}:0` })) {
        seen.push(event);
        if (event.frame === 'result') break;
      }
    })();
    await session.submit(await session.snapshot(), 'hello');
    await reading;
    expect(seen.map((event) => [event.frame, event.event, event.cursor])).toEqual([
      ['opened', 1, `${session.id}:1`],
      ['accepted', 2, `${session.id}:2`],
      ['activity', 3, `${session.id}:3`],
      ['result', 4, `${session.id}:4`],
    ]);
    const later: string[] = [];
    for await (const event of session.events({ after: seen[1]!.cursor })) {
      later.push(event.frame);
      if (event.frame === 'result') break;
    }
    expect(later).toEqual(['activity', 'result']);
    await expect(async () => {
      for await (const _ of session.events({ after: 'ses_other:1' })) break;
    }).rejects.toBeInstanceOf(NikaConfigurationError);
  });

  it('closes on its close command and refuses commands afterwards', async () => {
    const session = await open();
    const closed = await session.close({ command: 'bye' });
    expect(closed).toMatchObject({ frame: 'closed', command: 'bye' });
    const error = await failure(session.submit(closed.snapshot, 'hello'));
    expect(error).toBeInstanceOf(NikaConfigurationError);
  });

  it('refuses a caller mistake before sending anything', async () => {
    const session = await open();
    const snapshot = await session.snapshot();
    await expect(session.submit(snapshot, 'x', { command: 'has space' })).rejects.toBeInstanceOf(NikaConfigurationError);
    await expect(session.submit(snapshot, '\ud800')).rejects.toBeInstanceOf(NikaConfigurationError);
    await expect(session.submit({} as never, 'x')).rejects.toBeInstanceOf(NikaConfigurationError);
    const result: NikaSessionResult = await session.submit(snapshot, 'still fine');
    expect(result.replayed).toBe(false);
  });
});
