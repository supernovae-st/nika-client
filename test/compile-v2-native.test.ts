import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isNikaCompileHeld,
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
  NikaProtocolError,
  nextCompileRequest,
} from '../src/index.js';
import type { NikaCompileRequest } from '../src/index.js';

// The native half of generation 2: `nika compile --json` with the CLI's own
// flags (engine `crates/nika-cli-host/src/compile.rs::CompileArgs` and
// `AuthoringAuthority`), driven against the fixture engine, which refuses any
// argument the CLI does not declare the way clap does. No provider is called:
// the fixture only prints the documents a seated round would.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPILE_ENGINE = path.join(HERE, 'fixtures', 'fake-nika-compile.mjs');
const MODEL = 'mistral/mistral-small-latest';
const posix = process.platform !== 'win32';

let scratch: string;

function client(): Nika {
  return new Nika({ bin: COMPILE_ENGINE, cwd: scratch });
}

/** Every argv the fixture process was spawned with during `action`, in order. */
async function spawned<T>(action: () => Promise<T>): Promise<{ result: T; argvs: string[][] }> {
  const log = path.join(scratch, `argv-${Math.random().toString(16).slice(2)}.log`);
  process.env.NIKA_FAKE_ARGV_LOG = log;
  try {
    const result = await action();
    const argvs = existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
      : [];
    return { result, argvs };
  } finally {
    delete process.env.NIKA_FAKE_ARGV_LOG;
  }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a failure');
}

