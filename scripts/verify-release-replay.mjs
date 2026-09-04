import assert from 'node:assert/strict';
import { compareControlledCancellation } from './one-door/contract.mjs';
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const CANCELLATION_TERMINAL_KINDS = new Set([
  "execution.cancelled",
  "execution.settled",
]);

function readJson(directory, name) {
  return JSON.parse(readFileSync(path.join(directory, name), "utf8"));
}

export function stableHostileEvidence(report) {
  const current = requiresCurrentCancellation(report.engine);
  if (current) {
    for (const name of ['real-cancellation-race', 'remote-durable-cancellation']) {
      const matches = report.scenarios.filter((scenario) => scenario.name === name);
      assert.equal(matches.length, 1, `missing or duplicate current cancellation scenario: ${name}`);
      assert.equal(matches[0].result, 'green', `current cancellation scenario is not green: ${name}`);
    }
  }
  return {
    schema_version: report.schema_version,
    engine: report.engine,
    scenarios: report.scenarios.map(({ duration_ms: _duration, ...scenario }) =>
      stableHostileScenario(scenario, current)),
    summary: report.summary,
    result: report.result,
  };
}

export function isDurableCancellationTerminal(event) {
  return event !== null
    && typeof event === "object"
    && CANCELLATION_TERMINAL_KINDS.has(event.kind)
    && event.status === "cancelled";
}

export function stableDepthEvidence(report) {
  const current = requiresCurrentCancellation(report.engine);
  return {
    ...report,
    projects: report.projects.map((project) => {
      if (project.project !== "incident-response-controller") return project;
      if (current) validateCurrentCancellation(project, project.cancellation_status,
        project.cancelled_run_status, project.sse_terminal, project.same_job_terminal_and_replay_matched);
      const kinds = project.sse_event_kinds;
      const terminalKinds = Array.isArray(kinds)
        ? kinds.filter((kind) => CANCELLATION_TERMINAL_KINDS.has(kind))
        : [];
      if (project.cancelled_run_status !== "cancelled"
        || project.cancellation_status !== (current ? "cancellation_requested" : "cancelled")
        || project.cancellation_idempotent !== true
        || terminalKinds.length !== 1
        || !isDurableCancellationTerminal(project.sse_terminal)
        || !kinds.includes(project.sse_terminal.kind)) {
        throw new Error("depth cancellation project lacks an exact cancelled terminal result");
      }
      return {
        ...project,
        sse_event_kinds: kinds.map((kind) => CANCELLATION_TERMINAL_KINDS.has(kind)
          ? "execution.cancelled|execution.settled"
          : kind),
        sse_terminal: {
          ...project.sse_terminal,
          kind: "execution.cancelled|execution.settled",
        },
      };
    }),
  };
}

export function stableRecoveryEvidence({ job_id: _jobId, ...report }) {
  if (typeof _jobId !== "string"
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(_jobId)) {
    throw new Error("recovery evidence lacks a valid job UUID");
  }
  return report;
}

function stableHostileScenario(scenario, current) {
  if (current && ['real-cancellation-race', 'remote-durable-cancellation'].includes(scenario.name)) {
    const evidence = scenario.evidence;
    const native = scenario.name === 'real-cancellation-race';
    validateCurrentCancellation(evidence, evidence?.cancel_status, evidence?.run_status,
      native ? evidence?.terminal : evidence?.events?.at(-1),
      native ? evidence?.same_job_terminal_matched : evidence?.same_job_terminal_and_replay_matched);
  }
  if (scenario.name !== "remote-durable-cancellation" || scenario.result !== "green") {
    return scenario;
  }
  const events = scenario.evidence?.events;
  const terminal = Array.isArray(events) ? events.at(-1) : undefined;
  if (!isDurableCancellationTerminal(terminal)) {
    throw new Error("remote cancellation replay lacks an exact cancelled terminal frame");
  }
  return {
    ...scenario,
    evidence: {
      ...scenario.evidence,
      events: [
        ...events.slice(0, -1),
        { ...terminal, kind: "execution.cancelled|execution.settled" },
      ],
    },
  };
}

// Older measured records retain their historical contract. Current release
// records must prove the accepted action and the actual result separately.
export function requiresCurrentCancellation(engine) {
  const match = typeof engine === 'string' && engine.match(/^nika (\d+)\.(\d+)\./);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 118));
}

