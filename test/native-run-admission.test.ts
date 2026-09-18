import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { Nika, NikaOperationError, NikaProtocolError, isNikaRunSucceeded } from '../src/index.js';
import type {
  NikaCheckFinding,
  NikaEvent,
  NikaLocalConfig,
  NikaOperationFinding,
  NikaScheduleFinding,
} from '../src/index.js';

// Issue #121 · the admission law on the native transport:
//
//   await nika.run(workflow)
//     ├─ PRE-ADMIT REFUSE → typed NikaOperationError, no Run
//     └─ ADMITTED         → Run → Result (failure is data)
//
// The `wire-*` workflows replay bytes measured from real engines (see
// fixtures/run-wire/README.md); the `synthetic-*` ones are invented hostile
// shapes and prove only how the SDK fails.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';

/** The one finding both engines reported for the #121 SEC-004 workflow. */
const SEC_004_FINDING = {
  code: 'NIKA-SEC-004',
  docs_url: 'https://nika.sh/language/errors/NIKA-SEC-004',
  gate: 'PERMITS',
  kind: 'capability_escape',
  message: 'exec task under a boundary that forbids shells (task `pwn`) '
    + '— fix: add "echo" to permits.exec',
  severity: 'error',
  task: 'pwn',
};

const stray: unknown[] = [];
const onStray = (reason: unknown) => {
  stray.push(reason);
};

function native(overrides: Omit<NikaLocalConfig, 'bin'> = {}): Nika {
  return new Nika({ bin: FIXTURE, ...overrides });
}

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scratchFile(label: string): string {
  return path.join(tmpdir(), `nika-sdk-${label}-${randomUUID()}`);
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** `run()` itself must reject: a refusal never yields a Run to await. */
async function refusedRun(workflow: string, client = native()): Promise<unknown> {
  let admitted: unknown;
  try {
    admitted = await client.run(workflow);
  } catch (cause) {
    return cause;
  }
  throw new Error(`run() resolved a handle for ${workflow}: ${JSON.stringify(admitted)}`);
}

async function kinds(client: Nika, run: Parameters<Nika['events']>[0]): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of client.events(run)) seen.push(String(event.kind));
  return seen;
}

