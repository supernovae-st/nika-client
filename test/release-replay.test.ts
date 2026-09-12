import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancellationTerminalMatches,
  isDurableCancellationTerminal,
  isInterruptedCancellationTerminal,
  isOperatorCancelledTerminal,
  stableDepthEvidence,
  stableHostileEvidence,
  verifyReleaseReplay,
} from '../scripts/verify-release-replay.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const committedResults = path.join(ROOT, 'gauntlet', 'results');
const ENGINE = 'nika 0.119.0 (d2f89bedd)';
const STABLE_CANCELLED_KIND = 'execution.cancelled|execution.settled';
// The 200 shape: the resident cancelled the job before its execution started.
const CANCELLED_BEFORE_EXECUTION = {
  cancel_status: 'cancelled',
  run_status: 'cancelled',
  events: [{ kind: 'execution.cancelled', status: 'cancelled' }],
};
// The 202 shape the fixtures record: the request landed inside a task and the
// execution owner recorded the interruption once its grace expired.
const INTERRUPTED_IN_FLIGHT = {
  status_before_cancellation: 'running',
  cancel_status: 'cancellation_requested',
  run_status: 'interrupted',
  events: [
    { kind: 'execution.started', status: 'running' },
    { kind: 'execution.interrupted', status: 'interrupted' },
  ],
};
// The other 202 shape: the request landed at a task boundary and the execution
// owner settled the run cancelled by the operator.
const CANCELLED_AT_BOUNDARY = {
  status_before_cancellation: 'running',
  cancel_status: 'cancellation_requested',
  run_status: 'cancelled',
  events: [
    { kind: 'execution.started', status: 'running' },
    { kind: 'execution.cancelled', status: 'cancelled', settlement_cause: 'operator' },
  ],
};
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

    expect(hostileRunner).toContain('tools: ["nika:wait"]');
    expect(hostileRunner).toContain('args: { duration: "10s" }');
    expect(hostileRunner).toContain("assert.equal(statusBeforeCancellation, 'running')");
    expect(hostileRunner).toContain('cancellationTerminalMatches(waitCancellation.status, waitTerminal)');
    expect(hostileRunner).not.toContain("events.includes('execution.cancelled')");
    expect(hostileRunner).not.toContain("events.includes('execution.interrupted')");
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
    ['execution.interrupted', 'interrupted'],
    ['execution.interrupted', 'cancelled'],
  ])('rejects cancellation replay terminal %s/%s', (kind, status) => {
    expect(isDurableCancellationTerminal({ kind, status })).toBe(false);
  });

  it('accepts the interrupted terminal a 202 reply leads to', () => {
    expect(isInterruptedCancellationTerminal({ kind: 'execution.interrupted', status: 'interrupted' }))
      .toBe(true);
  });

  it.each([
    ['execution.interrupted', 'cancelled'],
    ['execution.cancelled', 'interrupted'],
    ['execution.settled', 'interrupted'],
    ['execution.interrupted', 'failed'],
  ])('rejects interrupted terminal %s/%s', (kind, status) => {
    expect(isInterruptedCancellationTerminal({ kind, status })).toBe(false);
  });

  it('rejects an interrupted terminal that carries a settlement', () => {
    expect(isInterruptedCancellationTerminal({
      kind: 'execution.interrupted',
      status: 'interrupted',
      settlement_cause: 'budget',
    })).toBe(false);
    expect(isInterruptedCancellationTerminal({
      kind: 'execution.interrupted',
      status: 'interrupted',
      settlement: { cause: 'operator' },
    })).toBe(false);
  });

  it.each([
    ['execution.cancelled', 'cancelled', 'operator', true],
    ['execution.settled', 'cancelled', 'operator', true],
    ['execution.cancelled', 'cancelled', undefined, false],
    ['execution.cancelled', 'cancelled', 'normal', false],
    ['execution.cancelled', 'cancelled', 'budget', false],
    ['execution.interrupted', 'interrupted', 'operator', false],
    ['execution.settled', 'failed', 'operator', false],
  ])('reads %s/%s with cause %s as an operator cancellation: %s', (kind, status, cause, verdict) => {
    expect(isOperatorCancelledTerminal({ kind, status, settlement_cause: cause })).toBe(verdict);
  });

  it('rejects a missing terminal under every law', () => {
    expect(isDurableCancellationTerminal(undefined)).toBe(false);
    expect(isInterruptedCancellationTerminal(null)).toBe(false);
    expect(isOperatorCancelledTerminal(undefined)).toBe(false);
    expect(cancellationTerminalMatches('cancelled', undefined)).toBe(false);
    expect(cancellationTerminalMatches('cancellation_requested', null)).toBe(false);
  });

  it.each([
    ['cancelled', { kind: 'execution.cancelled', status: 'cancelled' }],
    ['cancelled', { kind: 'execution.settled', status: 'cancelled' }],
    ['cancellation_requested', { kind: 'execution.interrupted', status: 'interrupted' }],
    ['cancellation_requested', { kind: 'execution.cancelled', status: 'cancelled', settlement_cause: 'operator' }],
    ['cancellation_requested', { kind: 'execution.settled', status: 'cancelled', settlement_cause: 'operator' }],
  ])('binds the cancel reply %s to the terminal %j', (cancelStatus, terminal) => {
    expect(cancellationTerminalMatches(cancelStatus, terminal)).toBe(true);
  });

  it.each([
    ['cancellation_requested', { kind: 'execution.cancelled', status: 'cancelled' }],
    ['cancellation_requested', { kind: 'execution.settled', status: 'cancelled', settlement_cause: 'normal' }],
    ['cancellation_requested', { kind: 'execution.settled', status: 'succeeded', settlement_cause: 'operator' }],
    ['cancellation_requested', { kind: 'execution.interrupted', status: 'failed' }],
    ['cancellation_requested', { kind: 'execution.interrupted', status: 'interrupted', settlement_cause: 'budget' }],
    ['cancelled', { kind: 'execution.interrupted', status: 'interrupted' }],
    ['cancelled', { kind: 'execution.cancelled', status: 'interrupted' }],
    ['already_settled', { kind: 'execution.cancelled', status: 'cancelled' }],
    ['already_settled', { kind: 'execution.interrupted', status: 'interrupted' }],
    [undefined, { kind: 'execution.cancelled', status: 'cancelled', settlement_cause: 'operator' }],
  ])('refuses the pairing %s → %j', (cancelStatus, terminal) => {
    expect(cancellationTerminalMatches(cancelStatus, terminal)).toBe(false);
  });

  it('canonicalizes the two ratified writer kinds of a cancelled terminal to one token', () => {
    const cancelJobWriter = stableHostileEvidence(hostileReport(CANCELLED_BEFORE_EXECUTION));
    const settlementWriter = stableHostileEvidence(hostileReport({
      ...CANCELLED_BEFORE_EXECUTION,
      events: [{ kind: 'execution.settled', status: 'cancelled' }],
    }));
    const boundaryCancelJobWriter = stableHostileEvidence(hostileReport(CANCELLED_AT_BOUNDARY));
    const boundarySettlementWriter = stableHostileEvidence(hostileReport({
      ...CANCELLED_AT_BOUNDARY,
      events: [
        { kind: 'execution.started', status: 'running' },
        { kind: 'execution.settled', status: 'cancelled', settlement_cause: 'operator' },
      ],
    }));

    expect(cancelJobWriter).toEqual(settlementWriter);
    expect(cancelJobWriter.scenarios[0].evidence.events.at(-1)).toEqual({
      kind: STABLE_CANCELLED_KIND,
      status: 'cancelled',
    });
    expect(boundaryCancelJobWriter).toEqual(boundarySettlementWriter);
    expect(boundaryCancelJobWriter.scenarios[0].evidence.events.at(-1)).toEqual({
      kind: STABLE_CANCELLED_KIND,
      status: 'cancelled',
      settlement_cause: 'operator',
    });
    expect(boundaryCancelJobWriter).not.toEqual(cancelJobWriter);
  });

  it('keeps the interrupted terminal of a 202 reply exact and distinct', () => {
    const interrupted = stableHostileEvidence(hostileReport(INTERRUPTED_IN_FLIGHT));

    expect(interrupted.scenarios[0].evidence.events).toEqual(INTERRUPTED_IN_FLIGHT.events);
    expect(interrupted).not.toEqual(stableHostileEvidence(hostileReport(CANCELLED_AT_BOUNDARY)));
    expect(interrupted).not.toEqual(stableHostileEvidence(hostileReport(CANCELLED_BEFORE_EXECUTION)));
  });

  it.each([
    ['a 202 whose cancelled terminal carries no operator cause', {
      ...CANCELLED_AT_BOUNDARY,
      events: [
        { kind: 'execution.started', status: 'running' },
        { kind: 'execution.cancelled', status: 'cancelled' },
      ],
    }],
    ['a 202 whose terminal settled for another cause', {
      ...CANCELLED_AT_BOUNDARY,
      events: [
        { kind: 'execution.started', status: 'running' },
        { kind: 'execution.settled', status: 'cancelled', settlement_cause: 'budget' },
      ],
    }],
    ['a 202 whose interrupted terminal carries a settlement cause', {
      ...INTERRUPTED_IN_FLIGHT,
      events: [
        { kind: 'execution.started', status: 'running' },
        { kind: 'execution.interrupted', status: 'interrupted', settlement_cause: 'budget' },
      ],
    }],
    ['a 200 whose terminal reads interrupted', {
      ...CANCELLED_BEFORE_EXECUTION,
      run_status: 'interrupted',
      events: [{ kind: 'execution.interrupted', status: 'interrupted' }],
    }],
    ['a run status that contradicts its interrupted terminal', {
      ...INTERRUPTED_IN_FLIGHT,
      run_status: 'cancelled',
    }],
    ['a run status that contradicts its cancelled terminal', {
      ...CANCELLED_AT_BOUNDARY,
      run_status: 'interrupted',
    }],
    ['a cancel reply that is not a cancellation', {
      ...CANCELLED_BEFORE_EXECUTION,
      cancel_status: 'already_settled',
    }],
    ['a terminal that succeeded after the request', {
      ...CANCELLED_AT_BOUNDARY,
      run_status: 'succeeded',
      events: [
        { kind: 'execution.started', status: 'running' },
        { kind: 'execution.settled', status: 'succeeded', settlement_cause: 'normal' },
      ],
    }],
    ['a missing event list', { ...CANCELLED_BEFORE_EXECUTION, events: undefined }],
  ])('refuses hostile cancellation evidence with %s', (_label, evidence) => {
    expect(() => stableHostileEvidence(hostileReport(evidence))).toThrow(
      'remote cancellation replay lacks the exact terminal frame its cancel reply leads to',
    );
  });

  it('canonicalizes the two ratified depth writer kinds and keeps the interrupted one exact', () => {
    const cancelJobWriter = stableDepthEvidence(depthReport({
      cancellation_status: 'cancelled',
      cancelled_run_status: 'cancelled',
      sse_event_kinds: ['execution.cancelled'],
      sse_terminal: { kind: 'execution.cancelled', status: 'cancelled' },
    }));
    const settlementWriter = stableDepthEvidence(depthReport({
      cancellation_status: 'cancelled',
      cancelled_run_status: 'cancelled',
      sse_event_kinds: ['execution.settled'],
      sse_terminal: { kind: 'execution.settled', status: 'cancelled' },
    }));
    const boundary = stableDepthEvidence(depthReport(depthCancelledAtBoundary()));
    const interrupted = stableDepthEvidence(depthReport(depthInterrupted()));

    expect(cancelJobWriter).toEqual(settlementWriter);
    expect(cancelJobWriter.projects[0].sse_terminal).toEqual({
      kind: STABLE_CANCELLED_KIND,
      status: 'cancelled',
    });
    expect(boundary.projects[0].sse_terminal).toEqual({
      kind: STABLE_CANCELLED_KIND,
      status: 'cancelled',
      settlement_cause: 'operator',
    });
    expect(boundary.projects[0].sse_event_kinds).toEqual([STABLE_CANCELLED_KIND, 'execution.started']);
    expect(interrupted.projects[0].sse_terminal).toEqual({
      kind: 'execution.interrupted',
      status: 'interrupted',
    });
    expect(interrupted.projects[0].sse_event_kinds).toEqual(['execution.interrupted', 'execution.started']);
  });

  it.each([
    ['a 202 whose cancelled terminal carries no operator cause', {
      ...depthCancelledAtBoundary(),
      sse_terminal: { kind: 'execution.cancelled', status: 'cancelled' },
    }],
    ['a 202 whose interrupted terminal carries a settlement cause', {
      ...depthInterrupted(),
      sse_terminal: { kind: 'execution.interrupted', status: 'interrupted', settlement_cause: 'budget' },
    }],
    ['a run status that contradicts its terminal', {
      ...depthInterrupted(),
      cancelled_run_status: 'cancelled',
    }],
    ['event kinds that name another cancellation terminal', {
      ...depthInterrupted(),
      sse_event_kinds: ['execution.cancelled', 'execution.started'],
    }],
    ['event kinds that name two cancellation terminals', {
      ...depthInterrupted(),
      sse_event_kinds: ['execution.interrupted', 'execution.settled', 'execution.started'],
    }],
    ['a non-idempotent cancellation', { ...depthInterrupted(), cancellation_idempotent: false }],
    ['a cancel reply that is not a cancellation', {
      ...depthInterrupted(),
      cancellation_status: 'already_settled',
    }],
  ])('refuses depth cancellation evidence with %s', (_label, incident) => {
    expect(() => stableDepthEvidence(depthReport(incident))).toThrow(
      'depth cancellation project lacks the exact cancellation terminal its cancel reply leads to',
    );
  });

  it('compares every deterministic field while excluding only hostile timing metadata', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.generated_at = '2099-01-01T00:00:00.000Z';
    for (const scenario of hostile.scenarios) scenario.duration_ms += 10_000;
    writeJson(replay, 'hostile.json', hostile);

    expect(verifyReleaseReplay(ROOT, replay)).toMatchObject({
      engine: ENGINE,
      workflows: 100,
      hostileScenarios: 14,
      realEngineRuns: 72,
    });
  });

  it('refuses a replayed cancellation whose reply and terminal disagree', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    const cancellation = hostile.scenarios.find(
      (scenario: any) => scenario.name === 'remote-durable-cancellation',
    );
    cancellation.evidence.events.at(-1).kind = 'execution.settled';
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'remote cancellation replay lacks the exact terminal frame its cancel reply leads to',
    );
  });

  it('refuses a cancellation terminal writer with a non-terminal status', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    const cancellation = hostile.scenarios.find(
      (scenario: any) => scenario.name === 'remote-durable-cancellation',
    );
    cancellation.evidence.events.at(-1).status = 'failed';
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'remote cancellation replay lacks the exact terminal frame its cancel reply leads to',
    );
  });

  it.each([
    ['the 200 shape', CANCELLED_BEFORE_EXECUTION],
    ['the boundary shape', CANCELLED_AT_BOUNDARY],
  ])('refuses a replay that observed %s instead of the committed one', (_label, evidence) => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    const cancellation = hostile.scenarios.find(
      (scenario: any) => scenario.name === 'remote-durable-cancellation',
    );
    cancellation.evidence = { ...cancellation.evidence, ...evidence };
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'hostile replay does not match committed stable behavioral evidence',
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
      'depth cancellation project lacks the exact cancellation terminal its cancel reply leads to',
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

function hostileReport(evidence: Record<string, unknown> | undefined): any {
  return {
    schema_version: 1,
    generated_at: '2026-09-07T00:00:00.000Z',
    engine: ENGINE,
    scenarios: [
      { name: 'remote-durable-cancellation', result: 'green', duration_ms: 5_100, evidence },
    ],
    summary: { total: 1, green: 1, red: 0, real_engine_runs: 1 },
    result: 'green',
  };
}

function depthInterrupted(): Record<string, unknown> {
  return {
    status_before_cancellation: 'running',
    cancellation_status: 'cancellation_requested',
    cancelled_run_status: 'interrupted',
    sse_event_kinds: ['execution.interrupted', 'execution.started'],
    sse_terminal: { kind: 'execution.interrupted', status: 'interrupted' },
  };
}

function depthCancelledAtBoundary(): Record<string, unknown> {
  return {
    status_before_cancellation: 'running',
    cancellation_status: 'cancellation_requested',
    cancelled_run_status: 'cancelled',
    sse_event_kinds: ['execution.cancelled', 'execution.started'],
    sse_terminal: { kind: 'execution.cancelled', status: 'cancelled', settlement_cause: 'operator' },
  };
}

function depthReport(incident: Record<string, unknown>): any {
  return {
    schema_version: 1,
    engine: ENGINE,
    package: 'supernovae-st-nika-0.119.0.tgz',
    projects: [{
      project: 'incident-response-controller',
      status: 'succeeded',
      cancellation_idempotent: true,
      ...incident,
      installed_from_pack: true,
    }],
    summary: { total: 1, succeeded: 1, result: 'green' },
  };
}

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
