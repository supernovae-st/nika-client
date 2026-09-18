import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
} from '../src/index.js';
import type { NikaLocalConfig, NikaRunOptions } from '../src/index.js';
import { LITERAL_INPUTS_MAX_BYTES, encodeLiteralInputs } from '../src/lib/literal-inputs.js';

// Issue #116 · the native half of `run({ inputs })` (engine nika#1683):
//
//   inputs ─▶ strict JSON ─▶ capability `inputsLiteral`? ─▶ spawn
//     run <file> --json --inputs-json -     values on stdin, never argv
//
// No capability means a typed refusal before any run is spawned. There is no
// `--var` fallback: `--var` reads `@env:` and coerces by declared type.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LITERAL_ENGINE = path.join(HERE, 'fixtures', 'fake-nika-inputs.mjs');
/** `fake-nika.mjs` advertises no `inputsLiteral`: an engine from before the channel. */
const OLD_ENGINE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';
const SECRET_LOOKING = 'sk-live-never-in-argv-7f6394fc';

const stray: unknown[] = [];
const onStray = (reason: unknown) => {
  stray.push(reason);
};
const scratch: string[] = [];

function literal(overrides: Omit<NikaLocalConfig, 'bin'> = {}): Nika {
  return new Nika({ bin: LITERAL_ENGINE, ...overrides });
}

function scratchFile(label: string): string {
  const file = path.join(tmpdir(), `nika-sdk-inputs-${label}-${randomUUID()}`);
  scratch.push(file);
  return file;
}

