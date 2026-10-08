import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import type {
  NikaAuthoringSession,
  NikaSessionAuthoringCalls,
  NikaSessionCandidateFile,
  NikaSessionIntelligence,
  NikaSessionWork,
} from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';
import { healthResponse, jsonResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// The work members a Session snapshot gained at the 0.123 integration
// (`1b47f34c0`): each candidate file's exact `content`, the compiler's
// `authoring.draft` and `authoring.calls` receipt, and the configured
// `intelligence`. The fixture's VALUES are synthetic, its shapes the
// producer's; recorded frames from the assembled binary join them once they
// exist. The SDK judges these members where they are and carries the rest.

const FIXTURE = fileURLToPath(new URL('./fixtures/session-host/work-1b47f34c0.json', import.meta.url));
const SESSION_ENGINE = fileURLToPath(new URL('./fixtures/fake-nika-session.mjs', import.meta.url));
const RECORDED = fileURLToPath(new URL('./fixtures/session-host/e849d08eaf37/native-answers.json', import.meta.url));
const rich = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { authoring: any; intelligence: any };
const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'ab'.repeat(16)}`;
const SECRET = 'sk-planted-secret-value-0123456789';
const CONTENT = '# Digest 🦋\nnika: digest\n# « Relevé — semaine »\ntasks: {}\n';
const WITNESS = 'b'.repeat(64);

function work(extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    contract: 'nika/session-work@0', root: '/srv/project', request: { goal: null, decisions: [], unresolved: [] },
    authoring: structuredClone(rich.authoring), intelligence: structuredClone(rich.intelligence),
    waiting: { kind: 'consent', proposal: 'p'.repeat(64) },
    candidate: { proposal: 'p'.repeat(64), aside: false, rehearsed: false, run_after_save: false, revision: null,
      files: [{ path: 'digest.nika', landing: 'create', workflow: true, bytes: WITNESS, replaces: null, audit: null,
        content: CONTENT }] },
    saved: null, requested: null, run: null,
    rail: { draft: 'working', saved: 'pending', checked: 'pending', active: 'pending', run: 'pending' },
    ...extra,
  };
}
const opened = (body: Record<string, any>) => ({ contract: CONTRACT, session: SESSION, frame: 'opened', event: 1,
  snapshot: { snapshot: `snp_${'0'.repeat(32)}`, seq: 1, busy: null, work: body }, notices: [] });

function refusal(body: Record<string, any>): NikaProtocolError {
  try {
    sessionFrame(opened(body), 'http');
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

describe('Session work members', () => {
  it('returns the engine\'s own work, every member kept exactly', () => {
    const frame = opened(work());
    const raw = JSON.stringify(frame);
    expect(sessionFrame(frame, 'http')).toBe(frame);
    expect(JSON.stringify(frame)).toBe(raw);
  });

  it('types the exact candidate bytes, the draft, the calls receipt and the configured intelligence', () => {
    const typed = (sessionFrame(opened(work()), 'native-process').snapshot as { work: NikaSessionWork }).work;
    const [file]: NikaSessionCandidateFile[] = typed.candidate!.files;
    expect(file!.content).toBe(CONTENT);
    expect(file!.bytes).toBe(WITNESS);
    expect(typed.authoring!.draft).toBe(CONTENT);
    const calls: NikaSessionAuthoringCalls = typed.authoring!.calls!;
    // Requested is what the calls asked for; the backend reports what answered; unknown usage stays null.
    expect([calls.requested_model, calls.input_tokens, calls.output_tokens, calls.backend?.observed_model])
      .toEqual(['claude-code/opus', null, null, 'claude-opus']);
    expect(calls.future_calls_member).toBe('kept');
    const intelligence: NikaSessionIntelligence = typed.intelligence!;
    expect(intelligence.selected).toMatchObject({ kind: 'harness', via: 'claude-code', transport: 'acp', model: null,
      ready: true });
    expect(intelligence.author).toEqual({ kind: 'harness', model: null, seat: 'claude-code', transport: 'acp', why: null });
    expect(intelligence.decision).toEqual({ model: 'typesafe/jev', refusal: null });
    expect(intelligence.effort).toBe('max');
    expect(intelligence.future_intelligence_member).toEqual({ additive: true });
  });

  it('keeps explicit null apart from absence', () => {
    const body = work({ intelligence: { author: { kind: 'deterministic', model: null, seat: null, transport: null,
      why: 'no selection: the deterministic reading prepares' }, selected: null, decision: null, effort: null } });
    body.authoring.calls = null;
    body.authoring.draft = null;
    body.authoring.candidate = null;
    const typed = (sessionFrame(opened(body), 'http').snapshot as { work: NikaSessionWork }).work;
    expect(typed.authoring).toMatchObject({ calls: null, draft: null, candidate: null });
    expect(typed.intelligence).toMatchObject({ selected: null, decision: null, effort: null });
    const absent = work();
    delete absent.intelligence;
    delete absent.authoring.calls;
    delete absent.candidate.files[0].content;
    const old = (sessionFrame(opened(absent), 'http').snapshot as { work: NikaSessionWork }).work;
    expect('intelligence' in old).toBe(false);
    expect('calls' in old.authoring!).toBe(false);
    expect('content' in old.candidate!.files[0]!).toBe(false);
  });

  it('decodes every frame the host recorded before these members, unchanged', () => {
    const frames = JSON.parse(readFileSync(RECORDED, 'utf8')) as Record<string, any>[];
    for (const frame of frames) {
      const raw = JSON.stringify(frame);
      expect(sessionFrame(frame, 'native-process')).toBe(frame);
      expect(JSON.stringify(frame)).toBe(raw);
      if (frame.snapshot?.work) expect('intelligence' in frame.snapshot.work).toBe(false);
    }
  });

  const malformed: [string, (body: Record<string, any>) => void, RegExp][] = [
    ['candidate files as an object', (b) => { b.candidate.files = {}; }, /work\.candidate\.files is not a list/],
    ['a candidate without its files', (b) => { delete b.candidate.files; }, /work\.candidate\.files is absent/],
    ['a file that is not an object', (b) => { b.candidate.files = ['digest.nika']; },
      /work\.candidate\.files\[0\] is not an object/],
    ['a file without its path', (b) => { delete b.candidate.files[0].path; }, /work\.candidate\.files\[0\]\.path is absent/],
    ['a witness that is not hex', (b) => { b.candidate.files[0].bytes = SECRET; },
      /work\.candidate\.files\[0\]\.bytes is not a witness/],
    ['content as a list of lines', (b) => { b.candidate.files[0].content = ['nika: digest']; },
      /work\.candidate\.files\[0\]\.content is not text/],
    ['a replaced witness that is not hex', (b) => { b.candidate.files[0].replaces = 'old'; },
      /work\.candidate\.files\[0\]\.replaces is neither a witness nor null/],
    ['a workflow flag as text', (b) => { b.candidate.files[0].workflow = 'yes'; },
      /work\.candidate\.files\[0\]\.workflow is not a boolean/],
    ['an authoring witness that is not hex', (b) => { b.authoring.candidate = SECRET; },
      /work\.authoring\.candidate is neither a witness nor null/],
    ['a draft as a number', (b) => { b.authoring.draft = 7; }, /work\.authoring\.draft is neither text nor null/],
    ['calls as a list', (b) => { b.authoring.calls = []; }, /work\.authoring\.calls is not an object/],
    ['calls without the requested model', (b) => { delete b.authoring.calls.requested_model; },
      /work\.authoring\.calls\.requested_model is absent/],
    ['a negative call count', (b) => { b.authoring.calls.calls = -1; }, /work\.authoring\.calls\.calls is not a count/],
    ['unknown usage written as text', (b) => { b.authoring.calls.input_tokens = 'unknown'; },
      /work\.authoring\.calls\.input_tokens is neither a count nor null/],
    ['a fractional elapsed time', (b) => { b.authoring.calls.elapsed_ms = 1.5; },
      /work\.authoring\.calls\.elapsed_ms is not a count/],
    ['a backend as text', (b) => { b.authoring.calls.backend = 'acp'; }, /work\.authoring\.calls\.backend is not an object/],
    ['intelligence as text', (b) => { b.intelligence = 'claude'; }, /work\.intelligence is not an object/],
    ['intelligence without its author', (b) => { delete b.intelligence.author; }, /work\.intelligence\.author is absent/],
    ['an author without its kind', (b) => { delete b.intelligence.author.kind; },
      /work\.intelligence\.author\.kind is absent/],
    ['an author model as a number', (b) => { b.intelligence.author.model = 4; },
      /work\.intelligence\.author\.model is neither text nor null/],
    ['a selection whose readiness is text', (b) => { b.intelligence.selected.ready = 'true'; },
      /work\.intelligence\.selected\.ready is not a boolean/],
    ['a selection without its kind', (b) => { delete b.intelligence.selected.kind; },
      /work\.intelligence\.selected\.kind is absent/],
    ['a decision seat without its model', (b) => { delete b.intelligence.decision.model; },
      /work\.intelligence\.decision\.model is absent/],
    ['an effort as a number', (b) => { b.intelligence.effort = 3; }, /work\.intelligence\.effort is neither text nor null/],
  ];
  it.each(malformed)('refuses %s as a protocol fault naming its path, never its value', (_name, mutate, message) => {
    const body = work();
    mutate(body);
    const error = refusal(body);
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});

describe('Session work members over both doors', () => {
  const opened: NikaAuthoringSession[] = [];
  afterEach(async () => {
    for (const session of opened.splice(0)) await session.close().catch(() => {});
    delete process.env.NIKA_FAKE_SESSION_WORK;
  });

  it('carries the same members natively and over HTTP', async () => {
    process.env.NIKA_FAKE_SESSION_WORK = FIXTURE;
    const local = await new Nika({ bin: SESSION_ENGINE }).openSession();
    opened.push(local);
    const proposed = await local.submit(local.opened!.snapshot, 'draft a digest');
    const nativeWork = proposed.snapshot.work;
    const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const { pathname } = new URL(String(url));
      if (pathname === '/health') {
        return healthResponse({ engineVersion: '0.123.0', supportedCapabilities: ['check', 'executionSnapshot',
          'eventStream', 'cancel', 'jobInputs', 'compile', 'sessionHost'] });
      }
      if (pathname === '/v1/sessions' && init.method === 'POST') {
        return jsonResponse({ contract: CONTRACT, session: SESSION, frame: 'opened', event: 1, notices: [],
          snapshot: { snapshot: `snp_${'0'.repeat(32)}`, seq: 1, busy: null, work: nativeWork } }, 201);
      }
      throw new Error(`unexpected ${init.method ?? 'GET'} ${pathname}`);
    });
    const remote = await new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: '/there-is-no-local-engine', fetch })
      .openSession();
    const remoteWork = remote.opened!.snapshot.work;
    expect(remoteWork).toEqual(nativeWork);
    expect(nativeWork.candidate!.files[0]!.content).toBe(CONTENT);
    expect(nativeWork.authoring!.calls!.requested_model).toBe('claude-code/opus');
    expect(nativeWork.intelligence!.author.kind).toBe('harness');
  });

  it('refuses a malformed member on the native door', async () => {
    const broken = structuredClone(rich);
    broken.intelligence.author.kind = 4;
    const file = path.join(tmpdir(), `nika-sdk-broken-work-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(broken));
    try {
      process.env.NIKA_FAKE_SESSION_WORK = file;
      await expect(new Nika({ bin: SESSION_ENGINE }).openSession()).rejects
        .toThrow(/work\.intelligence\.author\.kind is not text/);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
