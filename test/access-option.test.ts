import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
  isNikaRunSucceeded,
} from '../src/index.js';
import type { NikaAccessPin, NikaCheckOptions, NikaRunEvent, NikaRunOptions } from '../src/index.js';
import {
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseText,
} from './helpers/http-depth-harness.js';

// NIK-267 · `access` on run() and check(), the engine's access pin on both doors:
//
//   local   nika run <file> --json --access=<pin>     nika check <file> --json --access=<pin>
//   server  POST /v1/jobs  {"workflow","access"}       POST /v1/check {"workflow","access"}
//
// The engine owns the pin's meaning, so a wrong value reaches it and comes back
// as its own refusal. The shapes below are the released engine 0.123.1
// (cc7b51964) as measured on 2026-10-26: its local captures are replayed from
// test/fixtures/run-wire, its server answers are written out where they are used.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const scratch: string[] = [];

afterEach(() => {
  delete process.env.NIKA_FAKE_ARGV_LOG;
  for (const file of scratch.splice(0)) rmSync(file, { force: true });
});

/** Every argv the engine fixture was spawned with during `action`, in order. */
async function spawned<T>(action: () => Promise<T>): Promise<{ result: T; argvs: string[][] }> {
  const log = path.join(tmpdir(), `nika-sdk-access-argv-${randomUUID()}`);
  scratch.push(log);
  process.env.NIKA_FAKE_ARGV_LOG = log;
  const result = await action();
  const argvs = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
    : [];
  return { result, argvs };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error('expected a refusal');
}

