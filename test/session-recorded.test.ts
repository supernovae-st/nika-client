import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaSessionRefusedError } from '../src/index.js';
import type { NikaSessionEvent, NikaSessionResult } from '../src/index.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The authoring Session handle over frames `nika-session-host` RECORDED from its real doors at
// two engine commits (test/fixtures/session-host/<commit>/README.md): e849d08eaf37 and the merged
// eb89e1893, whose Work carries the current members. Native NDJSON driver and HTTP routes,
// in-process; the Session reasoner was scripted and never asked; the compiler was the real
// deterministic one. These tests pin that the SDK sends the recorded commands and decodes every
// recorded frame losslessly; they are not a run of the shipped binaries.

const RECORDINGS = ['e849d08eaf37', 'eb89e1893'];
const recorded = (recording: string, name: string) => JSON.parse(readFileSync(
  new URL(`./fixtures/session-host/${recording}/${name}`, import.meta.url), 'utf8')) as Record<string, any>[];
const REPLAY_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session-replay.mjs', import.meta.url));
// The c-1 intent of the recording (README "COPY"; the decisions script states its words).
const COPY = 'Read ./notes/brief.md and write it to ./out/copy.md';
const SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'sessionHost'];

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe.each(RECORDINGS)('recorded native door (%s)', (recording) => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the recorded script and decodes every recorded frame as the host wrote it', async () => {
    const answers = recorded(recording, 'native-answers.json');
    const log = recorded(recording, 'native-log.json');
    // The replay engine inherits this process's environment: it serves this recording.
    vi.stubEnv('NIKA_FAKE_SESSION_RECORDING', recording);
    const session = await new Nika({ bin: REPLAY_ENGINE }).openSession();
    expect(session.opened).toEqual(answers[0]);
    const opening = session.opened!.snapshot;
    const proposed = await session.submit(opening, COPY, { command: 'c-1' });
    expect(proposed).toEqual(answers[1]);
    expect(proposed.snapshot.work.waiting).toMatchObject({ kind: 'consent' });
    const stale = await failure(session.submit(opening, 'yes', { command: 'c-2' }));
    expect(stale).toBeInstanceOf(NikaSessionRefusedError);
    expect(stale).toMatchObject({ code: 'stale_snapshot', command: 'c-2', line: 'yes' });
    expect((stale as NikaSessionRefusedError).snapshot).toEqual(answers[2].snapshot);
    const replayed = await session.submit(opening, COPY, { command: 'c-1' });
    expect(replayed).toEqual(answers[3]);
    expect(replayed).toMatchObject({ replayed: true, event: proposed.event });
    expect(await session.details()).toEqual(answers[4]);
    const saved = await session.submit(proposed.snapshot, 'yes', { command: 'c-3' });
    expect(saved).toEqual(answers[5]);
    expect(saved.snapshot.work.saved).not.toBeNull();
    expect(saved.snapshot.work.requested).toBeNull();
    expect(await session.stop({ command: 's-1' })).toEqual(answers[6]);
    expect(await session.close()).toEqual(answers[7]);
    // The log, each event once (the replayed result is a direct reply), with its cursor.
    const events: NikaSessionEvent[] = [];
    for await (const event of session.events({ after: `${session.id}:0` })) events.push(event);
    expect(events.map(({ cursor, ...frame }) => frame)).toEqual(log);
    expect(events.map((event) => event.cursor)).toEqual(log.map((frame) => `${session.id}:${frame.event}`));
  });
});

type Answer = { status: number; body: Record<string, any> };
/** A resident whose Session routes answer as `route` says; every request is kept as sent. */
function resident(route: (method: string, path: string, body: Record<string, any> | null) =>
  Answer | Response | Promise<Response>) {
  const sent: { method: string; path: string; body: Record<string, any> | null }[] = [];
  const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const { pathname } = new URL(String(url));
    if (pathname === '/health') return healthResponse({ engineVersion: '0.122.0', supportedCapabilities: SERVER });
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, any> : null;
    sent.push({ method, path: pathname, body });
    const answer = await route(method, pathname, body);
    return answer instanceof Response ? answer : jsonResponse(answer.body, answer.status);
  });
  return { client: new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch }),
    sent };
}
const status = (frame: Record<string, any>) => (frame.frame === 'opened' ? 201
  : frame.frame !== 'refused' ? 200 : frame.error === 'malformed' ? 400 : frame.error === 'session_not_found' ? 404 : 409);

