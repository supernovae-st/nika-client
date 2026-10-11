import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaConfigurationError, NikaProtocolError, NikaSessionRefusedError } from '../src/index.js';
import type { NikaSessionSelectedIntelligence } from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The conversation's own intelligence (engine host 92bc996c8): `openSession({ intelligence })`
// passes the first-screen words as written — natively `nika session --json --intelligence
// <words>`, over HTTP `POST /v1/sessions {"contract", "intelligence"}` — only to an engine that
// advertises `sessionIntelligence`; the work then names `selected.scope: conversation`. The SDK
// never answers the first screen and never reads the words.

const SESSION_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session.mjs', import.meta.url));
const WORDS = '2 deepseek/deepseek-v4-pro';
const scratches: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The fake engine's argv log, one JSON array per invocation. */
function argvLog() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nika-sdk-session-intelligence-'));
  scratches.push(dir);
  const file = path.join(dir, 'argv.jsonl');
  vi.stubEnv('NIKA_FAKE_ARGV_LOG', file);
  return () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('the native door opens with the conversation\'s own intelligence', () => {
  it('passes the words as one argument, and the work names the conversation scope', async () => {
    const calls = argvLog();
    vi.stubEnv('NIKA_FAKE_SESSION_INTELLIGENCE', '1');
    const session = await new Nika({ bin: SESSION_ENGINE }).openSession({ intelligence: WORDS });
    const selected = session.opened!.snapshot.work.intelligence!.selected as NikaSessionSelectedIntelligence;
    expect(selected).toMatchObject({ scope: 'conversation', model: 'deepseek/deepseek-v4-pro' });
    await session.close();
    expect(calls().at(-1)).toEqual(['session', '--json', '--intelligence', WORDS]);
  });

  it('opens exactly as before when no intelligence is named, capability or not', async () => {
    const calls = argvLog();
    const session = await new Nika({ bin: SESSION_ENGINE }).openSession();
    await session.close();
    expect(calls().at(-1)).toEqual(['session', '--json']);
  });

  it('refuses before any Session starts when the engine does not advertise sessionIntelligence', async () => {
    const calls = argvLog();
    const error = await failure(new Nika({ bin: SESSION_ENGINE }).openSession({ intelligence: WORDS }));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'sessionIntelligence' });
    expect(calls().some((argv) => argv[0] === 'session')).toBe(false);
  });

  it('carries the engine\'s own refusal of words it does not read', async () => {
    vi.stubEnv('NIKA_FAKE_SESSION_INTELLIGENCE', '1');
    const error = await failure(new Nika({ bin: SESSION_ENGINE }).openSession({ intelligence: '9 nowhere' }));
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'session_unavailable' });
    expect(error.message).toContain('not one this machine reads');
  });

  it.each([['an empty line', ''], ['blanks', '   '], ['two lines', '2 deepseek/x\n1'], ['a number', 2]])(
    'refuses %s before asking the engine anything', async (_name, intelligence) => {
      const calls = argvLog();
      const error = await failure(new Nika({ bin: SESSION_ENGINE })
        .openSession({ intelligence: intelligence as string }));
      expect(error).toBeInstanceOf(NikaConfigurationError);
      expect(calls()).toEqual([]);
    });
});

