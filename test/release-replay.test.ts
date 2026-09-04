import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isDurableCancellationTerminal,
  stableDepthEvidence,
  stableHostileEvidence,
  verifyReleaseReplay,
} from '../scripts/verify-release-replay.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const committedResults = path.join(ROOT, 'gauntlet', 'results');
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('public release evidence replay', () => {
  it('keeps cancellation replay portable without a sandbox waiver', () => {
    const hostileRunner = readFileSync(
      path.join(ROOT, 'scripts', 'run-hostile-gauntlet.mjs'),
      'utf8',
    );
    const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(hostileRunner).toContain('cancellationFixture(gate.url)');
    expect(hostileRunner).toContain('cancelHeldRun(client, run, gate)');
    expect(hostileRunner).toContain('isDurableCancellationTerminal(events.at(-1))');
    expect(hostileRunner).not.toContain("events.includes('execution.cancelled')");
    expect(hostileRunner).not.toContain('command: ["sleep"');
    expect(hostileRunner).not.toContain('return { runs: 40, succeeded: 40 }');
    expect(hostileRunner).not.toContain('real_engine_runs: 70');
    expect(hostileRunner).toContain('return { runs: succeeded, succeeded }');
    expect(hostileRunner).toContain('real_engine_runs: realEngineRuns');
    expect(workflow).not.toContain('NIKA_SANDBOX');
  });

  it.each([
    ['execution.cancelled', 'cancelled'],
    ['execution.settled', 'cancelled'],
  ])('accepts the ratified %s cancellation winner with cancelled status', (kind, status) => {
    expect(isDurableCancellationTerminal({ kind, status })).toBe(true);
  });

  it.each([
    ['execution.started', 'cancelled'],
    ['execution.cancelled', 'failed'],
    ['execution.settled', 'succeeded'],
    ['execution.refused', 'cancelled'],
  ])('rejects cancellation replay terminal %s/%s', (kind, status) => {
    expect(isDurableCancellationTerminal({ kind, status })).toBe(false);
  });

  it('compares every deterministic field while excluding only hostile timing metadata', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.generated_at = '2099-01-01T00:00:00.000Z';
    for (const scenario of hostile.scenarios) scenario.duration_ms += 10_000;
    writeJson(replay, 'hostile.json', hostile);

    expect(verifyReleaseReplay(ROOT, replay)).toMatchObject({
      engine: 'nika 0.116.2 (c4cdbeafb)',
      workflows: 100,
      hostileScenarios: 14,
      realEngineRuns: 70,
    });
  });

  it('normalizes only the two ratified durable cancellation race winners', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    const cancellation = hostile.scenarios.find(
      (scenario: any) => scenario.name === 'remote-durable-cancellation',
    );
    cancellation.evidence.events.at(-1).kind = 'execution.settled';
    writeJson(replay, 'hostile.json', hostile);

    expect(verifyReleaseReplay(ROOT, replay)).toMatchObject({ hostileScenarios: 14 });
  });

  it('refuses a cancellation terminal writer with a non-cancelled status', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    const cancellation = hostile.scenarios.find(
      (scenario: any) => scenario.name === 'remote-durable-cancellation',
    );
    cancellation.evidence.events.at(-1).status = 'failed';
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'remote cancellation replay lacks an exact cancelled terminal frame',
    );
  });

  it('refuses a rewritten engine identity', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.engine = 'nika 0.116.0 (b38267751)';
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'hostile replay does not match committed stable behavioral evidence',
    );
  });

  it('refuses a stale or edited behavioral claim even when identity is current', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.scenarios[0].evidence.network_requests = 1;
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'hostile replay does not match committed stable behavioral evidence',
    );
  });

  it('refuses empty or red mini-SaaS replay evidence', () => {
    const replay = createReplay();
    const miniSaas = readJson(replay, 'mini-saas.json');
    miniSaas.projects = [];
    miniSaas.result = 'red';
    writeJson(replay, 'mini-saas.json', miniSaas);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'mini-SaaS replay does not match committed behavioral evidence',
    );
  });

  it('refuses a failed depth-project replay summary', () => {
    const replay = createReplay();
    const depth = readJson(replay, 'depth-projects.json');
    depth.summary = { total: 5, succeeded: 0, result: 'red' };
    writeJson(replay, 'depth-projects.json', depth);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'depth-project replay does not match committed stable behavioral evidence',
    );
  });

  it('refuses failed or unpacked recovery replay evidence', () => {
    const replay = createReplay();
    const recovery = readJson(replay, 'recovery-e2e.json');
    recovery.process_count = 1;
    recovery.installed_from_pack = false;
    recovery.status = 'failed';
    writeJson(replay, 'recovery-e2e.json', recovery);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'recovery replay does not match committed stable behavioral evidence',
    );
  });

  it('refuses contradictory depth terminal and event-kind evidence', () => {
    const replay = createReplay();
    const depth = readJson(replay, 'depth-projects.json');
    const incident = depth.projects.find(
      (project: any) => project.project === 'incident-response-controller',
    );
    incident.sse_terminal.kind = 'execution.settled';
    writeJson(replay, 'depth-projects.json', depth);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'depth cancellation project lacks an exact cancelled terminal result',
    );
  });

  it('refuses a missing or malformed recovery job identity', () => {
    const replay = createReplay();
    const recovery = readJson(replay, 'recovery-e2e.json');
    recovery.job_id = 'not-a-uuid';
    writeJson(replay, 'recovery-e2e.json', recovery);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'recovery evidence lacks a valid job UUID',
    );
  });
});

