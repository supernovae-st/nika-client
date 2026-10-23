import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaProtocolError, nextCompileRequest } from '../src/index.js';
import { MACHINE_PROTOCOL_VERSION } from '../src/lib/engine-identity.js';
import { TOKEN_A, jsonResponse, sseText } from './helpers/http-depth-harness.js';

// Machine protocol 2, decoded from the bytes a real engine wrote. Recorded on
// 2026-10-23 from `nika 0.123.0-preview.1 (5342f8a43)`, supernovae-st/nika main
// at nika#1814 (binary sha256 85718d3545dc…), keyless: a fresh project and HOME,
// NIKA_KEYCHAIN=off, loopback only, `mock/echo`, no provider.
//
//   sdk-identity.stdout          `nika --sdk-identity`
//   health.json                  `GET /health` of a plain `nika serve --bind`
//   compile-scheduled.stdout     `nika compile --json -- <INTENT>` (exit 2)
//   compile-scheduled.http.json  `POST /v1/compile` of the same intent, generation 1 (200)
//   catch-up-job.json            `GET /v1/jobs/{id}` of a `catch-up-once` firing
//   catch-up-events.sse          `GET /v1/jobs/{id}/events` of the same job
//
// The catch-up job: schedule `TZ=UTC * * * * *` with `missed: catch-up-once`,
// fired on time once, then the resident was down for two slots and restarted.
// `sdk-identity-0.122.0.stdout` is `nika --sdk-identity` of the released 0.122.0
// macOS arm64 binary (`nika 0.122.0 (5660e683f)`, sha256 da7950d43e38…): machine
// protocol 1. A replay proves the SDK decodes these bytes, never that a later
// engine still writes them: a new engine needs a new capture.

const FIXTURES = fileURLToPath(new URL('./fixtures/engine-0123/', import.meta.url));
const INTENT = 'Every Monday at 9am summarize the support queue into ./digest.md';
const URL_BASE = 'https://nika.example';