describe.skipIf(!posix)('native run admission (issue #121)', () => {
  beforeEach(() => {
    stray.length = 0;
    process.on('unhandledRejection', onStray);
  });
  afterEach(async () => {
    await settle(50);
    process.off('unhandledRejection', onStray);
    expect(stray).toEqual([]);
  });

  describe('a Check refusal rejects run() with the engine findings', () => {
    it.each([
      ['released 0.119.0 · pretty CheckReport', 'wire-0119-sec004.nika'],
      ['engine PR #1679 · one compact object', 'wire-pr1679-sec004.nika'],
    ])('%s · NIKA-SEC-004', async (_dialect, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaOperationError);
      expect(failure).not.toBeInstanceOf(NikaProtocolError);
      expect(failure).toMatchObject({
        name: 'NikaOperationError',
        operation: 'run',
        transport: 'native-process',
        code: 'NIKA-SEC-004',
        machineCode: 'NIKA-SEC-004',
        status: 2,
      });
      // The engine's finding arrives whole: nothing renamed, nothing dropped.
      expect((failure as NikaOperationError).findings).toEqual([SEC_004_FINDING]);
      expect((failure as Error).message).toContain('NIKA-SEC-004');
      expect((failure as Error).message).toContain('permits.exec');
    });

    it.each([
      ['released 0.119.0 · pretty CheckReport', 'wire-0119-parse005.nika'],
      ['engine PR #1679 · one compact object', 'wire-pr1679-parse005.nika'],
    ])('%s · NIKA-PARSE-005', async (_dialect, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaOperationError);
      expect(failure).toMatchObject({
        operation: 'run',
        code: 'NIKA-PARSE-005',
        machineCode: 'NIKA-PARSE-005',
        status: 2,
      });
      expect((failure as NikaOperationError).findings).toEqual([{
        code: 'NIKA-PARSE-005',
        docs_url: 'https://nika.sh/language/errors/NIKA-PARSE-005',
        gate: 'PARSE',
        kind: 'parse',
        message: 'unknown field `from` in typed output `greeting` (strict mode) — the fields '
          + 'here: value · type · description · → nika explain NIKA-PARSE-005',
        severity: 'error',
      }]);
    });

    it.each([
      ['released 0.119.0 · pretty CheckReport', 'wire-0119-missing-file.nika'],
      ['engine PR #1679 · one compact object', 'wire-pr1679-missing-file.nika'],
    ])('%s · a finding without a code is never given one', async (_dialect, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaOperationError);
      // The SDK's own word for the class; the engine named no code here.
      expect(failure).toMatchObject({ operation: 'run', code: 'run_refused', status: 3 });
      expect((failure as NikaOperationError).machineCode).toBeUndefined();
      expect((failure as NikaOperationError).findings).toEqual([{
        gate: 'PARSE',
        kind: 'parse',
        message: 'cannot read missing.nika.yaml: No such file or directory (os error 2)',
        severity: 'error',
      }]);
      expect((failure as Error).message).toContain('cannot read missing.nika.yaml');
    });
  });

  describe('a budget or launch refusal rejects run() with the engine code', () => {
    it.each([
      ['released 0.119.0 · plain teaching line', 'wire-0119-budget1709.nika'],
      ['engine PR #1679 · compact error envelope', 'wire-pr1679-budget1709.nika'],
    ])('%s · NIKA-1709', async (_dialect, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaOperationError);
      expect(failure).toMatchObject({
        operation: 'run',
        transport: 'native-process',
        code: 'NIKA-1709',
        machineCode: 'NIKA-1709',
        status: 2,
      });
      expect((failure as NikaOperationError).findings).toBeUndefined();
      expect((failure as Error).message).toContain('refusing to start');
      expect((failure as Error).message).toContain('--max-cost-usd $0.000000');
    });

    it.each([
      ['released 0.119.0 · stderr only, stdout empty', 'wire-0119-input1708.nika'],
      ['engine PR #1679 · compact error envelope', 'wire-pr1679-input1708.nika'],
    ])('%s · NIKA-1708', async (_dialect, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaOperationError);
      expect(failure).toMatchObject({
        operation: 'run',
        code: 'NIKA-1708',
        machineCode: 'NIKA-1708',
        status: 3,
      });
      expect((failure as Error).message).toContain('missing required inputs: `needle`');
      expect((failure as Error).message).toContain('--var needle=<value>');
    });

    it('SYNTHETIC · an envelope whose code is null keeps the SDK word', async () => {
      const failure = await refusedRun('synthetic-null-code-envelope.nika');

      expect(failure).toBeInstanceOf(NikaOperationError);
      expect(failure).toMatchObject({ operation: 'run', code: 'run_refused', status: 3 });
      expect((failure as NikaOperationError).machineCode).toBeUndefined();
      expect((failure as Error).message).toContain('the project root is not readable');
    });

  });

  describe('only what an engine was measured to write is read as a refusal', () => {
    it.each([
      ['a report that calls itself clean', 'synthetic-clean-report.nika'],
      ['a clean report that lists findings', 'synthetic-clean-report-with-findings.nika'],
      ['findings with no `clean: false` beside them', 'synthetic-findings-without-verdict.nika'],
      ['an error envelope with no message', 'synthetic-envelope-without-message.nika'],
    ])('SYNTHETIC · %s is not a refusal', async (_shape, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect(failure).not.toBeInstanceOf(NikaOperationError);
      expect((failure as Error).message).toContain('neither a run event nor a pre-run refusal');
    });

    it('SYNTHETIC · a refusing report whose findings are not objects is a protocol fault', async () => {
      const failure = await refusedRun('synthetic-malformed-findings.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect(failure).not.toBeInstanceOf(NikaOperationError);
      expect((failure as Error).message).toContain('findings were malformed');
    });

    it('SYNTHETIC · a pretty-printed event is never admission evidence', async () => {
      // Only check reports were measured pretty; the legacy reader recovers
      // a refusal or nothing, never a Run.
      const failure = await refusedRun('synthetic-pretty-event.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('neither a run event nor a pre-run refusal');
      expect((failure as Error).message).toContain('workflow_started');
    });

    it('SYNTHETIC · a refusal object contradicted by exit 0 is a protocol fault', async () => {
      const failure = await refusedRun('synthetic-refusal-exit-0.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('exited 0');
      // What the engine said still reaches the caller.
      expect((failure as Error).message).toContain('NIKA-SEC-004');
    });

    it.each([
      ['a non-JSON line', 'synthetic-refusal-then-garbage.nika', 'this line follows a refusal'],
      ['a second object', 'synthetic-refusal-then-object.nika', 'a second object'],
      ['a line after a teaching line', 'synthetic-teaching-then-extra.nika', 'a line after'],
    ])('SYNTHETIC · a refusal followed by %s is a protocol fault', async (_shape, workflow, extra) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect(failure).not.toBeInstanceOf(NikaOperationError);
      expect((failure as Error).message).toContain('after its pre-run refusal');
      expect((failure as Error).message).toContain(extra);
    });

    it('SYNTHETIC · an uncoded stderr line is no refusal: only the coded one was measured', async () => {
      const failure = await refusedRun('synthetic-uncoded-stderr.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('(exit 3)');
      expect((failure as Error).message).toContain('the project root is not readable');
    });

    it('SYNTHETIC · a plain code line after admission is a protocol fault on run.done', async () => {
      const client = native();
      // Admitted: the first frame is a run event, so a Run exists.
      const run = await client.run('synthetic-teaching-after-admission.nika');
      const failure = await run.done.catch((cause) => cause);

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect(failure).not.toBeInstanceOf(NikaOperationError);
      expect((failure as Error).message).toContain('NIKA-1704');
    });
  });

  describe('every machine line obeys machineBufferBytes', () => {
    it('a complete refusal line past the bound, in one chunk, is a protocol fault', async () => {
      // The real 3.3 KB compact report, newline included, under a 1 KiB bound.
      const failure = await refusedRun(
        'wire-pr1679-sec004.nika',
        native({ machineBufferBytes: 1024 }),
      );

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect(failure).not.toBeInstanceOf(NikaOperationError);
      expect((failure as Error).message).toContain('exceeded 1024 bytes');
    });

    it('SYNTHETIC · a complete event past the bound, in one chunk, fails the admitted run', async () => {
      const client = native({ machineBufferBytes: 4096 });
      const run = await client.run('synthetic-big-event.nika');
      const failure = await run.done.catch((cause) => cause);

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('exceeded 4096 bytes');
    });

    it('SYNTHETIC · the bound is exact: a 512-byte line passes at 512 and fails at 511', async () => {
      const fits = await native({ machineBufferBytes: 512 }).run('synthetic-exact-bound.nika');
      await expect(fits.done).resolves.toMatchObject({ status: 'succeeded' });

      const failure = await refusedRun(
        'synthetic-exact-bound.nika',
        native({ machineBufferBytes: 511 }),
      );
      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('exceeded 511 bytes');
    });
  });

  describe('an admitted run keeps its events and its result', () => {
    it('released 0.119.0 · hello replays all six frames, the first included', async () => {
      const client = native();
      const run = await client.run<{ greeting: string }>('wire-0119-hello.nika');
      expect(Object.keys(run).sort()).toEqual([
        'cancel', 'done', 'events', 'id', 'result', 'status',
      ]);

      const events: NikaEvent[] = [];
      for await (const event of client.events(run)) events.push(event);
      const result = await run.done;

      expect(events.map((event) => event.kind)).toEqual([
        'workflow_started',
        'task_scheduled',
        'task_started',
        'task_completed',
        'workflow_completed',
        'run_settled',
      ]);
      // The frame that proved admission is delivered, untouched, as event one.
      const recorded = readFileSync(
        path.join(HERE, 'fixtures', 'run-wire', '0.119.0-hello.ndjson.stdout'),
        'utf8',
      ).split('\n')[0]!;
      expect(events[0]).toEqual(JSON.parse(recorded));
      expect(result).toMatchObject({
        id: run.id,
        status: 'succeeded',
        transport: 'native-process',
        exitCode: 0,
        outputs: { greeting: 'mock(echo) · hello' },
        receipt: { sealed: false, chain_len: 5 },
        settlement: { cause: 'normal' },
      });
      expect(isNikaRunSucceeded(result)).toBe(true);
    });

    it('released 0.119.0 · an admitted failure is result data, never a throw', async () => {
      const client = native();
      const run = await client.run('wire-0119-admitted-failure.nika');

      expect(await kinds(client, run)).toEqual([
        'workflow_started',
        'task_scheduled',
        'task_started',
        'permit_checked',
        'task_failed',
        'workflow_failed',
        'run_settled',
      ]);
      const result = await run.done;
      expect(result).toMatchObject({
        status: 'failed',
        exitCode: 1,
        error: { code: 'NIKA-BUILTIN-ASSERT-001', task: 'fail' },
        settlement: { cause: 'task_failed' },
      });
      expect(isNikaRunSucceeded(result)).toBe(false);
    });
  });

  describe('output that is neither a run nor a refusal stays a protocol error', () => {
    it.each([
      ['a pretty report cut mid-document', 'synthetic-truncated-pretty.nika'],
      ['a compact report cut mid-line', 'synthetic-truncated-compact.nika'],
    ])('SYNTHETIC · %s', async (_shape, workflow) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect(failure).not.toBeInstanceOf(NikaOperationError);
      expect(failure).toMatchObject({ transport: 'native-process' });
      expect((failure as Error).message).toContain('not valid JSON');
    });

    it('SYNTHETIC · a first line beyond machineBufferBytes', async () => {
      const failure = await refusedRun(
        'synthetic-oversize.nika',
        native({ machineBufferBytes: 4096 }),
      );

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('exceeded 4096 bytes');
    });

    it('SYNTHETIC · a pretty report beyond machineBufferBytes', async () => {
      // The real 4.5 KB report, read under a bound smaller than the document.
      const failure = await refusedRun(
        'wire-0119-sec004.nika',
        native({ machineBufferBytes: 1024 }),
      );

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('exceeded 1024 bytes');
    });

    it.each([
      ['exit 0', 'synthetic-silent-exit-0.nika', '(exit 0)'],
      ['exit 2', 'synthetic-silent-exit-2.nika', '(exit 2)'],
    ])('SYNTHETIC · no output at all · %s', async (_exit, workflow, named) => {
      const failure = await refusedRun(workflow);

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('without a machine frame');
      expect((failure as Error).message).toContain(named);
    });

    it('SYNTHETIC · a crash before any frame quotes the diagnostic', async () => {
      const failure = await refusedRun('synthetic-crash-before-frame.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('(exit 101)');
      expect((failure as Error).message).toContain('panicked');
    });

    it('SYNTHETIC · a first object that is neither an event nor a refusal', async () => {
      const failure = await refusedRun('synthetic-unknown-first-object.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('neither a run event nor a pre-run refusal');
    });

    it('keeps the protocol verdict for a line that is not machine output', async () => {
      const failure = await refusedRun('garbage-line.nika');

      expect(failure).toBeInstanceOf(NikaProtocolError);
      expect((failure as Error).message).toContain('this line is not machine output at all');
    });
  });

  describe('a refusal leaves nothing behind', () => {
    it('spawns the workflow once and never runs a ceremonial check', async () => {
      const log = scratchFile('argv');
      process.env.NIKA_FAKE_ARGV_LOG = log;
      try {
        await refusedRun('wire-0119-sec004.nika');
        const invoked = readFileSync(log, 'utf8').trim().split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(invoked.filter(([command]) => command === 'run')).toEqual([
          ['run', 'wire-0119-sec004.nika', '--json'],
        ]);
        expect(invoked.filter(([command]) => command === 'check')).toEqual([]);
      } finally {
        delete process.env.NIKA_FAKE_ARGV_LOG;
        rmSync(log, { force: true });
      }
    });

    it('SYNTHETIC · reads the real exit status of a lingering engine, then reaps it', async () => {
      const pidFile = scratchFile('pid');
      process.env.NIKA_FAKE_PID_FILE = pidFile;
      try {
        const failure = await refusedRun('synthetic-lingering-refusal.nika');
        // The exit status is the engine's own, not a signal the SDK sent.
        expect(failure).toMatchObject({ code: 'NIKA-1709', status: 2 });
        expect(existsSync(pidFile)).toBe(true);
        expect(processIsGone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
      } finally {
        delete process.env.NIKA_FAKE_PID_FILE;
        rmSync(pidFile, { force: true });
      }
    });

    it.each([
      ['a refusal object followed by run events', 'synthetic-refusal-then-events.nika'],
      ['a garbage line from an engine that keeps running', 'synthetic-garbage-then-hang.nika'],
    ])('SYNTHETIC · stops %s', async (_shape, workflow) => {
      const pidFile = scratchFile('pid');
      process.env.NIKA_FAKE_PID_FILE = pidFile;
      try {
        const started = Date.now();
        const failure = await refusedRun(workflow);
        // The fixture would live five seconds: the SDK ended it instead.
        expect(Date.now() - started).toBeLessThan(3_000);
        expect(failure).toBeInstanceOf(NikaProtocolError);
        expect(processIsGone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
      } finally {
        delete process.env.NIKA_FAKE_PID_FILE;
        rmSync(pidFile, { force: true });
      }
    });

    it('SYNTHETIC · still rejects when the engine ignores SIGTERM, and ends it', async () => {
      const pidFile = scratchFile('pid');
      process.env.NIKA_FAKE_PID_FILE = pidFile;
      try {
        const started = Date.now();
        const failure = await refusedRun('synthetic-ignores-sigterm.nika');
        // The fixture would live thirty seconds and shrugs off SIGTERM: the
        // rejection is bounded by the escalation, never by the engine.
        expect(Date.now() - started).toBeLessThan(6_000);
        expect(failure).toBeInstanceOf(NikaProtocolError);
        expect((failure as Error).message).toContain('this line is not machine output at all');
        expect(processIsGone(Number(readFileSync(pidFile, 'utf8')))).toBe(true);
      } finally {
        delete process.env.NIKA_FAKE_PID_FILE;
        rmSync(pidFile, { force: true });
      }
    }, 15_000);

    it('rejects run() with the transport error when the engine cannot spawn', async () => {
      // The identity probe ignores cwd, so only the run spawn meets this one.
      const failure = await refusedRun(
        'ok.nika',
        native({ cwd: path.join(tmpdir(), `nika-sdk-absent-${randomUUID()}`) }),
      );

      expect(failure).toMatchObject({ name: 'NikaTransportError', transport: 'native-process' });
      expect((failure as Error).message).toContain('Cannot spawn');
    });

    it('keeps the client usable after a refusal', async () => {
      const client = native();
      await refusedRun('wire-pr1679-sec004.nika', client);
      await refusedRun('wire-0119-sec004.nika', client);

      const run = await client.run('ok.nika');
      await expect(run.done).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
    });
  });

  it('types a check finding apart from a schedule finding', () => {
    expectTypeOf<NikaCheckFinding['code']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NikaCheckFinding['message']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<NikaOperationFinding>().toEqualTypeOf<NikaScheduleFinding | NikaCheckFinding>();
    expectTypeOf<NikaOperationError['findings']>()
      .toEqualTypeOf<readonly NikaOperationFinding[] | undefined>();
  });
});