async function collect(events: AsyncIterable<NikaRunEvent>): Promise<NikaRunEvent[]> {
  const seen: NikaRunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/** Values neither door can carry unchanged: refused before a spawn or a request. */
const UNSENDABLE: Array<[string, unknown, RegExp]> = [
  ['a number', 3, /access must be a string naming an access class or a harness seat.*received a number$/],
  ['null', null, /received null$/],
  ['an array', ['codex'], /received an array$/],
  ['an object', { access: 'codex' }, /received an object$/],
  ['a NUL byte', 'co\0dex', /access contains a NUL byte, which no argv can carry$/],
  ['a lone surrogate', 'codex\ud800', /access contains a lone surrogate, which is not valid Unicode$/],
];

describe('access on a local engine', () => {
  const local = () => new Nika({ bin: ENGINE });

  it('passes the pin as one --access=<pin> element to check and run', async () => {
    const { result: report, argvs } = await spawned(() => local().check('flow.nika', { access: 'codex' }));
    // The fixture's report echoes the argv it was given.
    expect(report.argv).toEqual(['check', 'flow.nika', '--json', '--access=codex']);
    expect(argvs.at(-1)).toEqual(['check', 'flow.nika', '--json', '--access=codex']);

    const run = await local().run('flow.nika', { access: 'claude-code', model: 'anthropic/x' });
    const [first] = await collect(run.events());
    expect(first?.raw.argv).toEqual(['run', 'flow.nika', '--json', '--model', 'anthropic/x', '--access=claude-code']);
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('keeps a pin that starts with a dash a value, and sends an empty pin to the engine', async () => {
    // Measured on 0.123.1: `--access -x` is the parser's usage error (exit 2);
    // `--access=-x` and `--access=` reach the engine, which answers NIKA-1802.
    for (const pin of ['-x', '--json', '', '  ']) {
      const run = await local().run('flow.nika', { access: pin });
      const [first] = await collect(run.events());
      expect(first?.raw.argv).toEqual(['run', 'flow.nika', '--json', `--access=${pin}`]);
      await run.result();
    }
  });

  it('sends no flag without a pin', async () => {
    const report = await local().check('flow.nika');
    expect(report.argv).toEqual(['check', 'flow.nika', '--json']);
    const run = await local().run('flow.nika', {});
    const [first] = await collect(run.events());
    expect(first?.raw.argv).toEqual(['run', 'flow.nika', '--json']);
  });

  it.each(UNSENDABLE)('refuses %s before any engine process', async (_label, value, message) => {
    for (const [operation, call] of [
      ['run', () => local().run('flow.nika', { access: value } as unknown as NikaRunOptions)],
      ['check', () => local().check('flow.nika', { access: value } as unknown as NikaCheckOptions)],
    ] as const) {
      const { result: refusal, argvs } = await spawned(() => failure(call()));
      expect(refusal).toBeInstanceOf(NikaConfigurationError);
      expect((refusal as Error).message.startsWith(`${operation}({ access }): `)).toBe(true);
      expect((refusal as Error).message).toMatch(message);
      // Judged before the identity probe: not even `--sdk-identity` ran.
      expect(argvs).toEqual([]);
    }
  });

  it('released 0.123.1 · an unknown pin settles the run failed with NIKA-1802, cause refused', async () => {
    const run = await local().run('wire-01231-access1802.nika', { access: 'bogus-seat' });
    const events = await collect(run.events());
    // One frame: the engine refused before the prologue, with no task and no trace.
    expect(events.map((event) => [event.kind, event.status, event.error?.code])).toEqual([
      ['run.settled', 'failed', 'NIKA-1802'],
    ]);
    const result = await run.result();
    expect(isNikaRunSucceeded(result)).toBe(false);
    expect(result).toMatchObject({
      status: 'failed',
      transport: 'native-process',
      exitCode: 3,
      error: { code: 'NIKA-1802' },
      settlement: { status: 'failed', cause: 'refused' },
    });
    expect(result.error?.message).toContain('`--access bogus-seat` names neither an access class nor a known agentic CLI');
    expect(result.receipt).toBeUndefined();
    expect(result.diagnostics).toContain('nika run: NIKA-1802');
  });

  it('released 0.123.1 · a pin the model cannot use settles failed with NIKA-1801', async () => {
    const run = await local().run('wire-01231-access1801.nika', { access: 'local' });
    const result = await run.result();
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 3,
      error: { code: 'NIKA-1801' },
      settlement: { cause: 'refused' },
    });
    expect(result.error?.message).toContain('has no access path matching `--access local`');
  });

  it('types the known pins and still takes a word a later engine may add', () => {
    const pins: NikaAccessPin[] = ['mock', 'codex', 'claude-code', 'a-seat-from-a-later-engine'];
    const options: NikaRunOptions & NikaCheckOptions = { access: pins[0] };
    expect(options.access).toBe('mock');
  });
});

/** The resident's answers, as engine 0.123.1 wrote them (2026-10-26, loopback). */
const EMPTY_PIN = {
  error: {
    code: 'NIKA-1802',
    message: '`--access` is empty — a pin is a pin: name an access class or a known agentic CLI '
      + '(`nika doctor` lists every path)',
  },
};
const RECEIPT = {
  job_id: 'job-1',
  execution_id: 'exe-01a174c2-8d05-704c-9061-d267e4333e1f',
  trace_id: '01a174c28d05704c9061d267e4333e1f',
  snapshot_digest: 'a'.repeat(64),
  origin: { kind: 'manual' },
};
/** A pin the resident admitted (202) and its execution refused: no settlement, a code. */
const REFUSED_PIN_FRAMES = [
  'retry: 1000\n\n',
  'id: 1\ndata: {"sequence":1,"at":"2026-10-25T20:31:09.580946Z","kind":"execution.started","status":"running"}\n\n',
  `id: 2\ndata: ${JSON.stringify({
    sequence: 2,
    at: '2026-10-25T20:31:09.59727Z',
    kind: 'execution.settled',
    status: 'failed',
    code: 'NIKA-1802',
    message: '`--access bogus-seat` names neither an access class nor a known agentic CLI',
    receipt: RECEIPT,
  })}\n\n`,
].join('');
const ACK = { status: 'accepted', snapshot_digest: 'f'.repeat(64), root: 'daily.nika', units: 1 };

function remote(fetch: ReturnType<typeof vi.fn>): Nika {
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, fetch: fetch as typeof globalThis.fetch });
}

function posted(fetch: ReturnType<typeof vi.fn>, index: number): { url: string; body: unknown } {
  const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
  return { url: String(url), body: init.body };
}

