import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import type { NikaEvent, NikaRunAdmissionOptions, NikaRunOptions } from '../src/index.js';

// The native admission boundary, as the published 0.120 line states it: run()
// resolves only once the engine admitted the run, with the frame that proved
// admission as its first event, and rejects before any handle exists when the
// engine refused, carrying the engine's own code, findings and exit status.
// The fixture engine's `admit-*` modes are SYNTHETIC protocol shapes, never
// engine captures (see fixtures/fake-nika.mjs); `wire-315-input1708` replays
// a real capture byte for byte (see fixtures/run-wire/README.md).

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';

function native(): Nika {
  return new Nika({ bin: FIXTURE });
}

async function refusal(workflow: string): Promise<unknown> {
  return native().run(workflow).then(
    () => { throw new Error(`run(${workflow}) resolved a handle for a refused workflow`); },
    (cause: unknown) => cause,
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!posix)('native admission boundary', () => {
  const scratch: string[] = [];
  afterEach(() => {
    delete process.env.NIKA_FAKE_PID_FILE;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves only once admitted, with the admission frame as the first event', async () => {
    const run = await native().run('ok.nika');
    const events: NikaEvent[] = [];
    for await (const event of run.events()) events.push(event.raw);
    expect(events[0]).toMatchObject({ kind: 'workflow_started' });
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
  });

  it('rejects a red check before any handle, with the engine code, words, findings and exit', async () => {
    const failure = await refusal('admit-check-refusal.nika');
    expect(failure).toBeInstanceOf(NikaOperationError);
    expect(failure).toMatchObject({
      operation: 'run',
      transport: 'native-process',
      code: 'NIKA-AUTH-006',
      machineCode: 'NIKA-AUTH-006',
      status: 2,
      findings: [{
        code: 'NIKA-AUTH-006',
        gate: 'PERMITS',
        kind: 'capability_escape',
        task: 'list',
        severity: 'error',
        docs_url: 'https://nika.sh/language/errors/NIKA-AUTH-006',
      }],
    });
    expect((failure as Error).message).toMatch(/^NIKA-AUTH-006 · exec task under a boundary/);
  });

  it('names the first finding that carries a code and counts the rest', async () => {
    const failure = await refusal('admit-two-findings.nika');
    expect(failure).toMatchObject({ code: 'NIKA-AUTH-006', machineCode: 'NIKA-AUTH-006', status: 2 });
    expect((failure as NikaOperationError).findings).toHaveLength(2);
    expect((failure as Error).message).toMatch(/\(\+1 more findings\)$/);
  });

  it('never supplies an engine code the engine did not name', async () => {
    const failure = await refusal('admit-uncoded.nika');
    expect(failure).toMatchObject({ code: 'run_refused', status: 3 });
    expect(failure).toHaveProperty('machineCode', undefined);
    expect((failure as NikaOperationError).findings).toEqual([
      { message: 'cannot read missing.nika: No such file or directory (os error 2)' },
    ]);
  });

  it('reads the error envelope a launch refusal writes, and never its prose on stderr instead', async () => {
    const failure = await refusal('admit-error-envelope.nika');
    expect(failure).toMatchObject({ code: 'NIKA-1708', machineCode: 'NIKA-1708', status: 3 });
    expect(failure).toHaveProperty('findings', undefined);
    expect((failure as Error).message).toBe('NIKA-1708 · missing required inputs: `ticket`');
  });

  it('rejects on the exact bytes a real engine writes for a required input left unset', async () => {
    // fixtures/run-wire/315b3a516-input1708.*: a real capture, replayed byte for byte.
    const failure = await refusal('wire-315-input1708.nika');
    expect(failure).toBeInstanceOf(NikaOperationError);
    expect(failure).toMatchObject({
      operation: 'run',
      code: 'NIKA-1708',
      machineCode: 'NIKA-1708',
      status: 3,
    });
    expect(failure).toHaveProperty('findings', undefined);
    expect((failure as Error).message).toBe(
      'NIKA-1708 · missing required inputs: `ticket` — a `required: true` input with no `default:` '
      + 'must be supplied at launch (`--var ticket=<value>` satisfies it) · the workflow declares: ticket',
    );
  });

  it('reads a refusal taught on stderr alone when no machine frame came', async () => {
    const failure = await refusal('admit-stderr-only.nika');
    expect(failure).toMatchObject({ code: 'NIKA-1708', machineCode: 'NIKA-1708', status: 3 });
  });

  it('rejects run() itself on a refusal line, where the handle used to carry it', async () => {
    const failure = await refusal('refuse-1709.nika');
    expect(failure).toMatchObject({
      name: 'NikaOperationError',
      operation: 'run',
      code: 'NIKA-1709',
      machineCode: 'NIKA-1709',
      status: 2,
    });
  });

  it.each([
    ['admit-empty.nika', /without a machine frame \(exit 2\)/],
    ['admit-malformed.nika', /./],
    ['admit-partial.nika', /./],
    ['admit-oversized.nika', /exceeded .* bytes/],
    ['admit-neither.nika', /neither a run event nor a pre-run refusal object/],
    ['admit-bad-findings.nika', /findings were malformed/],
    ['admit-more-after.nika', /more machine output after its pre-run refusal/],
    ['admit-exit-zero.nika', /pre-run refusal but exited 0/],
  ])('keeps %s a protocol fault that proves neither admission nor refusal', async (workflow, message) => {
    const failure = await refusal(workflow);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message).toMatch(message);
  });

  it.each([
    ['admit-hang-garbage.nika', 'stops on SIGTERM'],
    ['admit-hang-stubborn.nika', 'ignores SIGTERM until SIGKILL'],
  ])('leaves no engine process behind when %s proves nothing (%s)', async (workflow) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nika-admission-'));
    scratch.push(dir);
    process.env.NIKA_FAKE_PID_FILE = path.join(dir, 'pid');
    const failure = await refusal(workflow);
    expect(failure).toBeInstanceOf(NikaProtocolError);
    const pid = Number(readFileSync(process.env.NIKA_FAKE_PID_FILE, 'utf8'));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 15_000);
});

