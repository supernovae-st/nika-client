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
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import type { NikaLocalConfig } from '../src/index.js';
import { COMPILE_RESPONSE_MAX_BYTES } from '../src/lib/compile.js';

// Issue #128 · the native half of `Nika.compile`:
//
//   request ─▶ judged (answers strict JSON, shapes) ─▶ capability `compile`?
//     compile --json [--answer=KEY=JSON]… [--base tmp --change=…] [--] [intent]
//
// The fixture engine (fixtures/fake-nika-compile.mjs) speaks the versioned
// wire; `fake-nika.mjs` / `fake-nika-inputs.mjs` predate the capability and
// must be refused before any compile spawn. No fallback, no TypeScript
// compiler: every failure is typed.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPILE_ENGINE = path.join(HERE, 'fixtures', 'fake-nika-compile.mjs');
/** Advertises inputsLiteral but not compile: the door is absent. */
const INPUTS_ONLY_ENGINE = path.join(HERE, 'fixtures', 'fake-nika-inputs.mjs');
/** An engine from before the literal channel too. */
const OLD_ENGINE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';

const stray: unknown[] = [];
const onStray = (reason: unknown) => {
  stray.push(reason);
};
const scratch: string[] = [];

function client(overrides: Omit<NikaLocalConfig, 'bin'> = {}): Nika {
  return new Nika({ bin: COMPILE_ENGINE, ...overrides });
}

function scratchFile(label: string): string {
  const file = path.join(tmpdir(), `nika-sdk-compile-${label}-${process.pid}-${scratch.length}`);
  scratch.push(file);
  return file;
}

/** Every argv the fixture process was spawned with during `action`, in order. */
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
  try {
    return await promise;
  } catch (cause) {
    return cause;
  }
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

/** Abort only once the compile child (second argv entry) actually exists. */
async function abortWhenCompileSpawned(log: string, controller: AbortController): Promise<string[][]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(log)) {
      const argvs = readFileSync(log, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as string[]);
      if (argvs.length >= 2) {
        controller.abort();
        return argvs;
      }
    }
    if (Date.now() > deadline) throw new Error('compile child never spawned');
    await settle(25);
  }
}

