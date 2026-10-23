import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaOperationError,
  isNikaRunSucceeded,
  nextCompileRequest,
} from '../src/index.js';
import type { NikaCheckFinding, NikaCompileOutcome, NikaRunEvent } from '../src/index.js';
import { MACHINE_PROTOCOL_VERSION } from '../src/lib/engine-identity.js';

// The SDK against a real engine, end to end: the public API on both doors,
// driving the binary `NIKA_BIN` names (the SDK's own override), and a
// `nika serve --bind` this file starts from the same binary. Skipped without
// `NIKA_BIN`. Written for engine 0.123 (machine protocol 2): run it as
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
};

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
      expect(await nika.listWorkflows()).toEqual(['hello.nika', 'refused.nika', 'wait.nika']);
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
      const cancel = await run.cancel();
      expect(cancel).toMatchObject({ accepted: true, status: 'cancellation_requested', transport: 'http' });
      const result = await run.result();
      // 202: the grace expired inside the task (interrupted), or the request
      // landed at a task boundary (cancelled by the operator).
      expect(['interrupted', 'cancelled']).toContain(result.status);
      if (result.status === 'cancelled') expect(result.settlement?.cause).toBe('operator');
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