describe.each(RECORDINGS)('recorded HTTP door (%s)', (recording) => {
  it('replays the recorded script: exact answers decoded, the log streamed with its cursors', async () => {
    const answers = recorded(recording, 'http-answers.json');
    const sseLog = recorded(recording, 'http-sse-log.json');
    const session = answers[0].session as string;
    let next = 0;
    const { client, sent } = resident((method, path) => {
      if (path === `/v1/sessions/${session}/events`) {
        return new Response(sseLog.map((frame) => `id: ${session}:${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`)
          .join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      const frame = answers[next++]!;
      return { status: status(frame), body: frame };
    });
    const handle = await client.openSession();
    expect(handle.opened).toEqual(answers[0]);
    const opening = handle.opened!.snapshot;
    const proposed = await handle.submit(opening, COPY, { command: 'c-1' });
    expect(proposed).toEqual(answers[1]);
    const stale = await failure(handle.submit(opening, 'yes', { command: 'c-2' }));
    expect(stale).toMatchObject({ code: 'stale_snapshot', status: 409, line: 'yes' });
    expect(await handle.submit(opening, COPY, { command: 'c-1' })).toEqual(answers[3]);
    expect(await handle.details()).toEqual(answers[4]);
    expect(await handle.submit(proposed.snapshot, 'yes', { command: 'c-3' })).toEqual(answers[5]);
    expect(await handle.stop({ command: 's-1' })).toEqual(answers[6]);
    expect(await handle.close()).toEqual(answers[7]);
    expect(sent.map(({ method, path }) => `${method} ${path.replace(session, '{s}')}`)).toEqual([
      'POST /v1/sessions', 'POST /v1/sessions/{s}/commands', 'POST /v1/sessions/{s}/commands',
      'POST /v1/sessions/{s}/commands', 'GET /v1/sessions/{s}/details', 'POST /v1/sessions/{s}/commands',
      'POST /v1/sessions/{s}/commands', 'DELETE /v1/sessions/{s}',
    ]);
    const streamed: NikaSessionEvent[] = [];
    for await (const event of handle.events()) streamed.push(event);
    expect(streamed.map(({ cursor, ...frame }) => frame)).toEqual(sseLog);
    expect(streamed.at(-1)!.cursor).toBe(`${session}:${sseLog.at(-1)!.event}`);
  });

  it('sends the recorded decision commands byte for byte and decodes busy, conflict, Stop and the question', async () => {
    const decisions = recorded(recording, 'http-decisions.json');
    const step = (name: string) => decisions.find((entry) => entry.step === name)!;
    const session = step('open').answered.session as string;
    let stopped = false;
    let releaseTurn!: () => void;
    const turnHeld = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const { client, sent } = resident((method, path, body) => {
      if (method === 'POST' && path === '/v1/sessions') return { status: 201, body: step('open').answered };
      if (method === 'DELETE') return { status: 200, body: step('close').answered };
      const name = body!.command === 'c-2' ? 'busy'
        : body!.command === 'c-1' && body!.line === 'other' ? 'conflict'
        : body!.command === 's-1' ? (stopped ? 'stop_replayed' : 'stop')
        : body!.command === 'q-1' ? 'question' : body!.command === 'q-2' ? 'answer' : 'stopped_settlement';
      const answered = step(name).answered;
      if (name === 'stopped_settlement') {
        // The turn's response waits for its Stop, as the host's did.
        return turnHeld.then(() => jsonResponse(answered, 200));
      }
      if (name === 'stop') { stopped = true; releaseTurn(); }
      return { status: status(answered), body: answered };
    });
    const handle = await client.openSession();
    const opening = handle.opened!.snapshot;
    const turn = handle.submit(opening, COPY, { command: 'c-1' });
    const busy = await failure(handle.submit(opening, 'hello', { command: 'c-2' }));
    expect(busy).toMatchObject({ code: 'busy', line: 'hello' });
    expect((busy as NikaSessionRefusedError).snapshot?.busy).toEqual({ command: 'c-1', phase: 'preparing',
      stop_requested: false });
    const conflict = await failure(handle.submit(opening, 'other', { command: 'c-1' }));
    expect(conflict).toMatchObject({ code: 'command_conflict', line: 'other' });
    const receipt = await handle.stop({ command: 's-1' });
    expect(receipt).toEqual(step('stop').answered);
    const settled: NikaSessionResult = await turn;
    expect(settled).toEqual(step('stopped_settlement').answered);
    expect(settled.outcomes!.at(-1)).toMatchObject({ kind: 'cancelled', withdrawn: [{ kind: 'proposal' }] });
    expect(await handle.stop({ command: 's-1' })).toMatchObject({ replayed: true, event: receipt.event });
    const asked = await handle.submit(settled.snapshot, step('question').sent.line, { command: 'q-1' });
    expect(asked.outcomes).toEqual([expect.objectContaining({ kind: 'question', key: 'model' })]);
    const answered = await handle.submit(asked.snapshot, step('answer').sent.line, { command: 'q-2' });
    expect(answered).toEqual(step('answer').answered);
    expect(await handle.close()).toEqual(step('close').answered);
    // Every command left with the bytes the host recorded receiving.
    const commands = sent.filter((request) => request.body?.op !== undefined).map((request) => request.body);
    const expected = ['stopped_settlement', 'busy', 'conflict', 'stop', 'stop_replayed', 'question', 'answer']
      .map((name) => step(name).sent);
    expect(commands).toEqual(expected);
  });
});

describe('recorded resident cost review over HTTP (eb89e1893)', () => {
  it('reviews a Run: a stale yes refused with its line, one admission and its replay, a decline admitting nothing',
    async () => {
      const review = recorded('eb89e1893', 'http-run-review.json');
      const step = (name: string) => review.find((entry) => entry.step === name)!;
      // The resident answers in the recorded order; what the SDK sent is compared afterwards.
      let next = 0;
      const { client, sent } = resident(() => {
        const answered = review[next++]!.answered as Record<string, any>;
        return { status: status(answered), body: answered };
      });
      const handle = await client.openSession();
      expect(handle.opened).toEqual(step('open').answered);
      const proposed = await handle.submit(handle.opened!.snapshot, COPY, { command: 'c-1' });
      expect(proposed).toEqual(step('propose').answered);
      const saved = await handle.submit(proposed.snapshot, 'yes', { command: 'c-2' });
      expect(saved).toEqual(step('save').answered);
      const reviewing = await handle.submit(saved.snapshot, 'run it', { command: 'c-3' });
      expect(reviewing).toEqual(step('run').answered);
      expect(reviewing.outcomes!.map((outcome) => outcome.kind)).toEqual(['run_requested', 'run_review']);
      expect(reviewing.snapshot.work.waiting).toMatchObject({ kind: 'run_review' });
      // A yes typed before the review was shown is refused; the line comes back, nothing ran.
      const stale = await failure(handle.submit(saved.snapshot, 'yes', { command: 'c-4' }));
      expect(stale).toBeInstanceOf(NikaSessionRefusedError);
      expect(stale).toMatchObject({ code: 'stale_snapshot', status: 409, line: 'yes', command: 'c-4' });
      expect((stale as NikaSessionRefusedError).snapshot).toEqual(reviewing.snapshot);
      const approved = await handle.submit(reviewing.snapshot, 'yes', { command: 'c-5' });
      expect(approved).toEqual(step('approve').answered);
      expect(approved.outcomes![0]).toMatchObject({ kind: 'run_reviewed', approve: true });
      expect(approved.snapshot.work.run).toMatchObject({ current: true, end: { end: 'succeeded' } });
      // The same command again is the same recorded result, never a second admission.
      const replayed = await handle.submit(reviewing.snapshot, 'yes', { command: 'c-5' });
      expect(replayed).toEqual(step('approve_replayed').answered);
      expect(replayed).toMatchObject({ replayed: true, event: approved.event });
      const again = await handle.submit(approved.snapshot, 'run it', { command: 'c-6' });
      expect(again).toEqual(step('run_again').answered);
      expect(again.snapshot.work.waiting).toMatchObject({ kind: 'run_review' });
      expect((again.snapshot.work.waiting as { review: string }).review)
        .not.toBe((reviewing.snapshot.work.waiting as { review: string }).review);
      const declined = await handle.submit(again.snapshot, 'no', { command: 'c-7' });
      expect(declined).toEqual(step('decline').answered);
      expect(declined.outcomes).toEqual([expect.objectContaining({ kind: 'run_reviewed', approve: false })]);
      expect(await handle.close()).toEqual(step('close').answered);
      // Every command left with the bytes the host recorded receiving, in its order.
      expect(sent.map(({ method, path }) => `${method} ${path.replace(step('open').answered.session, '{s}')}`))
        .toEqual(['POST /v1/sessions', ...Array(8).fill('POST /v1/sessions/{s}/commands'), 'DELETE /v1/sessions/{s}']);
      expect(sent.filter((request) => request.body?.op !== undefined).map((request) => request.body))
        .toEqual(review.filter((entry) => entry.sent !== null).map((entry) => entry.sent));
    });
});