describe.skipIf(!posix)('native compile (issue #128 · engine #1663)', () => {
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
    it('compiles a ready outcome with the answer serialized exactly once on argv', async () => {
      const { result, argvs } = await spawned(() => client().compile({
        intent: 'classify-and-route',
        answers: { 'const.request': 'Réparez la 雪 "quoted" <tag>' },
      }));
      expect(argvs).toEqual([
        ['--sdk-identity'],
        ['compile', '--json', '--answer=const.request="Réparez la 雪 \\"quoted\\" <tag>"', '--', 'classify-and-route'],
      ]);
      expect(result.compile_version).toBe(1);
      expect(result.status).toBe('ready');
      expect(result.ready).toBe(true);
      expect(result).not.toHaveProperty('exitCode');
      expect(result).not.toHaveProperty('written');
      expect(result.candidate).toContain('const: { request: "Réparez la 雪 \\"quoted\\" <tag>" }');
      expect(result.questions).toEqual([]);
      expect(result.provenance.cognition).toBe('deterministicOnly');
      expect(result.provenance.compiler_version).toBe('0.120.0');
    });

    it('serializes every strict-JSON answer shape without changing it', async () => {
      const answers = {
        'const.count': 42,
        'const.ratio': 0.5,
        'const.flag': true,
        'const.nothing': null,
        'const.list': [1, '雪', false],
        'const.record': { nested: { deep: ['é'] } },
      };
      const { argvs } = await spawned(() => client().compile({ intent: 'classify-and-route', answers }));
      const sent = argvs[1]!.filter((arg) => arg.startsWith('--answer=')).sort();
      expect(sent).toEqual([
        '--answer=const.count=42',
        '--answer=const.flag=true',
        '--answer=const.list=[1,"雪",false]',
        '--answer=const.nothing=null',
        '--answer=const.ratio=0.5',
        '--answer=const.record={"nested":{"deep":["é"]}}',
      ]);
    });

    it('keeps a leading-dash intent as data behind an explicit terminator', async () => {
      const { result, argvs } = await spawned(() => client().compile('--force-everything'));
      expect(argvs[1]).toEqual(['compile', '--json', '--', '--force-everything']);
      expect(result.status).toBe('incomplete');
      expect(result.diagnostics[0]).toMatchObject({ kind: 'unknown', target: 'intent' });
    });

    it('treats an injection-looking intent as one inert argv element', async () => {
      const hostile = '"; rm -rf /; echo "';
      const { result, argvs } = await spawned(() => client().compile(hostile));
      expect(argvs[1]!.at(-1)).toBe(hostile);
      expect(result.status).toBe('incomplete');
      expect(result.diagnostics[0]!.message).toContain(hostile);
    });

    it('resolves incomplete as data: questions, diagnostics, exit 2', async () => {
      const { result } = await spawned(() => client().compile('classify-and-route'));
      expect(result.status).toBe('incomplete');
      expect(result.ready).toBe(false);
      expect(result).not.toHaveProperty('exitCode');
      expect(result.questions).toEqual([{
        key: 'const.request',
        label: 'What request should this workflow classify?',
        type: 'literal',
        why: 'The compiler cannot invent this authoring value.',
        mandatory: true,
      }]);
    });

    it('resolves refused as data', async () => {
      const { result } = await spawned(() => client().compile('refuse-me'));
      expect(result.status).toBe('refused');
      expect(result.ready).toBe(false);
      expect(result.diagnostics[0]).toMatchObject({ kind: 'refused' });
    });

    it('preserves the engine-provided requested boundary and check preview verbatim', async () => {
      const { result } = await spawned(() => client().compile('classify-and-route'));
      expect(result.requested_boundary).toBeNull();
      expect(result.check_preview).toBeNull();
    });
  });

  describe('caller mistakes (typed, zero compile spawns)', () => {
    it('refuses answer keys that are empty or carry =', async () => {
      for (const answers of [{ '=x': 1 }, { '': 1 }, { 'a=b': 1 }]) {
        const { result, argvs } = await spawned(() => failure(
          client().compile({ intent: 'classify-and-route', answers }),
        ));
        expect(result).toBeInstanceOf(NikaConfigurationError);
        expect((result as Error).message).toMatch(/question key/);
        expect(argvs).toEqual([]);
      }
    });

    it('refuses values JSON cannot carry, before any spawn', async () => {
      const cases: Record<string, unknown>[] = [
        { 'const.x': undefined },
        { 'const.x': 1n },
        { 'const.x': () => 1 },
        { 'const.x': Number.NaN },
      ];
      for (const answers of cases) {
        const { result, argvs } = await spawned(() => failure(
          client().compile({ intent: 'classify-and-route', answers }),
        ));
        expect(result).toBeInstanceOf(NikaConfigurationError);
        expect(argvs).toEqual([]);
      }
    });
  });

  describe('capability gate', () => {
    it('refuses an engine that predates the compile capability, after the probe alone', async () => {
      const { result, argvs } = await spawned(() => failure(
        new Nika({ bin: INPUTS_ONLY_ENGINE }).compile('classify-and-route'),
      ));
      expect(result).toBeInstanceOf(NikaCompatibilityError);
      expect(result).toMatchObject({ capability: 'compile', transport: 'native-process' });
      expect((result as Error).message).toMatch(/does not advertise compile/);
      expect(argvs).toEqual([['--sdk-identity']]);
    });

    it('refuses the old engine line (0.118.x shape) the same way', async () => {
      const { result, argvs } = await spawned(() => failure(
        new Nika({ bin: OLD_ENGINE }).compile('classify-and-route'),
      ));
      expect(result).toBeInstanceOf(NikaCompatibilityError);
      expect(argvs).toEqual([['--sdk-identity']]);
    });
  });

  describe('engine-stamped failures', () => {
    it('maps an exit-2 error payload to NikaOperationError with the engine code', async () => {
      const cause = await failure(client().compile('usage-error'));
      expect(cause).toBeInstanceOf(NikaOperationError);
      expect(cause).toMatchObject({
        operation: 'compile',
        transport: 'native-process',
        code: 'invalid_answer',
        machineCode: 'invalid_answer',
        status: 2,
      });
    });

    it('maps an exit-3 error payload to NikaOperationError', async () => {
      const cause = await failure(client().compile('env-error'));
      expect(cause).toBeInstanceOf(NikaOperationError);
      expect(cause).toMatchObject({ code: 'read_base', status: 3 });
    });
  });

  describe('wire law violations (typed, never data)', () => {
    it.each([
      ['hostile-not-json', NikaProtocolError, /absent or malformed/],
      ['hostile-unknown-status', NikaProtocolError, /unknown compile status/],
      ['hostile-ready-exit-2', NikaProtocolError, /contradicts exit 2/],
      ['hostile-ready-exit-1', NikaProtocolError, /contradicts exit 1/],
      ['hostile-incomplete-exit-0', NikaProtocolError, /contradicts exit 0/],
      ['hostile-ready-no-candidate', NikaProtocolError, /no candidate/],
      ['hostile-writes-anyway', NikaProtocolError, /written destination/],
      ['hostile-error-exit-0', NikaProtocolError, /exit 0/],
      ['hostile-error-exit-1', NikaProtocolError, /exit 1/],
    ])('compile(%s) fails typed', async (intent, errorClass, pattern) => {
      const cause = await failure(client().compile(intent));
      expect(cause).toBeInstanceOf(errorClass);
      expect((cause as Error).message).toMatch(pattern);
    });

    it('refuses a wire generation it does not speak', async () => {
      const cause = await failure(client().compile('hostile-wrong-version'));
      expect(cause).toBeInstanceOf(NikaCompatibilityError);
      expect((cause as Error).message).toMatch(/compile wire 2/);
    });

    it('fails typed on an externally killed child, never accepting its output', async () => {
      const cause = await failure(client().compile('hostile-self-kill'));
      expect(cause).toBeInstanceOf(NikaTransportError);
      expect((cause as Error).message).toMatch(/SIGKILL/);
    });

    it('fails typed on overflow instead of parsing a truncated payload', async () => {
      const cause = await failure(client().compile('hostile-big'));
      expect(cause).toBeInstanceOf(NikaProtocolError);
      expect((cause as Error).message).toMatch(/exceeded 8388608 bytes/);
      expect(COMPILE_RESPONSE_MAX_BYTES).toBe(8 * 1024 * 1024);
    });
  });

  describe('cancellation and timeout (no Run exists)', () => {
    it('bounds a stalled identity probe before the compile child starts', async () => {
      process.env.NIKA_FAKE_COMPILE_PROBE = 'slow';
      try {
        const { result, argvs } = await spawned(() => failure(client().compile('hello', { timeoutMs: 150 })));
        expect(result).toBeInstanceOf(NikaTransportError);
        expect((result as Error).message).toMatch(/timed out/);
        expect(argvs.every((argv) => argv[0] === '--sdk-identity')).toBe(true);
      } finally { delete process.env.NIKA_FAKE_COMPILE_PROBE; }
    });

    it('abort before spawn starts zero compile processes', async () => {
      const controller = new AbortController();
      controller.abort();
      const { result, argvs } = await spawned(() => failure(
        client().compile('classify-and-route', { signal: controller.signal }),
      ));
      expect(result).toBeInstanceOf(NikaTransportError);
      expect((result as Error).message).toMatch(/aborted by caller/);
      expect(argvs).toEqual([]);
    });

    it('mid-flight abort stops the child and fails typed', async () => {
      const log = scratchFile('argv');
      const pidFile = scratchFile('pid');
      process.env.NIKA_FAKE_ARGV_LOG = log;
      process.env.NIKA_FAKE_PID_FILE = pidFile;
      const controller = new AbortController();
      try {
        const pending = client().compile('hostile-slow', { signal: controller.signal });
        await abortWhenCompileSpawned(log, controller);
        const cause = await failure(pending);
        expect(cause).toBeInstanceOf(NikaTransportError);
        expect((cause as Error).message).toMatch(/aborted by caller/);
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        await settle(100);
        expect(processIsGone(pid)).toBe(true);
      } finally {
        delete process.env.NIKA_FAKE_ARGV_LOG;
        delete process.env.NIKA_FAKE_PID_FILE;
      }
    });

    it('timeoutMs stops the child and names the timeout', async () => {
      const cause = await failure(client().compile('hostile-slow', { timeoutMs: 100 }));
      expect(cause).toBeInstanceOf(NikaTransportError);
      expect((cause as Error).message).toMatch(/timed out after 100 ms/);
    });

    it('a SIGTERM-ignoring child is SIGKILLed inside the kill grace', async () => {
      const log = scratchFile('argv');
      const pidFile = scratchFile('pid');
      process.env.NIKA_FAKE_ARGV_LOG = log;
      process.env.NIKA_FAKE_PID_FILE = pidFile;
      const controller = new AbortController();
      try {
        const pending = client().compile('hostile-wedged', { signal: controller.signal });
        await abortWhenCompileSpawned(log, controller);
        const started = Date.now();
        const cause = await failure(pending);
        expect(cause).toBeInstanceOf(NikaTransportError);
        // SIGTERM ignored, SIGKILL after the 2s grace, never a hang.
        expect(Date.now() - started).toBeLessThan(10_000);
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        await settle(100);
        expect(processIsGone(pid)).toBe(true);
      } finally {
        delete process.env.NIKA_FAKE_ARGV_LOG;
        delete process.env.NIKA_FAKE_PID_FILE;
      }
    }, 15_000);
  });

  describe('edit', () => {
    it.each([null, true, 1.2345678901234567, '雪 \"quoted\"', { nested: ['é', false, null] }])(
      'maps a structured constant literal exactly onto the CLI grammar: %j', async (value) => {
        const { argvs } = await spawned(() => client().compile({
          workflow: 'nika: base\nconst: { request: "a" }\n',
          change: { set_constant: { name: 'request', value } },
        }));
        expect(argvs[1]).toContain(`--change=Set const.request to ${JSON.stringify(value)}`);
      },
    );

    const BASE = '# accepted base\nnika: base\nconst: { request: "雪 é" }\n';

    it('lends the base as exact bytes in a scratch file, then removes it', async () => {
      const { result, argvs } = await spawned(() => client().compile({
        workflow: BASE,
        change: 'Set const.request to "a"',
      }));
      expect(result.status).toBe('ready');
      const compileArgs = argvs[1]!;
      expect(compileArgs[0]).toBe('compile');
      expect(compileArgs[1]).toBe('--json');
      const baseIndex = compileArgs.indexOf('--base');
      const basePath = compileArgs[baseIndex + 1]!;
      expect(basePath).toMatch(/nika-sdk-compile-/);
      expect(path.basename(basePath)).toBe('base.nika');
      // The fixture echoed the base into the candidate: exact bytes, no loss.
      expect(result.candidate!.startsWith(BASE)).toBe(true);
      expect(result.candidate).toContain('# applied change: Set const.request to "a"');
      // Scratch is gone after resolution.
      expect(existsSync(path.dirname(basePath))).toBe(false);
    });

    it('cleans the scratch dir when the edit aborts mid-flight', async () => {
      const log = scratchFile('argv');
      process.env.NIKA_FAKE_ARGV_LOG = log;
      const controller = new AbortController();
      try {
        const pending = client().compile(
          { workflow: BASE, change: 'hostile-slow' },
          { signal: controller.signal },
        );
        const argvs = await abortWhenCompileSpawned(log, controller);
        const cause = await failure(pending);
        expect(cause).toBeInstanceOf(NikaTransportError);
        const compileArgs = argvs[1]!;
        const basePath = compileArgs[compileArgs.indexOf('--base') + 1]!;
        expect(existsSync(path.dirname(basePath))).toBe(false);
      } finally {
        delete process.env.NIKA_FAKE_ARGV_LOG;
      }
    });

    it('keeps a leading-dash change as data', async () => {
      const { result, argvs } = await spawned(() => client().compile({
        workflow: BASE,
        change: '-not-a-flag',
      }));
      expect(result.status).toBe('ready');
      const compileArgs = argvs[1]!;
      expect(compileArgs).toContain('--change=-not-a-flag');
      expect(result.candidate).toContain('# applied change: -not-a-flag');
    });
  });
});