describe('the HTTP door opens with the conversation\'s own intelligence', () => {
  const SERVER = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'compile', 'sessionHost'];
  const opened = (scope: string) => ({ contract: 'nika/session-host@1', frame: 'opened', session: `ses_${'7a'.repeat(16)}`,
    event: 1, notices: [], snapshot: { snapshot: `snp_${'1'.repeat(32)}`, seq: 1, busy: null, work: {
      contract: 'nika/session-work@0', root: '/srv/p', request: {}, authoring: null, waiting: { kind: 'free' },
      candidate: null, saved: null, requested: null, run: null, rail: {},
      intelligence: { author: { kind: 'provider', model: 'deepseek/deepseek-v4-pro' }, decision: null, effort: null,
        selected: { kind: 'api', via: 'deepseek', model: 'deepseek/deepseek-v4-pro', ready: true, scope } } } } });
  function resident(capabilities: string[], answer: (body: Record<string, unknown>) => Response) {
    const sent: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
    const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const { pathname } = new URL(String(url));
      if (pathname === '/health') return healthResponse({ engineVersion: '0.123.0', supportedCapabilities: capabilities });
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      sent.push({ method: init.method ?? 'GET', path: pathname, body });
      return answer(body ?? {});
    });
    return { client: new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch }),
      sent };
  }

  it('posts the words beside the contract, and reads the conversation scope back', async () => {
    const { client, sent } = resident([...SERVER, 'sessionIntelligence'], () => jsonResponse(opened('conversation'), 201));
    const session = await client.openSession({ intelligence: WORDS });
    expect(sent).toEqual([{ method: 'POST', path: '/v1/sessions',
      body: { contract: 'nika/session-host@1', intelligence: WORDS } }]);
    expect(session.opened!.snapshot.work.intelligence!.selected).toMatchObject({ scope: 'conversation' });
  });

  it('posts the contract alone when no intelligence is named', async () => {
    const { client, sent } = resident(SERVER, () => jsonResponse(opened('operator_default'), 201));
    await client.openSession();
    expect(sent[0]!.body).toEqual({ contract: 'nika/session-host@1' });
  });

  it('refuses before posting when the resident does not advertise sessionIntelligence', async () => {
    const { client, sent } = resident(SERVER, () => jsonResponse(opened('conversation'), 201));
    const error = await failure(client.openSession({ intelligence: WORDS }));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error).toMatchObject({ capability: 'sessionIntelligence' });
    expect(sent).toEqual([]);
  });

  it('carries a 409 session_unavailable refusal of the words as the typed refusal', async () => {
    const { client } = resident([...SERVER, 'sessionIntelligence'], () => jsonResponse({ contract: 'nika/session-host@1',
      frame: 'refused', session: '', error: 'session_unavailable',
      message: 'the intelligence `9 nowhere` is not one this machine reads' }, 409));
    const error = await failure(client.openSession({ intelligence: '9 nowhere' }));
    expect(error).toBeInstanceOf(NikaSessionRefusedError);
    expect(error).toMatchObject({ code: 'session_unavailable', status: 409 });
  });

  it('refuses an intelligence on attachSession before any request: a live Session keeps its own', async () => {
    const { client, sent } = resident([...SERVER, 'sessionIntelligence'], () => jsonResponse(opened('conversation'), 200));
    const error = await failure(client.attachSession(`ses_${'7a'.repeat(16)}`, { intelligence: WORDS }));
    expect(error).toBeInstanceOf(NikaConfigurationError);
    expect(sent).toEqual([]);
  });
});

describe('the selected intelligence\'s scope', () => {
  const frame = (scope: unknown) => ({ contract: 'nika/session-host@1', frame: 'opened', session: `ses_${'7a'.repeat(16)}`,
    event: 1, snapshot: { snapshot: `snp_${'1'.repeat(32)}`, seq: 1, busy: null, work: { contract: 'nika/session-work@0',
      root: '/srv/p', request: {}, authoring: null, waiting: { kind: 'free' }, candidate: null, saved: null,
      requested: null, run: null, rail: {}, intelligence: { author: { kind: 'deterministic' }, decision: null,
        effort: null, selected: { kind: 'api', via: 'deepseek', scope } } } } });

  it('is typed text, kept as written, and absent on older engines', () => {
    for (const scope of ['conversation', 'operator_default', 'a_later_word']) {
      expect(() => sessionFrame(frame(scope), 'http')).not.toThrow();
    }
    const older = frame('conversation');
    delete (older.snapshot.work.intelligence.selected as Record<string, unknown>).scope;
    expect(() => sessionFrame(older, 'http')).not.toThrow();
  });

  it('refuses a scope of another shape, naming its path', () => {
    expect(() => sessionFrame(frame(1), 'http')).toThrow(NikaProtocolError);
    expect(() => sessionFrame(frame(1), 'http')).toThrow(/work\.intelligence\.selected\.scope is not text/);
  });
});
