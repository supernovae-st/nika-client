import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaOperationError,
  NikaProtocolError,
  isNikaRunSucceeded,
  nextCompileRequest,
} from '../src/index.js';
import type { NikaCheckFinding, NikaCompileOutcome, NikaRunEvent } from '../src/index.js';
import { MACHINE_PROTOCOL_VERSION } from '../src/lib/engine-identity.js';

// The SDK against a real engine, end to end: the public API on both doors,
// driving the binary `NIKA_BIN` names (the SDK's own override), and a
// `nika serve --bind` this file starts from the same binary. Skipped without
// `NIKA_BIN`. Written for engine 0.123 (machine protocol 2); the network-task
// and fan-out cases read what engine 0.124.1 adds. Run it as
//
//   NIKA_BIN=/absolute/path/to/nika npx vitest run test/engine-live.test.ts
//
// Keyless and offline: a fresh project and HOME, NIKA_KEYCHAIN=off, provider
// keys and NIKA_* settings removed from the environment the engine inherits,
// `mock/echo` and `nika:*` builtins only, compile without a seat, loopback
// HTTP only. No provider is called and nothing is spent.

const BIN = process.env.NIKA_BIN;
const live = typeof BIN === 'string' && path.isAbsolute(BIN);
const INTENT = 'Every Monday at 9am summarize the support queue into ./digest.md';
const TOKEN = 'engine-live-test-token-0123456789-abcdef';
const SLOW = 60_000;

const WORKFLOWS: Record<string, string> = {
  'hello.nika': [
    'nika: hello',
    'permits: {}',
    'tasks:',
    '  greet:',
    '    infer:',
    '      model: mock/echo',
    '      prompt: "hello"',
    '      max_tokens: 16',
    'outputs:',
    '  greeting: ${{ tasks.greet.output }}',
    '',
  ].join('\n'),
  // An exec under a boundary that forbids it: refused before admission.
  'refused.nika': [
    'nika: refused',
    'permits: {}',
    'tasks:',
    '  pwn:',
    '    exec:',
    '      command: [echo, hi]',
    '',
  ].join('\n'),
  'wait.nika': [
    'nika: wait',
    'permits: {tools: ["nika:wait"]}',
    'tasks:',
    '  hold:',
    '    invoke:',
    '      tool: nika:wait',
    '      args: {duration: "6s"}',
    '',
  ].join('\n'),
  // Outlives the server's fixed 5-second cancel grace by far.
  'long-wait.nika': [
    'nika: long-wait',
    'permits: {tools: ["nika:wait"]}',
    'tasks:',
    '  hold:',
    '    invoke:',
    '      tool: nika:wait',
    '      args: {duration: "20s"}',
    '',
  ].join('\n'),
  // Saves one SVG with `nika:chart`: a byte stream its journal records with its SHA-256.
  'chart.nika': [
    'nika: chart',
    'permits:',
    '  fs: { write: ["./out/**"] }',
    '  tools: ["nika:chart"]',
    'tasks:',
    '  draw:',
    '    invoke:',
    '      tool: "nika:chart"',
    '      args:',
    '        data: [{ region: "north", total: 10 }, { region: "south", total: 4 }]',
    '        chart: { type: bar, x: region, y: total }',
    '        out: "./out/totals.svg"',
    '',
  ].join('\n'),
  // One `nika:chart` call per item: a `for_each` fan-out that saves two SVGs.
  'fan.nika': [
    'nika: fan',
    'permits:',
    '  fs: { write: ["./out/**"] }',
    '  tools: ["nika:chart"]',
    'tasks:',
    '  draw:',
    '    for_each: { items: [a, b] }',
    '    invoke:',
    '      tool: "nika:chart"',
    '      args:',
    '        data: [{ region: "north", total: 10 }, { region: "south", total: 4 }]',
    '        chart: { type: bar, x: region, y: total }',
    '        out: "./out/fan-${{ item }}.svg"',
    '',
  ].join('\n'),
  // A `mock/echo` rehearsal whose `grab` task calls `nika:fetch` on a real
  // host. It is only ever checked here, never run, so nothing dials.
  'dials.nika': [
    'nika: dials',
    'permits:',
    '  net: { http: ["api.github.com"] }',
    '  tools: ["nika:fetch"]',
    'tasks:',
    '  grab:',
    '    invoke:',
    '      tool: "nika:fetch"',
    '      args: { url: "https://api.github.com/zen" }',
    '  say:',
    '    with:',
    '      zen: ${{ tasks.grab.output }}',
    '    infer:',
    '      model: mock/echo',
    '      prompt: "Summarize: ${{ with.zen }}"',
    '      max_tokens: 16',
    '',
  ].join('\n'),
  // Echoes a literal input into its outputs: a result as large as the caller makes it.
  'big-echo.nika': [
    'nika: big-echo',
    'inputs:',
    '  blob:',
    '    type: string',
    '    required: true',
    'permits: {}',
    'tasks:',
    '  note:',
    '    infer:',
    '      model: mock/echo',
    '      prompt: "size probe"',
    '      max_tokens: 8',
    'outputs:',
    '  blob: ${{ inputs.blob }}',
    '',
  ].join('\n'),
};
/** Above 64 KiB, the size of a 150 KB image once base64 rides `outputs`. */
const BLOB = 'x'.repeat(200_000);
const LEAVE_UNSET = ', or leave it unset: its 16 MiB default holds any result nika serve settles';