function validateCurrentCancellation(evidence, action, status, terminal, matched) {
  assert.equal(action, 'cancellation_requested', 'current cancellation action');
  assert.equal(status, 'cancelled', 'actual controlled cancellation result');
  assert.equal(terminal?.status, status, 'terminal and result must agree');
  assert(['run_settled', 'execution.cancelled', 'execution.settled'].includes(terminal?.kind));
  assert.equal(matched, true, 'whole same-job settlement was not compared');
  assert(evidence?.settlement, 'missing actual engine settlement');
  compareControlledCancellation({ ...evidence.settlement, outputs: {} });
  assert.equal(evidence.settlement.error_code, null);
  assert.equal(evidence.settlement.error_task, null);
  const gate = evidence.cancellation_rendezvous;
  assert.deepEqual(gate?.requests, { hold: 1, dependent: 0 });
  assert.equal(gate?.dependent_unstarted, true);
  assert.equal(gate?.cancel_point, 'loopback fetch held before response');
  assert.equal(gate?.release, 'after cancellation request acknowledgement');
}

export function verifyReleaseReplay(repositoryRoot, replayResults) {
  const committedResults = path.join(repositoryRoot, "gauntlet", "results");
  const committedLocal = readJson(committedResults, "local-execution.json");
  const replayedLocal = readJson(replayResults, "local-execution.json");
  if (!isDeepStrictEqual(replayedLocal, committedLocal)) {
    throw new Error("deterministic corpus replay does not match committed behavioral evidence");
  }

  const committedHostile = stableHostileEvidence(readJson(committedResults, "hostile.json"));
  const replayedHostile = stableHostileEvidence(readJson(replayResults, "hostile.json"));
  if (!isDeepStrictEqual(replayedHostile, committedHostile)) {
    throw new Error("hostile replay does not match committed stable behavioral evidence");
  }

  const committedMiniSaas = readJson(committedResults, "mini-saas.json");
  const replayedMiniSaas = readJson(replayResults, "mini-saas.json");
  if (!isDeepStrictEqual(replayedMiniSaas, committedMiniSaas)) {
    throw new Error("mini-SaaS replay does not match committed behavioral evidence");
  }

  const committedDepth = stableDepthEvidence(readJson(
    path.join(repositoryRoot, "gauntlet", "projects-depth"),
    "results.json",
  ));
  const replayedDepth = stableDepthEvidence(readJson(replayResults, "depth-projects.json"));
  if (!isDeepStrictEqual(replayedDepth, committedDepth)) {
    throw new Error("depth-project replay does not match committed stable behavioral evidence");
  }

  const committedRecovery = stableRecoveryEvidence(readJson(committedResults, "recovery-e2e.json"));
  const replayedRecovery = stableRecoveryEvidence(readJson(replayResults, "recovery-e2e.json"));
  if (!isDeepStrictEqual(replayedRecovery, committedRecovery)) {
    throw new Error("recovery replay does not match committed stable behavioral evidence");
  }

  return {
    engine: replayedLocal.engine,
    workflows: replayedLocal.workflows,
    distinctOutputHashes: replayedLocal.distinct_output_hashes,
    hostileScenarios: replayedHostile.summary.total,
    realEngineRuns: replayedHostile.summary.real_engine_runs,
    miniSaasProjects: replayedMiniSaas.projects.length,
    depthProjects: replayedDepth.projects.length,
    recoveryProcesses: replayedRecovery.process_count,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const replayResults = process.argv[2];
  if (!replayResults) {
    throw new Error("usage: verify-release-replay.mjs <replay-results-directory>");
  }
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const result = verifyReleaseReplay(repositoryRoot, path.resolve(replayResults));
  console.log(
    `public asset replay matches committed evidence: ${result.workflows} workflows, `
      + `${result.distinctOutputHashes} hashes, ${result.hostileScenarios} hostile scenarios, `
      + `${result.realEngineRuns} real engine runs, ${result.miniSaasProjects} mini-SaaS, `
      + `${result.depthProjects} depth projects, ${result.recoveryProcesses} recovery processes, `
      + result.engine,
  );
}