function createReplay(): string {
  const replay = mkdtempSync(path.join(tmpdir(), 'nika-release-replay-'));
  scratch.push(replay);
  for (const name of [
    'local-execution.json',
    'hostile.json',
    'mini-saas.json',
    'recovery-e2e.json',
  ]) {
    writeFileSync(path.join(replay, name), readFileSync(path.join(committedResults, name)));
  }
  writeFileSync(
    path.join(replay, 'depth-projects.json'),
    readFileSync(path.join(ROOT, 'gauntlet', 'projects-depth', 'results.json')),
  );
  return replay;
}

function readJson(directory: string, name: string): any {
  return JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
}

function writeJson(directory: string, name: string, value: unknown): void {
  writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

const currentCancellation = {
  settlement: { status: 'cancelled', cause: 'operator',
    tasks: { total: 2, ok: 1, failed: 0, recovered: 0, skipped: 0, cancelled: 1, never_started: 1 },
    spend: { qualifier: 'unmetered', priced_calls: 0, unpriced_calls: 0 }, error_code: null, error_task: null },
  cancellation_rendezvous: { requests: { hold: 1, dependent: 0 }, dependent_unstarted: true,
    cancel_point: 'loopback fetch held before response', release: 'after cancellation request acknowledgement' },
  same_job_terminal_and_replay_matched: true,
};
function currentDepth(): any {
  return { engine: 'nika 0.118.1 (71397bf28)', projects: [{
    project: 'incident-response-controller', cancellation_status: 'cancellation_requested',
    cancelled_run_status: 'cancelled', cancellation_idempotent: true,
    sse_event_kinds: ['execution.started', 'execution.cancelled'],
    sse_terminal: { kind: 'execution.cancelled', status: 'cancelled' }, ...structuredClone(currentCancellation),
  }] };
}
describe('current cancellation evidence separates the action from the actual result', () => {
  it('accepts the request acknowledgement only with controlled actual cancellation', () => {
    expect(() => stableDepthEvidence(currentDepth())).not.toThrow();
  });
  it.each(['succeeded', 'failed', 'interrupted'])('rejects a fabricated cancelled result over %s facts', (status) => {
    const report = currentDepth();
    report.projects[0].settlement.status = status;
    expect(() => stableDepthEvidence(report)).toThrow();
  });
  it.each([
    (p: any) => { p.cancellation_status = 'cancelled'; },
    (p: any) => { delete p.settlement; },
    (p: any) => { p.cancellation_rendezvous.requests.dependent = 1; },
    (p: any) => { p.settlement.tasks.never_started = 0; },
    (p: any) => { p.same_job_terminal_and_replay_matched = false; },
  ])('refuses obsolete, missing or contradictory cancellation proof', (mutate) => {
    const report = currentDepth();
    mutate(report.projects[0]);
    expect(() => stableDepthEvidence(report)).toThrow();
  });
  it('requires both current hostile cancellation cases to be green with actual engine facts', () => {
    const report: any = { engine: 'nika 0.118.1 (71397bf28)', scenarios: [
      { name: 'real-cancellation-race', result: 'green', evidence: { ...structuredClone(currentCancellation),
        cancel_status: 'cancellation_requested', run_status: 'cancelled', same_job_terminal_matched: true,
        terminal: { kind: 'run_settled', status: 'cancelled' } } },
      { name: 'remote-durable-cancellation', result: 'green', evidence: { ...structuredClone(currentCancellation),
        cancel_status: 'cancellation_requested', run_status: 'cancelled',
        events: [{ kind: 'execution.cancelled', status: 'cancelled' }] } },
    ] };
    expect(() => stableHostileEvidence(report)).not.toThrow();
    report.scenarios[0].evidence.settlement.status = 'succeeded';
    expect(() => stableHostileEvidence(report)).toThrow();
    report.scenarios = [];
    expect(() => stableHostileEvidence(report)).toThrow();
  });
});