/** Every argv the engine fixture was spawned with during `action`, in order. */
async function spawned<T>(action: () => Promise<T>): Promise<{ result: T; argvs: string[][] }> {
  const log = scratchFile('argv');
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

async function failure(promise: Promise<unknown>): Promise<unknown> {
  let admitted: unknown;
  try {
    admitted = await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error(`expected a refusal, run() resolved ${JSON.stringify(admitted)}`);
}

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

describe.skipIf(!posix)('native literal inputs (issue #116 · engine #1683)', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onStray);
    process.on('uncaughtException', onStray);
  });
  afterEach(async () => {
    await settle(50);
    process.off('unhandledRejection', onStray);
    process.off('uncaughtException', onStray);
    for (const file of scratch.splice(0)) rmSync(file, { force: true });
    expect(stray).toEqual([]);
  });

  describe('the wire', () => {
    it('spawns run with `--inputs-json -` and writes exactly the serialized map to stdin', async () => {
      const inputs = {
        ticket: '@env:SERVER_SECRET',
        expression: '${{ tasks.x.output }}',
        numeral: '42',
        count: 42,
        tags: ['é', '東京'],
        record: { name: '🦋', nothing: null },
      };
      const { result, argvs } = await spawned(async () => {
        const run = await literal().run('echo-literal.nika.yaml', { inputs });
        return run.result();
      });
      expect(argvs).toEqual([
        ['--sdk-identity'],
        ['run', 'echo-literal.nika.yaml', '--json', '--inputs-json', '-'],
      ]);
      expect(result.status).toBe('succeeded');
      const expected = encodeLiteralInputs(inputs);
      expect(result.outputs).toEqual({
        stdin_kind: expect.stringMatching(/^(socket|fifo)$/),
        stdin_bytes: expected.bytes,
        stdin_sha256: createHash('sha256').update(expected.json).digest('hex'),
        stdin: expected.json,
      });
      // The engine reads the caller's values back, types intact and text literal.
      expect(JSON.parse((result.outputs as { stdin: string }).stdin)).toEqual(inputs);
    });

    it('keeps a value out of argv: the map rides stdin only', async () => {
      const { argvs } = await spawned(async () => {
        const run = await literal().run('echo-secret.nika.yaml', {
          inputs: { apiKey: SECRET_LOOKING, nested: { token: SECRET_LOOKING } },
          model: 'mock/echo',
          maxCostUsd: 0.01,
        });
        return run.result();
      });
      expect(argvs.at(-1)).toEqual([
        'run', 'echo-secret.nika.yaml', '--json', '--inputs-json', '-',
        '--model', 'mock/echo', '--max-cost-usd', '0.01',
      ]);
      expect(JSON.stringify(argvs)).not.toContain(SECRET_LOOKING);
      expect(JSON.stringify(argvs)).not.toContain('apiKey');
    });

    it('sends an empty map as the explicit empty object, not as an absent channel', async () => {
      const { result, argvs } = await spawned(async () => {
        const run = await literal().run('echo-empty.nika.yaml', { inputs: {} });
        return run.result();
      });
      expect(argvs.at(-1)).toEqual(['run', 'echo-empty.nika.yaml', '--json', '--inputs-json', '-']);
      expect(result.outputs).toMatchObject({ stdin: '{}', stdin_bytes: 2 });
    });

    it('delivers a map of exactly 1 MiB whole: no newline, no truncation', async () => {
      const shell = '{"blob":""}'.length;
      const inputs = { blob: 'é'.repeat((LITERAL_INPUTS_MAX_BYTES - shell - 1) / 2) + 'x' };
      const expected = encodeLiteralInputs(inputs);
      expect(expected.bytes).toBe(LITERAL_INPUTS_MAX_BYTES);
      const run = await literal().run('echo-exact-bound.nika.yaml', { inputs });
      const result = await run.result();
      expect(result.outputs).toEqual({
        stdin_kind: expect.stringMatching(/^(socket|fifo)$/),
        stdin_bytes: LITERAL_INPUTS_MAX_BYTES,
        stdin_sha256: createHash('sha256').update(expected.json).digest('hex'),
      });
    });

    it('opens no stdin pipe and adds no flag for a run without inputs', async () => {
      const { result, argvs } = await spawned(async () => {
        const run = await literal().run('echo-plain.nika.yaml');
        return run.result();
      });
      expect(argvs.at(-1)).toEqual(['run', 'echo-plain.nika.yaml', '--json']);
      expect(result.outputs).toMatchObject({ stdin_kind: 'character-device', stdin_bytes: 0 });
    });

    it('reads the measured admitted run: outputs and api-caller origins ride through', async () => {
      const client = literal();
      const run = await client.run('wire-c1683-literal.nika.yaml', {
        inputs: { ticket: '@env:NIKA_TEST_LITERAL', count: 42, tags: ['é', '東京'], record: { name: '🦋' } },
      });
      // The Run owns its lifecycle. Provenance is an engine fact, so it is read
      // from the protocol frame each lifecycle event keeps, untouched, on `raw`.
      const events = [];
      for await (const event of run.events()) events.push(event);
      expect(events.map((event) => event.kind)).toEqual([
        'run.started', 'task.scheduled', 'task.started', 'engine.event',
        'task.completed', 'engine.event', 'run.settled',
      ]);
      const started = events[0]!.raw as { kind: string; fields: { key: string; value: unknown }[] };
      expect(started.kind).toBe('workflow_started');
      const origins = started.fields.find((row) => row.key === 'inputs')?.value;
      expect(JSON.parse(String(origins))).toEqual({
        count: 'api-caller',
        record: 'api-caller',
        region: 'file',
        tags: 'api-caller',
        ticket: 'api-caller',
      });
      await expect(run.result()).resolves.toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        outputs: {
          value: {
            count: 42,
            record: { name: '🦋' },
            region: 'eu',
            tags: ['é', '東京'],
            ticket: '@env:NIKA_TEST_LITERAL',
          },
        },
      });
    });
  });

  describe('an engine without the channel is refused before any run', () => {
    it('rejects with the missing capability and the evidence it read', async () => {
      const { result, argvs } = await spawned(() => failure(
        new Nika({ bin: OLD_ENGINE }).run('ok.nika.yaml', { inputs: { ticketId: '42' } }),
      ));
      expect(result).toBeInstanceOf(NikaCompatibilityError);
      expect(result).toMatchObject({
        name: 'NikaCompatibilityError',
        capability: 'inputsLiteral',
        transport: 'native-process',
      });
      const message = (result as Error).message;
      expect(message).toContain('inputsLiteral');
      expect(message).toContain('0.114.0');
      expect(message).toContain('check, executionSnapshot, eventStream, trace');
      // Negotiation only: no run was spawned, so nothing could be admitted.
      expect(argvs).toEqual([['--sdk-identity']]);
    });

    it('never falls back to --var, even for values --var could spell', async () => {
      const { argvs } = await spawned(() => failure(
        new Nika({ bin: OLD_ENGINE }).run('ok.nika.yaml', { inputs: { locale: 'fr-FR', n: 1 } }),
      ));
      expect(argvs.flat()).not.toContain('--var');
      expect(argvs.flat()).not.toContain('run');
    });

    it('refuses an empty map too: a present map is the channel', async () => {
      const refused = await failure(new Nika({ bin: OLD_ENGINE }).run('ok.nika.yaml', { inputs: {} }));
      expect(refused).toMatchObject({ name: 'NikaCompatibilityError', capability: 'inputsLiteral' });
    });

    it('still runs that engine without inputs, and with the deprecated vars alias', async () => {
      const { result, argvs } = await spawned(async () => {
        const client = new Nika({ bin: OLD_ENGINE });
        const plain = await (await client.run('ok.nika.yaml')).result();
        const aliased = await (await client.run('ok.nika.yaml', {
          vars: { locale: 'fr-FR', retries: 3, dry: false },
        })).result();
        return [plain.status, aliased.status];
      });
      expect(result).toEqual(['succeeded', 'succeeded']);
      expect(argvs.at(-1)).toEqual([
        'run', 'ok.nika.yaml', '--json',
        '--var', 'locale=fr-FR', '--var', 'retries=3', '--var', 'dry=false',
      ]);
    });
  });

  describe('a map the SDK cannot send is refused before the engine is touched', () => {
    const blob = 'x'.repeat(LITERAL_INPUTS_MAX_BYTES);
    it.each<[string, NikaRunOptions, RegExp]>([
      ['inputs beside vars', { inputs: { a: 1 }, vars: { a: 1 } }, /inputs and the deprecated vars/],
      ['undefined', { inputs: { a: undefined } }, /inputs\.a is undefined/],
      ['a bigint', { inputs: { a: 1n } }, /inputs\.a is a bigint/],
      ['a non-finite number', { inputs: { a: Number.NaN } }, /inputs\.a is a non-finite number/],
      ['a class instance', { inputs: { at: new Date(0) } }, /inputs\.at is a Date instance/],
      ['a map over 1 MiB', { inputs: { blob } }, /exceeds 1048576 bytes/],
      ['a root that is not a map', { inputs: [] as unknown as Record<string, unknown> }, /must be a plain object/],
    ])('refuses %s', async (_name, options, message) => {
      const { result, argvs } = await spawned(() => failure(literal().run('echo.nika.yaml', options)));
      expect(result).toBeInstanceOf(NikaConfigurationError);
      expect((result as Error).message).toMatch(message);
      // Not even the identity probe ran: the caller's mistake needs no engine.
      expect(argvs).toEqual([]);
    });
  });

  describe('the engine judges the map: its refusal rejects run() with its code', () => {
    it.each([
      ['an undeclared key', 'wire-c1683-unknown-input.nika.yaml', 'unknown_input', 'input key is not declared'],
      ['a type mismatch', 'wire-c1683-type-mismatch.nika.yaml', 'input_type_mismatch', 'declared type'],
      ['a missing required input', 'wire-c1683-missing-required.nika.yaml', 'NIKA-1708', '`ticket`'],
      ['a duplicate key', 'wire-c1683-duplicate-key.nika.yaml', 'invalid_inputs_json', 'duplicate object key'],
    ])('%s', async (_name, workflow, code, said) => {
      const refused = await failure(literal().run(workflow, { inputs: { ticket: 't' } }));
      expect(refused).toBeInstanceOf(NikaOperationError);
      expect(refused).toMatchObject({
        name: 'NikaOperationError',
        operation: 'run',
        transport: 'native-process',
        code,
        machineCode: code,
        status: 3,
      });
      expect((refused as Error).message).toContain(said);
    });
  });

  describe('the stdin writer never blocks, leaks or throws', () => {
    const big = { blob: 'x'.repeat(LITERAL_INPUTS_MAX_BYTES - 64) };

    it('yields the refusal of an engine that exits with most of the map unread', async () => {
      const refused = await failure(literal().run('hostile-exits-before-reading.nika.yaml', { inputs: big }));
      expect(refused).toBeInstanceOf(NikaOperationError);
      expect(refused).toMatchObject({ code: 'input_read_failed', status: 3 });
    });

    it('settles a cancelled run whose engine never read the map, and leaves no process', async () => {
      const pidFile = scratchFile('pid');
      process.env.NIKA_FAKE_PID_FILE = pidFile;
      try {
        const client = literal();
        const run = await client.run('hostile-never-reads.nika.yaml', { inputs: big });
        const pid = Number(readFileSync(pidFile, 'utf8'));
        expect(processIsGone(pid)).toBe(false);
        await expect(run.cancel()).resolves.toMatchObject({
          accepted: true,
          status: 'cancellation_requested',
        });
        await expect(run.result()).resolves.toMatchObject({ status: 'interrupted', exitCode: 130 });
        expect(processIsGone(pid)).toBe(true);
      } finally {
        delete process.env.NIKA_FAKE_PID_FILE;
      }
    });
  });
});