describe('access on a nika serve', () => {
  it('rides JobByName.access by served name, after workflow and before inputs', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      if (route === '/health') {
        return healthResponse({
          supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs'],
        });
      }
      if (route === '/v1/jobs') {
        bodies.push(init?.body);
        return jsonResponse({ id: `job-${bodies.length}`, status: 'queued' }, 202);
      }
      const job = route.split('/')[3];
      return sseText(`id: 1\ndata: ${JSON.stringify({ sequence: 1, kind: 'execution.settled', status: 'succeeded',
        receipt: { ...RECEIPT, job_id: job } })}\n\n`);
    });
    const nika = remote(fetch);
    for (const options of [
      { idempotencyKey: 'k-1', access: 'codex' },
      { idempotencyKey: 'k-2', access: 'codex', inputs: { who: 'Ada' } },
      { idempotencyKey: 'k-3' },
    ]) {
      const run = await nika.run('daily.nika', options);
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
    }
    expect(bodies).toEqual([
      '{"workflow":"daily.nika","access":"codex"}',
      '{"workflow":"daily.nika","access":"codex","inputs":{"who":"Ada"}}',
      // Without a pin the request keeps the exact bytes it always had.
      '{"workflow":"daily.nika"}',
    ]);
  });

  it('released 0.123.1 · an empty pin is refused at admission: NikaOperationError NIKA-1802, 422', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(EMPTY_PIN, 422));
    const refusal = await failure(remote(fetch).run('daily.nika', { idempotencyKey: 'k-1', access: '' }));
    expect(refusal).toBeInstanceOf(NikaOperationError);
    expect(refusal).toMatchObject({
      operation: 'run',
      transport: 'http',
      code: 'NIKA-1802',
      machineCode: 'NIKA-1802',
      status: 422,
    });
    expect((refusal as Error).message).toContain('`--access` is empty — a pin is a pin');
    expect(posted(fetch, 1).body).toBe('{"workflow":"daily.nika","access":""}');
  });

  it('released 0.123.1 · a pin the execution refuses settles the job failed with the engine code', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
      .mockResolvedValueOnce(sseText(REFUSED_PIN_FRAMES));
    const run = await remote(fetch).run('daily.nika', { idempotencyKey: 'k-1', access: 'bogus-seat' });
    const events = await collect(run.events());
    expect(events.map((event) => [event.kind, event.status, event.error?.code])).toEqual([
      ['run.started', 'running', undefined],
      ['run.settled', 'failed', 'NIKA-1802'],
    ]);
    const result = await run.result();
    expect(result).toMatchObject({
      status: 'failed',
      transport: 'http',
      error: { code: 'NIKA-1802' },
      receipt: { job_id: 'job-1' },
    });
    expect(result.settlement).toBeUndefined();
  });

  it('rides CheckByName.access, and reads an empty pin\'s refusal as a red check', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(ACK))
      .mockResolvedValueOnce(jsonResponse(EMPTY_PIN, 422));
    const nika = remote(fetch);
    // The resident's check is source-only: it acknowledges a pin it does not judge.
    await expect(nika.check('daily.nika', { access: 'codex' })).resolves.toEqual({ clean: true, ...ACK });
    expect(posted(fetch, 1)).toEqual({
      url: 'https://nika.example/v1/check',
      body: '{"workflow":"daily.nika","access":"codex"}',
    });
    await expect(nika.check('daily.nika', { access: '' })).resolves.toEqual({
      clean: false,
      error: { code: 'NIKA-1802', message: EMPTY_PIN.error.message },
    });
  });

  it('refuses a pin beside a snapshot of a local file, before any capture or request', async () => {
    const fetch = vi.fn();
    const nika = new Nika({ url: 'https://nika.example', token: TOKEN_A, bin: ENGINE, fetch: fetch as typeof globalThis.fetch });
    for (const call of [
      () => nika.run('./flow.nika', { idempotencyKey: 'k-1', access: 'codex' }),
      () => nika.check('./flow.nika', { access: 'codex' }),
    ]) {
      const { result: refusal, argvs } = await spawned(() => failure(call()));
      expect(refusal).toBeInstanceOf(NikaCompatibilityError);
      expect(refusal).toMatchObject({ capability: 'snapshotAccess', transport: 'http' });
      expect((refusal as Error).message).toContain('served name (listWorkflows())');
      expect(argvs).toEqual([]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(UNSENDABLE)('refuses %s before any request', async (_label, value, message) => {
    const fetch = vi.fn();
    const nika = remote(fetch);
    for (const call of [
      () => nika.run('daily.nika', { idempotencyKey: 'k-1', access: value } as unknown as NikaRunOptions),
      () => nika.check('daily.nika', { access: value } as unknown as NikaCheckOptions),
    ]) {
      const refusal = await failure(call());
      expect(refusal).toBeInstanceOf(NikaConfigurationError);
      expect((refusal as Error).message).toMatch(message);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