// The native literal input channel is the upstream one, and its cases live in
// native-literal-inputs.test.ts and literal-inputs.test.ts, ported unchanged.
// These two add what this line also promises: the values never reach the
// engine's environment, and the HTTP-only admission options stay HTTP-only.
// The `literal-echo` fixture mode is SYNTHETIC: it reports what arrived on
// stdin and whether a marker also reached argv or the environment.
describe.skipIf(!posix)('native literal inputs on this line', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const inputs = {
    ticket: 'MARKER-5c1e', off: false, zero: 0, empty: '', none: null, list: [1, 'two', [true]], nested: { k: -0.5 },
  };

  it('sends the inputs once on stdin, exactly, and never on argv or in the environment', async () => {
    vi.stubEnv('NIKA_FAKE_INPUTS_LITERAL', '1');
    const run = await native().run('literal-echo.nika', { inputs });
    const events: NikaEvent[] = [];
    for await (const event of run.events()) events.push(event.raw);
    const result = await run.result();
    expect(result).toMatchObject({ status: 'succeeded', exitCode: 0 });
    expect(result.outputs).toEqual({ stdin: JSON.stringify(inputs), argvCarriesMarker: false, envCarriesMarker: false });
    expect(events[0]).toMatchObject({
      kind: 'workflow_started', argv: ['run', 'literal-echo.nika', '--json', '--inputs-json', '-'],
    });
  });

  it('keeps access and costReview on the HTTP by-name door', async () => {
    const failure = await native().run('literal-echo.nika', { access: 'local' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'NikaCompatibilityError', capability: 'runOptions' });
  });
});

