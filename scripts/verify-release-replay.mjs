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
  return {
    schema_version: report.schema_version,
    engine: report.engine,
    scenarios: report.scenarios.map(({ duration_ms: _duration, ...scenario }) =>
      stableHostileScenario(scenario)),
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
  return {
    ...report,
    projects: report.projects.map((project) => {
      if (project.project !== "incident-response-controller") return project;
      const kinds = project.sse_event_kinds;
      const terminalKinds = Array.isArray(kinds)
        ? kinds.filter((kind) => CANCELLATION_TERMINAL_KINDS.has(kind))
        : [];
      if (project.cancelled_run_status !== "cancelled"
        || project.cancellation_status !== "cancelled"
        || project.cancellation_idempotent !== true
        || terminalKinds.length !== 1
        || !isDurableCancellationTerminal(project.sse_terminal)) {
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
  return report;
}

function stableHostileScenario(scenario) {
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