const text = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const json = (name: string) => JSON.parse(text(name)) as Record<string, any>;
const IDENTITY = json('sdk-identity.stdout');
const IDENTITY_0122 = json('sdk-identity-0.122.0.stdout');
const HEALTH = json('health.json');
const NATIVE_COMPILE = json('compile-scheduled.stdout');
const HTTP_COMPILE = json('compile-scheduled.http.json');
const JOB = json('catch-up-job.json');
const EVENTS = text('catch-up-events.sse');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A local engine that replays one recorded identity and one recorded compile. */
function engine(identity: string, compile: string, compileExit = 2) {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-0123-wire-'));
  roots.push(root);
  const log = path.join(root, 'argv.log');
  writeFileSync(path.join(root, 'identity.stdout'), identity);
  writeFileSync(path.join(root, 'compile.stdout'), compile);
  const bin = path.join(root, 'nika');
  writeFileSync(bin, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const replay = (name, code) => {
  process.stdout.write(readFileSync(${JSON.stringify(root)} + '/' + name));
  process.exitCode = code;
};
if (argv[0] === '--sdk-identity') replay('identity.stdout', 0);
else if (argv[0] === 'compile') replay('compile.stdout', ${compileExit});
else process.exitCode = 3;
`);
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
    .map((line) => JSON.parse(line) as string[]);
  return { bin, calls };
}

/** A resident that answers each route from a recorded body. */
function resident(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input));
    const route = routes[pathname];
    if (!route) throw new Error(`unexpected request ${pathname}`);
    return route();
  });
}

function remote(fetch: ReturnType<typeof resident>): Nika {
  return new Nika({ url: URL_BASE, token: TOKEN_A, fetch: fetch as unknown as typeof globalThis.fetch });
}

/** The fields of a compile document the SDK keeps, with its own `ready`. */
function outcomeOf(document: Record<string, any>) {
  const { written: _written, ...kept } = document;
  return { ...kept, ready: document.status === 'ready' };
}

describe('the 0.123 identity speaks machine protocol 2', () => {
  it('is the generation this SDK speaks, on both doors', async () => {
    expect(MACHINE_PROTOCOL_VERSION).toBe(2);
    expect(IDENTITY.machineProtocolVersion).toBe(MACHINE_PROTOCOL_VERSION);
    expect(HEALTH.machineProtocolVersion).toBe(MACHINE_PROTOCOL_VERSION);

    const local = engine(text('sdk-identity.stdout'), text('compile-scheduled.stdout'));
    await expect(new Nika({ bin: local.bin }).compile(INTENT)).resolves.toMatchObject({ status: 'incomplete' });
    expect(local.calls().map((argv) => argv[0])).toEqual(['--sdk-identity', 'compile']);

    const fetch = resident({
      '/health': () => jsonResponse(HEALTH),
      '/v1/compile': () => jsonResponse(HTTP_COMPILE),
    });
    await expect(remote(fetch).compile(INTENT)).resolves.toMatchObject({ status: 'incomplete' });
  });

  it('refuses the released 0.122.0 engine at identity, before anything else is spawned', async () => {
    expect(IDENTITY_0122.machineProtocolVersion).toBe(1);
    const local = engine(text('sdk-identity-0.122.0.stdout'), text('compile-scheduled.stdout'));
    const refused = new Nika({ bin: local.bin }).compile(INTENT);
    await expect(refused).rejects.toBeInstanceOf(NikaCompatibilityError);
    await expect(refused).rejects.toMatchObject({
      capability: 'engineIdentity',
      transport: 'native-process',
      message: expect.stringContaining('Engine 0.122.0 machine protocol 1 is incompatible with SDK protocol 2'),
    });
    expect(local.calls()).toEqual([['--sdk-identity']]);
  });

  it.each([1, 3])('refuses a resident on machine protocol %i after GET /health alone', async (generation) => {
    const health = () => jsonResponse({ ...HEALTH, machineProtocolVersion: generation });
    const refusal = {
      name: 'NikaCompatibilityError',
      capability: 'engineIdentity',
      transport: 'http',
      message: expect.stringContaining(`machine protocol ${generation} is incompatible with SDK protocol 2`),
    };
    const running = resident({ '/health': health });
    await expect(remote(running).run('hello.nika', { idempotencyKey: 'protocol-gate' }))
      .rejects.toMatchObject(refusal);
    const compiling = resident({ '/health': health });
    await expect(remote(compiling).compile(INTENT)).rejects.toMatchObject(refusal);
    for (const fetch of [running, compiling]) {
      expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/health']);
    }
  });
});

describe('a compile choice question, as engine 0.123 writes it', () => {
  it('reads the same choices on the local engine and the resident', async () => {
    const local = engine(text('sdk-identity.stdout'), text('compile-scheduled.stdout'));
    const native = await new Nika({ bin: local.bin }).compile(INTENT);
    expect(native).toEqual(outcomeOf(NATIVE_COMPILE));

    const fetch = resident({
      '/health': () => jsonResponse(HEALTH),
      '/v1/compile': () => jsonResponse(HTTP_COMPILE),
    });
    const http = await remote(fetch).compile(INTENT);
    expect(http).toEqual(outcomeOf(HTTP_COMPILE));

    for (const outcome of [native, http]) {
      expect(outcome).toMatchObject({ compile_version: 1, status: 'incomplete', ready: false, candidate: null });
      expect(outcome.questions.map((question) => [question.key, question.type, question.mandatory])).toEqual([
        ['model', 'text', true],
        ['trigger.timezone', 'text', false],
        ['trigger.missed', 'choice', false],
        ['trigger.overlap', 'choice', false],
        ['trigger.ceiling', 'literal', false],
      ]);
      const choices = Object.fromEntries(outcome.questions
        .filter((question) => question.type === 'choice')
        .map((question) => [question.key, question.options?.map((option) => option.key)]));
      expect(choices).toEqual({
        'trigger.missed': ['rattraper', 'rattraper-une-fois', 'sauter'],
        'trigger.overlap': ['sauter', 'file', 'remplacer'],
      });
      expect(outcome.questions.filter((question) => question.type !== 'choice')
        .every((question) => !('options' in question))).toBe(true);
      expect(outcome.requested_trigger).toMatchObject({
        kind: 'schedule', status: 'requires_binding', cron: '0 9 * * 1', missed: null, overlap: null,
      });
    }
    // The doors differ only where the engine does: a local compile observes its own files.
    expect(native.questions).toEqual(http.questions);
    expect(native.requested_trigger).toEqual(http.requested_trigger);
    expect(native.diagnostics).toEqual(http.diagnostics);
    expect(native.provenance.plan).toHaveProperty('observed_world');
    expect(http.provenance.plan).not.toHaveProperty('observed_world');
  });

  it('answers a choice with the key of one of its options', async () => {
    const fetch = resident({
      '/health': () => jsonResponse(HEALTH),
      '/v1/compile': () => jsonResponse(HTTP_COMPILE),
    });
    const outcome = await remote(fetch).compile(INTENT);
    const missed = outcome.questions.find((question) => question.key === 'trigger.missed');
    expect(missed?.options?.[1]).toEqual({ key: 'rattraper-une-fois', label: 'fire one catch-up for the whole silence' });
    expect(nextCompileRequest(INTENT, outcome, { [missed!.key]: missed!.options![1]!.key })).toEqual({
      intent: INTENT,
      answers: { 'trigger.missed': 'rattraper-une-fois' },
    });
  });

  const malformed: Array<[string, (questions: any[]) => void, string]> = [
    ['a choice without options', (questions) => { delete questions[2].options; },
      'a choice question carries no options to choose from'],
    ['a choice with an empty option list', (questions) => { questions[2].options = []; },
      'a choice question carries no options to choose from'],
    ['options on a text question', (questions) => { questions[0].options = [{ key: 'mock/echo', label: 'echo' }]; },
      'a text question carries options, which only a choice has'],
    ['options on a literal question', (questions) => { questions[4].options = [{ key: '1', label: 'one dollar' }]; },
      'a literal question carries options, which only a choice has'],
    ['an option without its label', (questions) => { delete questions[3].options[0].label; },
      'a question\'s options lack their key/label shape'],
  ];

  it.each(malformed)('refuses %s on the local engine', async (_name, mutate, reason) => {
    const document = structuredClone(NATIVE_COMPILE);
    mutate(document.questions);
    const local = engine(text('sdk-identity.stdout'), JSON.stringify(document));
    const refused = new Nika({ bin: local.bin }).compile(INTENT);
    await expect(refused).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(refused).rejects.toThrow(reason);
  });

  it.each(malformed)('refuses %s from a resident', async (_name, mutate, reason) => {
    const document = structuredClone(HTTP_COMPILE);
    mutate(document.questions);
    const fetch = resident({
      '/health': () => jsonResponse(HEALTH),
      '/v1/compile': () => jsonResponse(document),
    });
    const refused = remote(fetch).compile(INTENT);
    await expect(refused).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(refused).rejects.toThrow(reason);
  });
});

describe('a catch-up-once firing names the silence it answers for', () => {
  const id = JOB.id as string;
  const origin = JOB.receipt.origin as Record<string, unknown>;

  /** The recorded job and its stream, both carrying this receipt origin. */
  function recorded(changed: Record<string, unknown> = origin) {
    const job = structuredClone(JOB);
    job.receipt.origin = changed;
    const settled = EVENTS.split('\n').find((line) => line.includes('"execution.settled"'))!;
    const frame = JSON.parse(settled.slice('data: '.length));
    frame.receipt.origin = changed;
    return resident({
      '/health': () => jsonResponse(HEALTH),
      [`/v1/jobs/${id}`]: () => jsonResponse(job),
      [`/v1/jobs/${id}/events`]: () => sseText(EVENTS.replace(settled, `data: ${JSON.stringify(frame)}`)),
    });
  }

  it('reads the origin the 0.123 resident wrote on the durable job and its terminal frame', async () => {
    expect(origin).toMatchObject({
      kind: 'schedule', decision: 'catch_up', scheduled_for: '2026-10-23T13:17:00Z',
      missed_first: '2026-10-23T13:16:00Z', missed_count: 2,
    });
    const run = await remote(recorded()).attachRun(id);
    const kinds: string[] = [];
    for await (const event of run.events()) kinds.push(event.kind);
    expect(kinds).toEqual(['engine.event', 'run.settled']);
    const result = await run.result();
    expect(result.status).toBe('succeeded');
    expect(result.outputs).toEqual({ greeting: 'mock(echo) · beat' });
    expect(result.receipt).toEqual(JOB.receipt);
    expect(result.receipt?.origin).toEqual(origin);
  });

  it('reads a silence of one slot, whose first slot is the slot fired', async () => {
    const single = { ...origin, missed_first: origin.scheduled_for, missed_count: 1 };
    const result = await (await remote(recorded(single)).attachRun(id)).result();
    expect(result.receipt?.origin).toEqual(single);
  });

  it.each<[string, Record<string, unknown>]>([
    ['missed_first alone', { ...origin, missed_count: undefined }],
    ['missed_count alone', { ...origin, missed_first: undefined }],
    ['a silence on an on-time firing', { ...origin, decision: 'scheduled' }],
    ['an empty silence', { ...origin, missed_count: 0 }],
    ['a fractional count', { ...origin, missed_count: 1.5 }],
    ['a count as text', { ...origin, missed_count: '2' }],
    ['a count past u32', { ...origin, missed_count: 2 ** 32 }],
    ['a first slot that is not an instant', { ...origin, missed_first: 'yesterday' }],
    ['a first slot after the slot fired', { ...origin, missed_first: '2026-10-23T13:18:00Z' }],
    ['a member the contract does not name', { ...origin, missed_last: '2026-10-23T13:17:00Z' }],
  ])('refuses %s', async (_name, changed) => {
    const defined = Object.fromEntries(Object.entries(changed).filter(([, value]) => value !== undefined));
    const attached = remote(recorded(defined)).attachRun(id);
    await expect(attached).rejects.toBeInstanceOf(NikaProtocolError);
    await expect(attached).rejects.toThrow('Scheduled receipt origin was malformed');
  });
});