// Admission liveness. Without bounds a native admission waits as long as the
// engine does, as published; `admission: { timeoutMs, signal }` bounds it,
// and a complete refusal always gets the stop grace to settle. The engines
// here are SYNTHETIC doubles (`admit-silent`, `admit-deaf-silent`,
// `admit-unfinished`, `admit-refusal-open`, `admit-refusal-lingers`, and an
// identity probe that never answers): they prove these bounds and this
// cleanup, never an engine's liveness. Every child a test leaves is killed
// by its own teardown.
describe.skipIf(!posix)('native admission bounds and refusal settlement', () => {
  const scratch: string[] = [];
  const pidFiles: string[] = [];
  afterEach(() => {
    // Read from the files, not from the test body: a test that timed out
    // before it read its child's pid still leaves nothing running.
    for (const file of pidFiles.splice(0)) {
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.NIKA_FAKE_PID_FILE;
    delete process.env.NIKA_FAKE_ARGV_LOG;
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function room(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'nika-admission-bounds-'));
    scratch.push(dir);
    return dir;
  }

  /** Record the pid of the next engine the fixture starts, for this test's own teardown. */
  function watchChild(): () => Promise<number> {
    const file = path.join(room(), 'pid');
    process.env.NIKA_FAKE_PID_FILE = file;
    pidFiles.push(file);
    return async () => {
      await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 5_000 });
      return Number(readFileSync(file, 'utf8'));
    };
  }

  /** Every argv the fixture was started with, in order. */
  function argvLog(): () => string[][] {
    const file = path.join(room(), 'argv');
    process.env.NIKA_FAKE_ARGV_LOG = file;
    return () => (existsSync(file)
      ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
      : []);
  }

  /** The clock starts before `start()`: the SDK's own deadline timer starts inside the call. */
  async function rejection(start: () => Promise<unknown>): Promise<{ failure: unknown; elapsed: number }> {
    const started = Date.now();
    const failure = await start().then(
      () => { throw new Error('run() resolved a handle where it had to reject'); },
      (cause: unknown) => cause,
    );
    return { failure, elapsed: Date.now() - started };
  }

  async function exits(pid: number): Promise<void> {
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
  }

  it.each<[string, unknown]>([
    ['a zero timeout', { timeoutMs: 0 }],
    ['a negative timeout', { timeoutMs: -1 }],
    ['a fractional timeout', { timeoutMs: 1.5 }],
    ['a timeout past the timer range', { timeoutMs: 2 ** 31 }],
    ['a timeout given as text', { timeoutMs: '5' }],
    ['a plain object as the signal', { signal: {} }],
    ['an EventTarget as the signal', { signal: new EventTarget() }],
    ['an unknown bound', { timeout: 5 }],
    ['null', null],
    ['an array', []],
  ])('refuses %s before anything is spawned', async (_label, admission) => {
    const argvs = argvLog();
    const { failure } = await rejection(() => native().run('ok.nika', { admission } as NikaRunOptions));
    expect(failure).toBeInstanceOf(NikaConfigurationError);
    expect((failure as Error).message).toContain('run({ admission })');
    expect(argvs()).toEqual([]);
  });

  it('refuses a Proxy admission and a Proxy signal without running one trap', async () => {
    const traps: PropertyKey[] = [];
    const handler = new Proxy({}, {
      get: (_handler, trap) => {
        traps.push(trap);
        return Reflect.get(Reflect, trap);
      },
    });
    const bounds = new Proxy({ timeoutMs: 100 }, handler);
    const signal = new Proxy(new AbortController().signal, handler);
    for (const admission of [bounds, { signal }]) {
      const { failure } = await rejection(() => native().run('ok.nika', { admission } as NikaRunOptions));
      expect(failure).toBeInstanceOf(NikaConfigurationError);
    }
    expect(traps).toEqual([]);
  });

  it('starts nothing, not even the identity probe, when the signal was already aborted', async () => {
    const argvs = argvLog();
    const { failure } = await rejection(() => native().run('ok.nika', { admission: { signal: AbortSignal.abort() } }));
    expect(failure).toBeInstanceOf(NikaTransportError);
    expect((failure as Error).message).toBe('run admission aborted by caller; no engine process was started');
    expect(argvs()).toEqual([]);
  });

  it.each([
    ['a silent engine', 'admit-silent.nika'],
    ['an engine that wrote half a frame', 'admit-unfinished.nika'],
  ])('stops %s at its deadline and rejects once it exited', async (_label, workflow) => {
    const child = watchChild();
    const { failure, elapsed } = await rejection(() => native().run(workflow, { admission: { timeoutMs: 1_000 } }));
    expect(failure).toBeInstanceOf(NikaTransportError);
    expect(failure).not.toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message)
      .toBe('run admission timed out after 1000 ms; the engine process was stopped and has exited');
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(2_000);
    expect(alive(await child())).toBe(false);
  });

  it('escalates to SIGKILL for an engine that ignores SIGTERM, then rejects', async () => {
    const child = watchChild();
    const { failure, elapsed } = await rejection(() => native().run('admit-deaf-silent.nika', {
      admission: { timeoutMs: 1_000 },
    }));
    expect((failure as Error).message)
      .toBe('run admission timed out after 1000 ms; the engine process was stopped and has exited');
    // The deadline, then the whole SIGTERM grace: the rejection follows the deadline, never at it.
    expect(elapsed).toBeGreaterThanOrEqual(2_950);
    expect(elapsed).toBeLessThan(7_000);
    expect(alive(await child())).toBe(false);
  }, 15_000);

  it.each([
    ['with stdout left open', 'admit-refusal-open.nika'],
    ['after end of stream from a process that stays alive', 'admit-refusal-lingers.nika'],
  ])('settles a complete refusal %s within the stop grace, unasked', async (_label, workflow) => {
    const child = watchChild();
    const { failure, elapsed } = await rejection(() => native().run(workflow));
    expect(failure).toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message).toContain(
      'Engine wrote a pre-run refusal but did not exit within 2000 ms; the engine process was stopped and has exited',
    );
    expect((failure as Error).message).toContain('NIKA-1708');
    // What the engine wrote stays the cause, with no exit status it never gave.
    expect((failure as Error).cause).toEqual({
      machineCode: 'NIKA-1708',
      message: 'NIKA-1708 · missing required inputs: `ticket`',
    });
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_500);
    expect(alive(await child())).toBe(false);
  }, 15_000);

  /**
   * Abort only once the engine is known to run: an abort that lands while the
   * child is still starting stops it before it records its pid, which is the
   * SDK doing its job, not something this test can observe.
   */
  async function abortOnceRunning(
    admission: NikaRunAdmissionOptions,
    abort: () => void,
  ): Promise<{ failure: unknown; afterAbort: number; pid: number }> {
    const child = watchChild();
    const pending = rejection(() => native().run('admit-silent.nika', { admission }));
    const pid = await child();
    const aborted = Date.now();
    abort();
    const { failure } = await pending;
    return { failure, afterAbort: Date.now() - aborted, pid };
  }

  it('names a caller abort as the caller\'s, and keeps its reason as the cause', async () => {
    const controller = new AbortController();
    const reason = new Error('the caller stopped waiting');
    const { failure, afterAbort, pid } = await abortOnceRunning(
      { signal: controller.signal, timeoutMs: 10_000 },
      () => controller.abort(reason),
    );
    expect((failure as Error).message)
      .toBe('run admission aborted by caller; the engine process was stopped and has exited');
    expect((failure as Error).cause).toBe(reason);
    expect(afterAbort).toBeLessThan(2_000);
    expect(alive(pid)).toBe(false);
  });

  it('names a deadline a deadline while the caller\'s signal never fired', async () => {
    const child = watchChild();
    const controller = new AbortController();
    const { failure } = await rejection(() => native().run('admit-silent.nika', {
      admission: { signal: controller.signal, timeoutMs: 1_000 },
    }));
    expect((failure as Error).message)
      .toBe('run admission timed out after 1000 ms; the engine process was stopped and has exited');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(alive(await child())).toBe(false);
  });

  it('leaves concurrent unrelated runs of the same client untouched', async () => {
    const client = native();
    // Two runs admitted and still running (each lives two seconds), started
    // before the pid file is set: this fixture records every run's pid in it.
    const patient = await client.run('cancel.nika');
    const other = new AbortController();
    const guarded = await client.run('cancel.nika', { admission: { signal: other.signal, timeoutMs: 60_000 } });
    const child = watchChild();
    const { failure } = await rejection(() => client.run('admit-silent.nika', { admission: { timeoutMs: 1_000 } }));
    expect((failure as Error).message).toContain('run admission timed out after 1000 ms');
    await exits(await child());
    await expect(patient.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
    await expect(guarded.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
  }, 15_000);

  it('never lets a bound reach an admitted run: its timer and listener are gone', async () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const run = await native().run('cancel.nika', { admission: { signal: controller.signal, timeoutMs: 60_000 } });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const index = setTimer.mock.calls.findIndex((call) => call[1] === 60_000);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]?.value);
    controller.abort();
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
  }, 15_000);

  it('releases its timer and listener when the engine refuses', async () => {
    const controller = new AbortController();
    const { failure } = await rejection(() => native().run('admit-error-envelope.nika', {
      admission: { signal: controller.signal, timeoutMs: 60_000 },
    }));
    expect(failure).toMatchObject({ name: 'NikaOperationError', code: 'NIKA-1708', status: 3 });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('starts no run if the caller aborts while flags are read after the probe', async () => {
    const controller = new AbortController();
    const reason = new Error('stop before workflow launch');
    const argvs = argvLog();
    const { failure } = await rejection(() => native().run('ok.nika', {
      admission: { signal: controller.signal },
      get model() {
        controller.abort(reason);
        return 'mock/echo';
      },
    }));
    expect(failure).toBeInstanceOf(NikaTransportError);
    expect((failure as Error).message).toBe(
      'run admission aborted by caller; the engine identity probe it was waiting on ended and no run was started',
    );
    expect((failure as Error).cause).toBe(reason);
    expect(argvs()).toEqual([['--sdk-identity']]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('bounds an identity probe that never answers, stops that owned probe, and starts no run', async () => {
    vi.stubEnv('NIKA_FAKE_IDENTITY_HANG', '1');
    const probe = watchChild();
    const argvs = argvLog();
    const { failure, elapsed } = await rejection(() => native().run('ok.nika', { admission: { timeoutMs: 1_000 } }));
    expect((failure as Error).message).toBe(
      'run admission timed out after 1000 ms; the engine identity probe it was waiting on ended and no run was started',
    );
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(4_500);
    expect(alive(await probe())).toBe(false);
    expect(argvs().filter(([command]) => command === 'run')).toEqual([]);
  }, 15_000);

  // An earlier listener on the caller's own signal may call
  // stopImmediatePropagation(); the SDK's abort must still arrive.
  const hostile = (signal: AbortSignal) => signal.addEventListener('abort', (event) => {
    event.stopImmediatePropagation();
  });

  it('still stops at the caller\'s abort after an earlier listener stopped propagation', async () => {
    const controller = new AbortController();
    hostile(controller.signal);
    const { failure, afterAbort, pid } = await abortOnceRunning(
      { signal: controller.signal },
      () => controller.abort(),
    );
    expect((failure as Error).message)
      .toBe('run admission aborted by caller; the engine process was stopped and has exited');
    expect(afterAbort).toBeLessThan(2_000);
    expect(alive(pid)).toBe(false);
  });

  it('names that abort the caller\'s, not the later deadline, when both were given', async () => {
    const controller = new AbortController();
    hostile(controller.signal);
    const { failure, afterAbort, pid } = await abortOnceRunning(
      { signal: controller.signal, timeoutMs: 8_000 },
      () => controller.abort(),
    );
    expect((failure as Error).message)
      .toBe('run admission aborted by caller; the engine process was stopped and has exited');
    expect(afterAbort).toBeLessThan(2_000);
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('leaves only the caller\'s own listeners on a signal reused across admitted runs', async () => {
    const client = native();
    const controller = new AbortController();
    hostile(controller.signal);
    for (let round = 0; round < 3; round += 1) {
      const run = await client.run('ok.nika', { admission: { signal: controller.signal, timeoutMs: 60_000 } });
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
    }
    controller.abort();
  });

  it('keeps an admitted run out of reach of that abort, hostile listener or not', async () => {
    const controller = new AbortController();
    hostile(controller.signal);
    const run = await native().run('cancel.nika', { admission: { signal: controller.signal } });
    controller.abort();
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
  }, 15_000);

  it('keeps the bound armed through a legacy pretty report that never closes, then stops the engine', async () => {
    // The legacy reader reads an older engine's multi-line report to its end
    // of stream; every one of its reads stays under the caller's bound.
    const child = watchChild();
    const { failure, elapsed } = await rejection(() => native().run('admit-pretty-open.nika', {
      admission: { timeoutMs: 1_000 },
    }));
    expect(failure).toBeInstanceOf(NikaTransportError);
    expect(failure).not.toBeInstanceOf(NikaProtocolError);
    expect((failure as Error).message)
      .toBe('run admission timed out after 1000 ms; the engine process was stopped and has exited');
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(2_500);
    expect(alive(await child())).toBe(false);
  });

  it('still reads a complete legacy pretty refusal under the bound, then releases it', async () => {
    const controller = new AbortController();
    const { failure } = await rejection(() => native().run('wire-0119-sec004.nika', {
      admission: { signal: controller.signal, timeoutMs: 60_000 },
    }));
    expect(failure).toBeInstanceOf(NikaOperationError);
    expect(failure).toMatchObject({ code: 'NIKA-SEC-004', status: 2 });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('refuses admission bounds over HTTP before any request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new Nika({
      url: 'http://127.0.0.1:8787', allowInsecureHttp: true, token: 'admission-bounds-bearer-0123456789', fetch,
    });
    const { failure } = await rejection(() => client.run('daily', { admission: { timeoutMs: 1_000 } }));
    expect(failure).toBeInstanceOf(NikaCompatibilityError);
    expect(failure).toMatchObject({ capability: 'runAdmission', transport: 'http' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('types the bounds as their own option, keeping signal off the run options', () => {
    expectTypeOf<NikaRunOptions['admission']>().toEqualTypeOf<NikaRunAdmissionOptions | undefined>();
    expectTypeOf<NikaRunAdmissionOptions>().toEqualTypeOf<{ signal?: AbortSignal; timeoutMs?: number }>();
    expectTypeOf<'signal' extends keyof NikaRunOptions ? true : false>().toEqualTypeOf<false>();
  });
});
