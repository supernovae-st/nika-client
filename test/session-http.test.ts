import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
  NikaProtocolError,
  NikaSessionRefusedError,
  NikaSessionWaitError,
} from '../src/index.js';
import type { NikaSessionEvent } from '../src/index.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The HTTP door of the authoring Session (`/v1/sessions` on nika serve,
// contract nika/session-host@1 v2) against a mocked fetch: SYNTHETIC frames
// written from the contract text; recorded fixtures from the real door
// replace them. No network, no local engine.

const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'ab'.repeat(16)}`;
const SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'sessionHost'];

function snapshot(seq: number, extra: Record<string, unknown> = {}) {
  return {
    snapshot: `snp_${String(seq).padStart(32, '0')}`,
    seq,
    busy: null,
    work: {
      contract: 'nika/session-work@0', root: '/srv/project', request: { goal: null, decisions: [], unresolved: [] },
      authoring: null, waiting: { kind: 'free' }, candidate: null, saved: null, requested: null, run: null,
      rail: { draft: 'pending', saved: 'pending', checked: 'pending', active: 'pending', run: 'pending' },
      ...extra,
    },
  };
}
const frame = (body: Record<string, unknown>) => ({ contract: CONTRACT, session: SESSION, ...body });

type Route = (init: RequestInit & { headers: Headers }) => Response | Promise<Response>;

function server(routes: Record<string, Route>, capabilities = SERVER) {
  const calls: { method: string; path: string; body: string | null; headers: Headers }[] = [];
  const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const { pathname } = new URL(String(url));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    calls.push({ method, path: pathname, body: (init.body as string) ?? null, headers });
    if (pathname === '/health') return healthResponse({ engineVersion: '0.123.0', supportedCapabilities: capabilities });
    const route = routes[`${method} ${pathname}`];
    if (!route) throw new Error(`unexpected ${method} ${pathname}`);
    init.signal?.throwIfAborted();
    return route({ ...init, headers });
  });
  const client = new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch });
  return { client, calls };
}

const opened = () => jsonResponse(frame({ frame: 'opened', event: 1, snapshot: snapshot(1), notices: [] }), 201);
const base = `/v1/sessions/${SESSION}`;

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('HTTP authoring Session', () => {
  it('refuses a resident without the host after /health alone', async () => {
    const { client, calls } = server({}, SERVER.filter((word) => word !== 'sessionHost'));
    const error = await failure(client.openSession());
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'sessionHost', transport: 'http' });
    expect(error.message).toMatch(/Nothing was posted/);
    expect(calls.map((call) => call.path)).toEqual(['/health']);
  });

  it('opens the served project\'s Session with the bearer token and reads it', async () => {
    const { client, calls } = server({
      'POST /v1/sessions': opened,
      [`GET ${base}`]: () => jsonResponse(frame({ frame: 'snapshot', snapshot: snapshot(1) })),
      [`GET ${base}/details`]: () => jsonResponse(frame({ frame: 'details', snapshot: snapshot(1).snapshot, text: 'd' })),
    });
    const session = await client.openSession();
    expect(session.id).toBe(SESSION);
    expect(session.transport).toBe('http');
    expect(calls[1]!.headers.get('Authorization')).toBe(`Bearer ${TOKEN_A}`);
    const read = await session.snapshot();
    // Over HTTP the work names the server's project world, verbatim.
    expect(read.work.root).toBe('/srv/project');
    expect((await session.details()).text).toBe('d');
  });

  it('names the live Session when one is open, and attaches to it', async () => {
    const live = `ses_${'cd'.repeat(16)}`;
    const { client, calls } = server({
      'POST /v1/sessions': () => jsonResponse({ contract: CONTRACT, frame: 'refused', session: live, error: 'session_live',
        message: 'one Session is live for this project' }, 409),
      [`GET /v1/sessions/${live}`]: () => jsonResponse({ contract: CONTRACT, frame: 'snapshot', session: live,
        snapshot: snapshot(3) }),
    });
    const error = await failure(client.openSession());
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'session_live', status: 409, session: live });
    const attached = await client.attachSession((error as NikaSessionRefusedError).session!);
    expect(attached.id).toBe(live);
    expect(attached.opened).toBeUndefined();
    expect((await attached.snapshot()).seq).toBe(3);
    expect(calls.filter((call) => call.method === 'GET' && call.path.startsWith('/v1/sessions/'))).toHaveLength(2);
    await expect(client.attachSession('../etc')).rejects.toBeInstanceOf(NikaConfigurationError);
  });

  it('posts a command\'s exact bytes and returns its result as the host wrote it', async () => {
    const result = frame({ frame: 'result', event: 4, command: 'c-1', op: 'submit', replayed: false,
      outcomes: [{ kind: 'proposal', proposal: 'p'.repeat(64), text: 'Save digest.nika?' }],
      snapshot: snapshot(2, { waiting: { kind: 'consent', proposal: 'p'.repeat(64) } }), future_member: 1 });
    const { client, calls } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: () => jsonResponse(result),
    });
    const session = await client.openSession();
    const settled = await session.submit(session.opened!.snapshot, 'résumé de mes notes\nchaque matin', { command: 'c-1' });
    expect(settled).toEqual(result);
    const posted = calls.find((call) => call.path === `${base}/commands`)!;
    expect(posted.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(posted.body!)).toEqual({ contract: CONTRACT, op: 'submit', command: 'c-1',
      snapshot: snapshot(1).snapshot, line: 'résumé de mes notes\nchaque matin' });
  });

  it('returns the host\'s refusal typed, with the line kept and the bearer token never shown', async () => {
    const { client } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: () => jsonResponse(frame({ frame: 'refused', command: 'c-2', error: 'stale_snapshot',
        message: `answered snapshot is gone ${TOKEN_A}`, snapshot: snapshot(5) }), 409),
    });
    const session = await client.openSession();
    const error = await failure(session.submit(session.opened!.snapshot, 'yes', { command: 'c-2' }));
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'stale_snapshot', status: 409, command: 'c-2', line: 'yes' });
    expect((error as NikaSessionRefusedError).snapshot?.seq).toBe(5);
    expect(error.message).not.toContain(TOKEN_A);
  });

  it('keeps a refused line and the work it carried off every logged or serialized surface', async () => {
    const secretLine = 'my private note: reorder 40 boxes for Café Lumière';
    const { client } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: () => jsonResponse(frame({ frame: 'refused', command: 'c-9', error: 'busy',
        message: 'a turn runs\nsecond line', snapshot: snapshot(4, { request: { goal: 'confidential goal' } }) }), 409),
    });
    const session = await client.openSession();
    const error = await failure(session.submit(session.opened!.snapshot, secretLine, { command: 'c-9' }));
    expect(error).toMatchObject({ code: 'busy', line: secretLine });
    for (const surface of [inspect(error, { depth: 10 }), JSON.stringify(error), String(error)]) {
      expect(surface).not.toContain('Café Lumière');
      expect(surface).not.toContain('confidential goal');
    }
    expect(error.message).not.toContain('\n');
  });

  it('reports a malformed JSON body without carrying its text anywhere', async () => {
    const marker = 'PRIVATE-MARKER-reorder-boxes';
    const malformed = (status: number) => () => new Response(`{"contract": "${marker}", oops`,
      { status, headers: { 'Content-Type': 'application/json' } });
    const opening = server({ 'POST /v1/sessions': malformed(201) });
    const commanded = server({ 'POST /v1/sessions': opened, [`POST ${base}/commands`]: malformed(200) });
    const errors = [
      await failure(opening.client.openSession()),
      await failure((await commanded.client.openSession()).stop()),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(NikaProtocolError);
      expect(error.message).toMatch(/did not return valid JSON/);
      expect(error.cause).toBeUndefined();
      for (const surface of [inspect(error, { depth: 10 }), JSON.stringify(error), String(error)]) {
        expect(surface).not.toContain(marker);
      }
    }
  });

  it('refuses a refusal whose word is not an identifier, without echoing it', async () => {
    const { client } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: () => jsonResponse(frame({ frame: 'refused', error: `not a word ${TOKEN_A}`,
        message: 'x' }), 409),
      [`GET ${base}`]: () => jsonResponse(frame({ frame: `odd ${TOKEN_A}`, snapshot: snapshot(1) })),
    });
    const session = await client.openSession();
    const refused = await failure(session.stop());
    expect(refused).toBeInstanceOf(NikaProtocolError);
    const odd = await failure(session.snapshot());
    expect(odd).toBeInstanceOf(NikaProtocolError);
    for (const error of [refused, odd]) expect(inspect(error, { depth: 10 })).not.toContain(TOKEN_A);
  });

  it('keeps Serve\'s own refusals apart from the host\'s', async () => {
    const { client } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: () => jsonResponse({ error: { code: 'unauthorized', message: 'bad token' } }, 401),
    });
    const session = await client.openSession();
    const error = await failure(session.stop());
    expect(error).toBeInstanceOf(NikaOperationError);
    expect(error).not.toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401, operation: 'session' });
  });

  it('turns a cut wait into a wait error naming the command, and reads the result by sending it again', async () => {
    const replayed = frame({ frame: 'result', command: 'c-3', op: 'submit', replayed: true,
      outcomes: [{ kind: 'reply', text: 'ok' }], snapshot: snapshot(2) });
    let posts = 0;
    const { client } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: async (init) => {
        posts += 1;
        if (posts === 1) {
          await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
        }
        return jsonResponse(replayed);
      },
    });
    const session = await client.openSession();
    const controller = new AbortController();
    const waiting = session.submit(session.opened!.snapshot, 'hello', { command: 'c-3', signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await failure(waiting);
    expect(error).toBeInstanceOf(NikaSessionWaitError);
    expect(error).toMatchObject({ command: 'c-3', transport: 'http' });
    expect(await session.submit(session.opened!.snapshot, 'hello', { command: 'c-3' })).toEqual(replayed);
  });

  it('refuses an answer that names another command or another Session', async () => {
    const { client } = server({
      'POST /v1/sessions': opened,
      [`POST ${base}/commands`]: () => jsonResponse(frame({ frame: 'result', command: 'other', op: 'stop',
        replayed: false, receipt: 'nothing_to_stop', target: null, snapshot: snapshot(1) })),
      [`GET ${base}`]: () => jsonResponse({ ...frame({ frame: 'snapshot', snapshot: snapshot(1) }), session: `ses_${'ef'.repeat(16)}` }),
    });
    const session = await client.openSession();
    await expect(session.stop({ command: 'mine' })).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(session.snapshot()).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('streams events with their cursors, resumes with Last-Event-ID and yields a resync as sent', async () => {
    const stream = (frames: Record<string, unknown>[]) => new Response(frames.map((body) => (body.event === undefined
      ? '' : `id: ${SESSION}:${body.event as number}\n`) + `data: ${JSON.stringify(body)}\n\n`).join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const { client, calls } = server({
      'POST /v1/sessions': opened,
      [`GET ${base}/events`]: (init) => (init.headers.get('Last-Event-ID') === `${SESSION}:1`
        ? stream([frame({ frame: 'accepted', event: 2, command: 'c', op: 'submit' })])
        : stream([frame({ frame: 'resync', snapshot: snapshot(7) }),
          frame({ frame: 'closed', event: 9, snapshot: snapshot(7) })])),
    });
    const session = await client.openSession();
    const resumed: NikaSessionEvent[] = [];
    for await (const event of session.events({ after: `${SESSION}:1` })) resumed.push(event);
    expect(resumed.map((event) => [event.frame, event.cursor])).toEqual([['accepted', `${SESSION}:2`]]);
    const fresh: NikaSessionEvent[] = [];
    for await (const event of session.events({ after: `ses_${'00'.repeat(16)}:4` })) fresh.push(event);
    expect(fresh.map((event) => [event.frame, event.cursor])).toEqual([['resync', undefined], ['closed', `${SESSION}:9`]]);
    const sse = calls.filter((call) => call.path === `${base}/events`);
    expect(sse[0]!.headers.get('Accept')).toBe('text/event-stream');
  });
});