describe.skipIf(!posix)('native compile generation 2 (local authoring seat)', () => {
  beforeEach(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'nika-sdk-compile-v2-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("maps every seat field onto the CLI's own flags, values in the --name=value form", async () => {
    const { result, argvs } = await spawned(() => client().compile({
      intent: 'native-intent',
      authoringModel: MODEL,
      decisionModel: 'typesafe/jev-1.13.0',
      limits: { max_calls: 6, repairs: 0, max_tokens: 4096, call_timeout_ms: 90_000 },
      fresh: true,
      answers: { 'const.audience': 'team' },
    }));
    expect(argvs).toEqual([
      ['--sdk-identity'],
      ['compile', '--json', '--answer=const.audience="team"', `--authoring-model=${MODEL}`,
        '--decision-model=typesafe/jev-1.13.0', '--authoring-max-calls=6', '--authoring-repairs=0',
        '--authoring-max-tokens=4096', '--authoring-timeout=90', '--fresh', '--', 'native-intent'],
    ]);
    expect(result).toMatchObject({ compile_version: 1, status: 'ready', ready: true });
  });

  it('lets a revision seat a decision model beside its base, as the 0.123 engine takes it', async () => {
    const { result, argvs } = await spawned(() => client().compile({
      workflow: 'nika: w\n', change: 'Keep three days', original_intent: 'Keep two days',
      authoringModel: MODEL, decisionModel: 'typesafe/jev-1.13.0',
    }));
    expect(argvs).toHaveLength(2);
    const compile = argvs[1]!;
    expect(compile.slice(0, 4)).toEqual(['compile', '--json', `--authoring-model=${MODEL}`,
      '--decision-model=typesafe/jev-1.13.0']);
    expect(compile.slice(compile.indexOf('--base') + 2)).toEqual(['--change=Keep three days', '--', 'Keep two days']);
    expect(result).toMatchObject({ status: 'ready' });
  });

  it('reads a provider round: generation 2 with its receipt, a choice question and the requested trigger', async () => {
    const outcome = await client().compile({ intent: 'native-intent', authoringModel: MODEL });
    expect(outcome.compile_version).toBe(2);
    expect(outcome.status).toBe('incomplete');
    expect(outcome.provenance).toMatchObject({
      cognition: 'explicitProvider',
      strategy: 'native',
      suggested_file: 'morning-digest.nika',
      authoring: { model: MODEL, calls: 2, input_tokens: 1840, output_tokens: 912 },
    });
    expect(outcome.questions).toEqual([expect.objectContaining({
      key: 'const.audience', type: 'choice', options: [{ key: 'team', label: 'The whole team' }, { key: 'lead', label: 'The team lead only' }],
    })]);
    expect(outcome.requested_trigger).toMatchObject({ kind: 'schedule', cron: '0 9 * * *', status: 'requires_binding' });
    // Native outcomes never carry a replay token, and no destination was named.
    expect(outcome).not.toHaveProperty('replay_token');
    expect(outcome).not.toHaveProperty('written');
  });

  it('answers by repeating the intent with --answer: the seat stays, --fresh goes', async () => {
    const nika = client();
    const first: NikaCompileRequest = { intent: 'native-intent', authoringModel: MODEL, fresh: true, limits: { max_calls: 6 } };
    const round1 = await nika.compile(first);
    const next = nextCompileRequest(first, round1, { 'const.audience': 'team' });
    const { result: round2, argvs } = await spawned(() => nika.compile(next));
    expect(argvs.at(-1)).toEqual([
      'compile', '--json', '--answer=const.audience="team"', `--authoring-model=${MODEL}`,
      '--authoring-max-calls=6', '--', 'native-intent',
    ]);
    expect(round2).toMatchObject({ compile_version: 1, ready: true });
    expect(round2.candidate).toContain('audience: "team"');
  });

  it('keeps a held candidate a preview: incomplete, never ready', async () => {
    const outcome = await client().compile({ intent: 'held-intent', authoringModel: MODEL });
    expect(outcome).toMatchObject({ compile_version: 2, status: 'incomplete', ready: false });
    expect(isNikaCompileHeld(outcome)).toBe(true);
    expect(outcome.candidate).toBe('nika: held-digest\ntasks: {}\n');
    expect(outcome.provenance).not.toHaveProperty('plan');
  });

  it('records a decision seat as explicitDecision on generation 1', async () => {
    const { result, argvs } = await spawned(() => client().compile({
      intent: 'decision-intent', decisionModel: 'typesafe/jev-1.13.0',
    }));
    expect(argvs.at(-1)).toEqual(['compile', '--json', '--decision-model=typesafe/jev-1.13.0', '--', 'decision-intent']);
    expect(result).toMatchObject({ compile_version: 1, provenance: { cognition: 'explicitDecision', strategy: 'warm' } });
  });

  it('puts an edit revision\'s original intent in the positional beside --base', async () => {
    const base = 'nika: morning-digest\nconst: { audience: "team" }\n';
    const { result, argvs } = await spawned(() => client().compile({
      workflow: base,
      change: 'send it every Monday instead',
      original_intent: 'Every morning at 9, summarize ./inbox',
      authoringModel: MODEL,
    }));
    const args = argvs.at(-1)!;
    const basePath = args[args.indexOf('--base') + 1]!;
    expect(args).toEqual([
      'compile', '--json', `--authoring-model=${MODEL}`, '--base', basePath,
      '--change=send it every Monday instead', '--', 'Every morning at 9, summarize ./inbox',
    ]);
    expect(result.candidate).toContain('# original intent: Every morning at 9, summarize ./inbox');
    expect(existsSync(path.dirname(basePath))).toBe(false);
  });

  describe('output (--output)', () => {
    it('writes a ready candidate where the request names, and says so', async () => {
      const output = path.join(scratch, 'triage.nika');
      const { result, argvs } = await spawned(() => client().compile({
        intent: 'classify-and-route', answers: { 'const.request': 'outage' }, output,
      }));
      expect(argvs.at(-1)).toContain(`--output=${output}`);
      expect(result.written).toBe(output);
      expect(readFileSync(output, 'utf8')).toBe(result.candidate);
    });

    it('leaves an existing destination in place when the candidate is not ready', async () => {
      const output = path.join(scratch, 'triage.nika');
      writeFileSync(output, 'nika: kept\n');
      const result = await client().compile({ intent: 'classify-and-route', output });
      expect(result).toMatchObject({ status: 'incomplete', written: null, existing_destination: output });
      expect(readFileSync(output, 'utf8')).toBe('nika: kept\n');
    });

    it('refuses a written destination other than the one named', async () => {
      const error = await failure(client().compile({ intent: 'hostile-written-elsewhere', output: path.join(scratch, 'x.nika') }));
      expect(error).toBeInstanceOf(NikaProtocolError);
      expect(error.message).toMatch(/written destination other than/);
    });

    it('refuses an existing destination the request never named', async () => {
      const error = await failure(client().compile('hostile-existing-unasked'));
      expect(error).toBeInstanceOf(NikaProtocolError);
      expect(error.message).toMatch(/existing_destination names no destination/);
    });
  });

  it('surfaces the CLI\'s own record-keeping failures under .nika/compile/', async () => {
    const outcome = await client().compile('record-errors');
    expect(outcome.plan_record_error).toEqual({ path: '.nika/compile/abc.plan.json', message: 'Permission denied (os error 13)' });
    expect(outcome.declined_record_error).toEqual({ path: '.nika/compile/abc.declined.json', message: 'Permission denied (os error 13)' });
  });

  it.each([
    ['authority-refused', 'authoring_authority', 2],
    ['config-refused', 'authoring_config', 3],
  ])('maps the engine-stamped %s refusal (%s, exit %i) to NikaOperationError', async (intent, code, status) => {
    const error = await failure(client().compile({ intent, authoringModel: MODEL, limits: { max_calls: 2, repairs: 6 } }));
    expect(error).toBeInstanceOf(NikaOperationError);
    expect(error).toMatchObject({ operation: 'compile', transport: 'native-process', code, machineCode: code, status });
  });

  it('a CLI that predates a flag fails typed, quoting its own refusal', async () => {
    const error = await failure(client().compile('usage-unknown-flag'));
    expect(error).toBeInstanceOf(NikaProtocolError);
    expect(error.message).toMatch(/absent or malformed \(exit 2\): error: unexpected argument '--fresh' found/);
  });

  it.each([
    ['hostile-ready-held', NikaProtocolError, /verify_held or verify_resume marker/],
    ['hostile-v2-no-receipt', NikaProtocolError, /carries no provenance\.authoring receipt/],
    ['hostile-v1-receipt', NikaProtocolError, /compile_version 1 outcome carries a provider-call receipt/],
    ['hostile-future-version', NikaCompatibilityError, /compile wire 3; expected 1 or 2/],
  ])('refuses %s beside a seat', async (intent, errorClass, message) => {
    const error = await failure(client().compile({ intent, authoringModel: MODEL }));
    expect(error).toBeInstanceOf(errorClass);
    expect(error.message).toMatch(message);
  });

  it('accepts generation 2 only beside a seat', async () => {
    const error = await failure(client().compile('hostile-wrong-version'));
    expect(error).toBeInstanceOf(NikaCompatibilityError);
    expect(error.message).toMatch(/compile wire 2; expected 1$/);
  });

  it.each<[NikaCompileRequest, typeof NikaConfigurationError | typeof NikaCompatibilityError]>([
    [{ intent: 'native-intent', limits: { max_calls: 2 } }, NikaConfigurationError],
    [{ intent: 'native-intent', decisionModel: 'typesafe/jev-1.13.0', limits: { max_calls: 2 } }, NikaConfigurationError],
    [{ intent: 'native-intent', cognition: 'explicitProvider' }, NikaCompatibilityError],
    [{ intent: 'native-intent', workflow_id: 'digest' }, NikaCompatibilityError],
    [{ intent: 'native-intent', authoringModel: MODEL, limits: { deadline_ms: 60_000 } }, NikaCompatibilityError],
    [{ intent: 'native-intent', authoringModel: MODEL, limits: { call_timeout_ms: 2_500 } }, NikaCompatibilityError],
  ])('refuses %j with zero spawns', async (request, errorClass) => {
    const { result, argvs } = await spawned(() => failure(client().compile(request)));
    expect(result).toBeInstanceOf(errorClass);
    expect(argvs).toEqual([]);
  });
});