/** Remove what could reach a provider or reconfigure the engine; restore it after. */
function keyless(home: string): () => void {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    const sensitive = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)
      || /^(HTTPS?|ALL|NO)_PROXY$/i.test(key)
      || (key.startsWith('NIKA_') && key !== 'NIKA_BIN');
    if (sensitive) delete process.env[key];
  }
  process.env.HOME = home;
  process.env.NIKA_KEYCHAIN = 'off';
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };
}

async function untilSettled(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const closed = new Promise<boolean>((resolve) => child.once('close', () => resolve(true)));
  return Promise.race([closed, delay(milliseconds).then(() => false)]);
}

async function kinds(events: AsyncIterable<NikaRunEvent>): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of events) seen.push(event.kind);
  return seen;
}

async function collect(events: AsyncIterable<NikaRunEvent>): Promise<NikaRunEvent[]> {
  const seen: NikaRunEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a refusal');
}

describe.skipIf(!live)('the SDK against a real machine-protocol-2 engine (NIKA_BIN)', () => {
  let root: string;
  let project: string;
  let restore: () => void;
  let resident: ChildProcess | undefined;
  let url: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'nika-engine-live-'));
    project = path.join(root, 'project');
    const home = path.join(root, 'home');
    mkdirSync(project);
    mkdirSync(home);
    restore = keyless(home);
    writeFileSync(path.join(project, 'nika.yaml'), 'nika: engine-live\n');
    for (const [name, source] of Object.entries(WORKFLOWS)) writeFileSync(path.join(project, name), source);
    // A run-signing key in this HOME, so that every run seals its journal.
    execFileSync(BIN!, ['key', 'init', '--plain'], { cwd: project, env: process.env, stdio: 'ignore' });
    writeFileSync(path.join(root, 'token'), TOKEN, { mode: 0o600 });
    resident = spawn(BIN!, [
      'serve', '--bind', '127.0.0.1:0', '--workflows', project, '--token-file', path.join(root, 'token'),
      '--state-root', path.join(root, 'state'), '--plain',
    ], { cwd: project, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    resident.stdout!.on('data', (chunk) => { log += String(chunk); });
    resident.stderr!.on('data', (chunk) => { log += String(chunk); });
    const deadline = Date.now() + 20_000;
    while (!url) {
      const listening = log.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/);
      if (listening) url = listening[1]!;
      else if (Date.now() > deadline || resident.exitCode !== null) throw new Error(`nika serve did not listen: ${log}`);
      else await delay(25);
    }
  }, SLOW);

  afterAll(async () => {
    if (resident) {
      resident.kill('SIGINT');
      if (!await untilSettled(resident, 5_000)) {
        resident.kill('SIGKILL');
        await untilSettled(resident, 5_000);
      }
    }
    restore?.();
    if (root) rmSync(root, { recursive: true, force: true });
  }, SLOW);

  const local = () => new Nika({ bin: BIN, cwd: project });
  const remote = () => new Nika({ url, token: TOKEN, allowInsecureHttp: true, bin: BIN, cwd: project });

  describe('a local engine', () => {
    it('speaks machine protocol 2, found through NIKA_BIN alone', async () => {
      expect(MACHINE_PROTOCOL_VERSION).toBe(2);
      const identity = JSON.parse(execFileSync(BIN!, ['--sdk-identity'], { encoding: 'utf8' }));
      expect(identity.machineProtocolVersion).toBe(MACHINE_PROTOCOL_VERSION);
      // No `bin`: the client resolves the engine from NIKA_BIN.
      const report = await new Nika({ cwd: project }).check('hello.nika');
      expect(report).toMatchObject({ clean: true, exitCode: 0, report_version: 1 });
    }, SLOW);

    it('checks a refused workflow and refuses to run it, with the engine\'s code', async () => {
      const report = await local().check('refused.nika');
      expect(report.clean).toBe(false);
      expect(report.exitCode).toBe(2);
      const findings = report.findings as NikaCheckFinding[];
      expect(findings.map((finding) => finding.code)).toContain('NIKA-SEC-004');
      const refused = local().run('refused.nika');
      await expect(refused).rejects.toBeInstanceOf(NikaOperationError);
      await expect(refused).rejects.toMatchObject({ operation: 'run', code: 'NIKA-SEC-004', status: 2 });
    }, SLOW);

    it('runs a workflow to its settled result and verifies its sealed trace', async () => {
      const run = await local().run('hello.nika');
      const seen = await kinds(run.events());
      expect(seen[0]).toBe('run.started');
      expect(seen).toEqual(expect.arrayContaining(['task.scheduled', 'task.started', 'task.completed']));
      expect(seen.at(-1)).toBe('run.settled');
      const result = await run.result();
      expect(isNikaRunSucceeded(result)).toBe(true);
      expect(result).toMatchObject({
        status: 'succeeded',
        transport: 'native-process',
        exitCode: 0,
        outputs: { greeting: 'mock(echo) · hello' },
      });
      expect(result.settlement).toMatchObject({
        status: 'succeeded', cause: 'normal', tasks: { total: 1, ok: 1, failed: 0 },
      });
      expect(result.receipt).toMatchObject({ sealed: true, receipt_format: 1 });
      expect(typeof result.receipt?.trace_path).toBe('string');
      await expect(local().traceVerify(result.receipt!)).resolves.toMatchObject({
        verified: true, verdict: 'verified', exitCode: 0,
      });
      // Status is a resident's durable fact: a direct process refuses it typed.
      await expect(run.status()).rejects.toBeInstanceOf(NikaCompatibilityError);
    }, SLOW);

    it('cancels a run inside its task, settled by the operator', async () => {
      const run = await local().run('wait.nika');
      await delay(1_500);
      await expect(run.cancel()).resolves.toMatchObject({
        accepted: true, status: 'cancellation_requested', transport: 'native-process',
      });
      const result = await run.result();
      expect(result).toMatchObject({ status: 'cancelled', exitCode: 130 });
      expect(result.settlement).toMatchObject({ status: 'cancelled', cause: 'operator' });
    }, SLOW);

    it('pins the access path, and settles a pin the engine refuses as its typed failure', async () => {
      const pinned = await local().run('hello.nika', { access: 'mock' });
      const events = await collect(pinned.events());
      expect(events.at(-1)?.raw).toMatchObject({
        kind: 'run_settled',
        access_plan: [{ model: 'mock/echo', access: 'mock', pinned: true }],
      });
      await expect(pinned.result()).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
      for (const [pin, code, words] of [
        ['bogus-seat', 'NIKA-1802', 'names neither an access class nor a known agentic CLI'],
        ['codex-acp', 'NIKA-1802', 'is retired'],
        // One argv element: a pin that starts with a dash is still a value.
        ['-x', 'NIKA-1802', '`--access -x` names neither'],
        ['', 'NIKA-1802', 'names neither'],
        ['local', 'NIKA-1801', 'has no access path matching `--access local`'],
      ] as const) {
        const run = await local().run('hello.nika', { access: pin });
        const result = await run.result();
        expect(result).toMatchObject({
          status: 'failed', exitCode: 3, error: { code }, settlement: { status: 'failed', cause: 'refused' },
        });
        // With this HOME's signing key the refusal still seals a one-event trace.
        expect(result.error?.message).toContain(words);
      }
    }, SLOW);

    it('judges the access plan under a pin in the check report', async () => {
      const ready = await local().check('hello.nika', { access: 'mock' });
      expect(ready).toMatchObject({
        clean: true, exitCode: 0, verdicts: { access_ready: true }, access_plan: [{ pinned: true }],
      });
      const refused = await local().check('hello.nika', { access: 'bogus-seat' });
      // The file holds; the access layer does not, and says why.
      expect(refused).toMatchObject({ clean: true, exitCode: 0, verdicts: { access_ready: false, run_ready: false } });
      expect(refused.verdicts?.blockers?.[0]).toContain('pin `bogus-seat` refused');
    }, SLOW);

    it('names the tasks a mock rehearsal still reaches the network through', async () => {
      // Engine 0.124.1: ACCESS READY judges model routes only, and a mock model
      // stubs no tool. Check names `grab`, whose nika:fetch dials a real host,
      // without dialing it.
      const quiet = await local().check('hello.nika');
      expect(quiet.verdicts).toMatchObject({ access_ready: true, run_ready: true, network_tasks: [] });
      const dials = await local().check('dials.nika');
      expect(dials).toMatchObject({ clean: true, exitCode: 0 });
      expect(dials.verdicts).toMatchObject({ access_ready: true, run_ready: true, network_tasks: ['grab'] });
    }, SLOW);

    it('settles a result above 64 KiB by default, and names the line size past a smaller bound', async () => {
      const result = await (await local().run('big-echo.nika', { inputs: { blob: BLOB } })).result();
      expect(result).toMatchObject({ status: 'succeeded', exitCode: 0 });
      expect(result.outputs?.blob).toBe(BLOB);
      const small = new Nika({ bin: BIN, cwd: project, machineBufferBytes: 64 * 1024 });
      const refused = await refusal((await small.run('big-echo.nika', { inputs: { blob: BLOB } })).result());
      expect(refused).toBeInstanceOf(NikaProtocolError);
      const needed = Number(/it is (\d+) bytes/.exec(refused.message)?.[1]);
      expect(needed).toBeGreaterThan(BLOB.length);
      expect(refused.message).toBe(
        `Native machine line exceeded 65536 bytes (machineBufferBytes): it is ${needed} bytes. `
        + `Set machineBufferBytes to at least ${needed}`,
      );
    }, SLOW);

    it('compiles a scheduled intent into choice questions and answers one', async () => {
      const outcome = await local().compile(INTENT);
      expectScheduledChoices(outcome);
      const next = nextCompileRequest(INTENT, outcome, { 'trigger.missed': 'rattraper-une-fois' });
      const answered = await local().compile(next);
      expect(answered.requested_trigger).toMatchObject({ missed: 'rattraper-une-fois', overlap: null });
      expect(answered.questions.map((question) => question.key)).not.toContain('trigger.missed');
      expect(answered.questions.find((question) => question.key === 'trigger.overlap')?.type).toBe('choice');
    }, SLOW);
  });

  describe('a resident nika serve', () => {
    it('admits a served workflow by name and settles it with its receipt', async () => {
      const nika = remote();
      expect(await nika.listWorkflows()).toEqual([
        'big-echo.nika', 'chart.nika', 'dials.nika', 'fan.nika', 'hello.nika', 'long-wait.nika',
        'refused.nika', 'wait.nika',
      ]);
      const run = await nika.run('hello.nika', { idempotencyKey: 'live-by-name' });
      const seen = await kinds(run.events());
      expect(seen[0]).toBe('run.started');
      expect(seen.at(-1)).toBe('run.settled');
      const result = await run.result();
      expect(result).toMatchObject({ status: 'succeeded', transport: 'http', outputs: { greeting: 'mock(echo) · hello' } });
      expect(result.receipt).toMatchObject({ job_id: run.id, origin: { kind: 'manual' } });
      expect(result.settlement).toMatchObject({ status: 'succeeded', cause: 'normal' });
      expect(await run.status()).toBe('succeeded');
      await expect(nika.traceVerify(result.receipt!)).resolves.toMatchObject({ verified: true });
    }, SLOW);

    it('runs a local file through its snapshot, captured by the local engine', async () => {
      const run = await remote().run('./hello.nika', { idempotencyKey: 'live-snapshot' });
      const result = await run.result();
      expect(result).toMatchObject({ status: 'succeeded', outputs: { greeting: 'mock(echo) · hello' } });
    }, SLOW);

    it('cancels a running job and reads the terminal its reply leads to', async () => {
      const run = await remote().run('wait.nika', { idempotencyKey: 'live-cancel' });
      const deadline = Date.now() + 20_000;
      while (await run.status() !== 'running') {
        if (Date.now() > deadline) throw new Error('the job never ran');
        await delay(50);
      }
      await expect(run.artifacts()).rejects.toMatchObject({
        name: 'NikaOperationError', operation: 'artifacts', code: 'job_not_settled', status: 409,
      });
      const cancel = await run.cancel();
      expect(cancel).toMatchObject({ accepted: true, status: 'cancellation_requested', transport: 'http' });
      const result = await run.result();
      // 202: the grace expired inside the task (interrupted), or the request
      // landed at a task boundary (cancelled by the operator).
      expect(['interrupted', 'cancelled']).toContain(result.status);
      if (result.status === 'cancelled') expect(result.settlement?.cause).toBe('operator');
    }, SLOW);

    it('ends a job interrupted, not cancelled, once it outlives the 5-second cancel grace', async () => {
      const run = await remote().run('long-wait.nika', { idempotencyKey: 'live-cancel-grace' });
      const deadline = Date.now() + 20_000;
      while (await run.status() !== 'running') {
        if (Date.now() > deadline) throw new Error('the job never ran');
        await delay(50);
      }
      const asked = Date.now();
      await expect(run.cancel()).resolves.toMatchObject({ accepted: true, status: 'cancellation_requested' });
      const result = await run.result();
      const waited = Date.now() - asked;
      expect(result.status).toBe('interrupted');
      expect(result.settlement).toBeUndefined();
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(15_000);
      expect(await kinds(run.events())).toEqual(['run.started', 'run.interrupted']);
      await expect(run.status()).resolves.toBe('interrupted');
      // An interrupted run never sealed its journal: the server lists nothing for it.
      await expect(run.artifacts()).rejects.toMatchObject({
        name: 'NikaOperationError', operation: 'artifacts', code: 'artifact_journal_unavailable', status: 409,
      });
    }, SLOW);

    it('pins a served job\'s access path, and returns each refusal typed', async () => {
      const nika = remote();
      const pinned = await nika.run('hello.nika', { idempotencyKey: 'live-pin-mock', access: 'mock' });
      await expect(pinned.result()).resolves.toMatchObject({ status: 'succeeded', outputs: { greeting: 'mock(echo) · hello' } });
      for (const [pin, code] of [['bogus-seat', 'NIKA-1802'], ['codex-acp', 'NIKA-1802'], ['local', 'NIKA-1801']]) {
        // Admitted: the job's execution refuses the pin, before any task.
        const run = await nika.run('hello.nika', { idempotencyKey: `live-pin-${pin}`, access: pin });
        const result = await run.result();
        expect(result).toMatchObject({ status: 'failed', transport: 'http', error: { code } });
        expect(result.settlement).toBeUndefined();
      }
      // An empty or blank pin is refused at admission.
      for (const pin of ['', '  ']) {
        const refused = await refusal(nika.run('hello.nika', { idempotencyKey: `live-pin-empty-${pin.length}`, access: pin }));
        expect(refused).toBeInstanceOf(NikaOperationError);
        expect(refused).toMatchObject({ operation: 'run', code: 'NIKA-1802', status: 422 });
      }
      await expect(nika.run('./hello.nika', { idempotencyKey: 'live-pin-snapshot', access: 'mock' }))
        .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'snapshotAccess' });
      // The server's check is source-only: it acknowledges a pin it does not judge.
      await expect(nika.check('hello.nika', { access: 'bogus-seat' })).resolves.toMatchObject({ clean: true, status: 'accepted' });
      await expect(nika.check('hello.nika', { access: '' })).resolves.toMatchObject({ clean: false, error: { code: 'NIKA-1802' } });
    }, SLOW);

    it('settles a result above 64 KiB by default, and names the exact bound past a smaller one', async () => {
      const nika = remote();
      const run = await nika.run('big-echo.nika', { idempotencyKey: 'live-big', inputs: { blob: BLOB } });
      // A job with inputs opens with `execution.queued`, which the SDK names `engine.event`.
      const events = await collect(run.events());
      expect(events.map((event) => [event.kind, event.raw.kind, event.sequence])).toEqual([
        ['engine.event', 'execution.queued', 1],
        ['run.started', 'execution.started', 2],
        ['run.settled', 'execution.settled', 3],
      ]);
      expect((await run.result()).outputs?.blob).toBe(BLOB);
      expect((await (await nika.attachRun(run.id)).result()).outputs?.blob).toBe(BLOB);

      const bounded = (machineBufferBytes: number) => new Nika({ url, token: TOKEN, allowInsecureHttp: true, machineBufferBytes });
      const small = bounded(64 * 1024);
      const streamed = await refusal((await small.run('big-echo.nika', { idempotencyKey: 'live-big-small', inputs: { blob: BLOB } })).result());
      expect(streamed).toBeInstanceOf(NikaProtocolError);
      expect(streamed.message).toMatch(new RegExp(
        '^SSE event frame of job ([0-9a-f-]{36}) exceeded 65536 bytes \\(machineBufferBytes\\): it is (\\d+) bytes\\. '
        + `Set machineBufferBytes to at least \\2${LEAVE_UNSET.replace(/[.()]/g, '\\$&')}\\. `
        + "The job itself is unaffected: attachRun\\('\\1'\\) reads it again$",
      ));
      // The record's size comes from its Content-Length, and it is exactly enough.
      const record = await refusal(small.attachRun(run.id));
      const needed = Number(/it is (\d+) bytes/.exec(record.message)?.[1]);
      expect(record.message).toBe(
        `HTTP /v1/jobs/${run.id} JSON exceeded 65536 bytes (machineBufferBytes): it is ${needed} bytes. `
        + `Set machineBufferBytes to at least ${needed}${LEAVE_UNSET}`,
      );
      expect((await (await bounded(needed).attachRun(run.id)).result()).outputs?.blob).toBe(BLOB);
      await expect(bounded(needed - 1).attachRun(run.id)).rejects.toThrow(`it is ${needed} bytes`);
    }, SLOW);

    it('lists and downloads what a settled job recorded, proven against its sealed journal', async () => {
      const nika = remote();
      const run = await nika.run('chart.nika', { idempotencyKey: 'live-artifacts' });
      const result = await run.result();
      expect(result).toMatchObject({ status: 'succeeded', transport: 'http' });
      const file = path.join(project, 'out', 'totals.svg');
      const written = readFileSync(file);
      const digest = createHash('sha256').update(written).digest('hex');

      const manifest = await run.artifacts();
      expect(manifest).toEqual({
        receipt: result.receipt,
        verdict: 'sealed',
        max_artifact_bytes: 256 * 1024 * 1024,
        truncated: false,
        artifacts: [{
          name: 'file/out/totals.svg',
          kind: 'file',
          path: 'out/totals.svg',
          size: written.length,
          sha256: digest,
          mime: 'image/svg+xml',
          task: 'draw',
          event_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        }],
      });
      const [entry] = manifest.artifacts;

      // By name: the stream, piped to a file, closes once its bytes are proven.
      const download = await run.downloadArtifact(entry!.name);
      expect(download).toMatchObject({ name: entry!.name, size: written.length, sha256: digest, mime: 'image/svg+xml' });
      const copy = path.join(root, 'totals.copy.svg');
      await pipeline(Readable.fromWeb(download.stream), createWriteStream(copy));
      expect(readFileSync(copy).equals(written)).toBe(true);
      // By entry, whole; and through the recovery door, from another client.
      expect(Buffer.from(await run.readArtifact(entry!)).equals(written)).toBe(true);
      const recovered = await remote().attachRun(run.id);
      expect(Buffer.from(await recovered.readArtifact('file/out/totals.svg')).equals(written)).toBe(true);
      await expect(recovered.artifacts()).resolves.toEqual(manifest);

      // What the server serves is what the journal recorded, or nothing.
      writeFileSync(file, Buffer.concat([written, Buffer.from('<!-- edited -->')]));
      await expect(run.readArtifact(entry!)).rejects.toMatchObject({
        name: 'NikaOperationError', operation: 'readArtifact', code: 'artifact_changed', status: 409,
      });
      writeFileSync(file, written);
      expect(Buffer.from(await run.readArtifact(entry!)).equals(written)).toBe(true);
      await expect(run.downloadArtifact('file/out/absent.svg')).rejects.toMatchObject({
        name: 'NikaOperationError', code: 'artifact_not_found', status: 404,
      });
      await expect(run.readArtifact(entry!, { maxBytes: written.length - 1 })).rejects.toMatchObject({
        name: 'NikaConfigurationError',
      });

      // The served headers the SDK checks, and the ones it leaves to a browser.
      const raw = await fetch(`${url}/v1/jobs/${run.id}/artifacts/file%2Fout%2Ftotals.svg`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(Object.fromEntries([...raw.headers].filter(([name]) => name !== 'date' && name !== 'connection'))).toEqual({
        'content-type': 'image/svg+xml',
        'content-length': String(written.length),
        'nika-artifact-sha256': digest,
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'cache-control': 'no-store',
      });
      await raw.body?.cancel();

      // A local run has no manifest: a typed gap, never an invented path.
      const localRun = await local().run('hello.nika');
      await expect(localRun.artifacts()).rejects.toMatchObject({
        name: 'NikaCompatibilityError', capability: 'artifacts', transport: 'native-process',
      });
      await localRun.result();
    }, SLOW);

    it('lists each file a for_each fan-out saved, one entry per item', async () => {
      // Engine 0.124.1 reads a fan-out's tool from the task's own journal;
      // 0.124.0 listed none of its files.
      const run = await remote().run('fan.nika', { idempotencyKey: 'live-fan-out' });
      expect(await run.result()).toMatchObject({ status: 'succeeded', transport: 'http' });
      const { artifacts } = await run.artifacts();
      expect(artifacts.map((entry) => entry.name).sort()).toEqual(['file/out/fan-a.svg', 'file/out/fan-b.svg']);
      for (const entry of artifacts) {
        const written = readFileSync(path.join(project, entry.path!));
        expect(entry).toMatchObject({
          kind: 'file',
          task: 'draw',
          mime: 'image/svg+xml',
          size: written.length,
          sha256: createHash('sha256').update(written).digest('hex'),
        });
        expect(Buffer.from(await run.readArtifact(entry)).equals(written)).toBe(true);
      }
    }, SLOW);

    it('serves no artifact from a server without a run key, which seals no journal', async () => {
      // Another server, in a HOME without `nika key init`: it still lists `artifacts`.
      const keyless = path.join(root, 'keyless');
      mkdirSync(path.join(keyless, 'home'), { recursive: true });
      mkdirSync(path.join(keyless, 'project'));
      writeFileSync(path.join(keyless, 'project', 'nika.yaml'), 'nika: engine-live-keyless\n');
      writeFileSync(path.join(keyless, 'project', 'chart.nika'), WORKFLOWS['chart.nika']!);
      const server = spawn(BIN!, [
        'serve', '--bind', '127.0.0.1:0', '--workflows', path.join(keyless, 'project'),
        '--token-file', path.join(root, 'token'), '--state-root', path.join(keyless, 'state'), '--plain',
      ], {
        cwd: path.join(keyless, 'project'),
        env: { ...process.env, HOME: path.join(keyless, 'home') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        let log = '';
        server.stdout!.on('data', (chunk) => { log += String(chunk); });
        server.stderr!.on('data', (chunk) => { log += String(chunk); });
        let keylessUrl = '';
        const deadline = Date.now() + 20_000;
        while (!keylessUrl) {
          const listening = log.match(/nika serve[^\n]*listening (http:\/\/127\.0\.0\.1:\d+)/);
          if (listening) keylessUrl = listening[1]!;
          else if (Date.now() > deadline || server.exitCode !== null) throw new Error(`nika serve did not listen: ${log}`);
          else await delay(25);
        }
        const nika = new Nika({ url: keylessUrl, token: TOKEN, allowInsecureHttp: true });
        const run = await nika.run('chart.nika', { idempotencyKey: 'live-artifacts-keyless' });
        await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
        for (const refused of [() => run.artifacts(), () => run.readArtifact('file/out/totals.svg')]) {
          await expect(refused()).rejects.toMatchObject({
            name: 'NikaOperationError', code: 'artifact_journal_unverified', status: 409,
          });
        }
      } finally {
        server.kill('SIGINT');
        if (!await untilSettled(server, 5_000)) server.kill('SIGKILL');
      }
    }, SLOW);

    it('applies a schedule, reads its status and updates it at its revision', async () => {
      const nika = remote();
      const declaration = {
        id: 'live-weekly',
        when: { kind: 'cadence' as const, expression: 'TZ=UTC 0 9 * * 1' },
        maxCostUsd: 0.01,
        missed: 'catch-up-once' as const,
      };
      const applied = await nika.schedule('hello.nika', declaration);
      expect(applied).toMatchObject({ applied: true, changed: true });
      const status = await nika.scheduleStatus('live-weekly');
      expect(status.definition).toMatchObject({ id: 'live-weekly', workflow: 'hello.nika', missed: 'catch-up-once' });
      expect(status.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(status.next[0]?.scheduledFor).toMatch(/T09:00:00Z$/);
      const paused = await nika.schedule('hello.nika', {
        ...declaration,
        revision: status.revision,
        active: false,
        pauseReason: 'engine live test',
        pauseUntil: '2099-01-01',
      });
      expect(paused.status.active).toBe(false);
      expect(paused.status.revision).not.toBe(status.revision);
      await expect(nika.schedule('hello.nika', { ...declaration, revision: status.revision }))
        .rejects.toMatchObject({ name: 'NikaOperationError', code: 'schedule_conflict' });
    }, SLOW);

    it('compiles the same choice questions as the local engine', async () => {
      const [native, http] = await Promise.all([local().compile(INTENT), remote().compile(INTENT)]);
      expectScheduledChoices(http);
      expect(http.questions).toEqual(native.questions);
      expect(http.requested_trigger).toEqual(native.requested_trigger);
    }, SLOW);
  });
});

/** The questions engine 0.123 asks beside a weekly cadence, two of them choices. */
function expectScheduledChoices(outcome: NikaCompileOutcome): void {
  expect(outcome).toMatchObject({ compile_version: 1, status: 'incomplete', ready: false });
  const choices = outcome.questions.filter((question) => question.type === 'choice');
  expect(choices.map((question) => [question.key, question.options?.map((option) => option.key)])).toEqual([
    ['trigger.missed', ['rattraper', 'rattraper-une-fois', 'sauter']],
    ['trigger.overlap', ['sauter', 'file', 'remplacer']],
  ]);
  expect(choices.every((question) => question.mandatory === false)).toBe(true);
  expect(outcome.requested_trigger).toMatchObject({ kind: 'schedule', cron: '0 9 * * 1', status: 'requires_binding' });
}
