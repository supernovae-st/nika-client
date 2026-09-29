import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Nika, NikaOperationError, NikaProtocolError } from '../src/index.js';
import type { NikaEvent } from '../src/index.js';

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
