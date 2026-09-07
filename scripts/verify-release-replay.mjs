import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

// A cancel reply and the terminals it may lead to, measured on engine 0.118.7.
//
// 200 `cancelled`: the resident cancelled the job before its execution started
// (or replayed an observation that had already ended). The durable terminal is
// `execution.cancelled` (the cancel_job writer) or `execution.settled` (the
// racing settlement writer), both only with status `cancelled`; the two writers
// the 0.116 resident ratified.
//
// 202 `cancellation_requested`: the execution was in flight, and its owner
// records the terminal it reaches first: `cancelled` (one of the two writer
// kinds) with a settlement whose `cause` is `operator` when the run reaches a
// task boundary before the grace expires, or `execution.interrupted` with
// status `interrupted` and no settlement once the grace expires inside a task.
// Any other terminal after a cancel reply is refused.
const CANCELLED_TERMINAL_KINDS = new Set([
  "execution.cancelled",
  "execution.settled",
]);
const INTERRUPTED_TERMINAL_KIND = "execution.interrupted";
const CANCELLATION_TERMINAL_KINDS = new Set([
  ...CANCELLED_TERMINAL_KINDS,
  INTERRUPTED_TERMINAL_KIND,
]);
const STABLE_CANCELLED_TERMINAL_KIND = "execution.cancelled|execution.settled";

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
    && CANCELLED_TERMINAL_KINDS.has(event.kind)
    && event.status === "cancelled";
}

export function isInterruptedCancellationTerminal(event) {
  return event !== null
    && typeof event === "object"
    && event.kind === INTERRUPTED_TERMINAL_KIND
    && event.status === "interrupted";
}

export function isCancellationTerminalKind(kind) {
  return CANCELLATION_TERMINAL_KINDS.has(kind);
}

export function isOperatorCancelledTerminal(event) {
  return isDurableCancellationTerminal(event) && event.settlement_cause === "operator";
}

export function cancellationTerminalMatches(cancelStatus, event) {
  if (cancelStatus === "cancelled") return isDurableCancellationTerminal(event);
  if (cancelStatus === "cancellation_requested") {
    return isInterruptedCancellationTerminal(event) || isOperatorCancelledTerminal(event);
  }
  return false;
}

export function stableCancellationTerminalKind(kind) {
  return CANCELLED_TERMINAL_KINDS.has(kind) ? STABLE_CANCELLED_TERMINAL_KIND : kind;
}

export function stableDepthEvidence(report) {
  return {
    ...report,
    projects: report.projects.map((project) => {
      if (project.project !== "incident-response-controller") return project;
      const kinds = project.sse_event_kinds;
      const terminal = project.sse_terminal;
      const terminalKinds = Array.isArray(kinds) ? kinds.filter(isCancellationTerminalKind) : [];
      if (project.cancellation_idempotent !== true
        || !cancellationTerminalMatches(project.cancellation_status, terminal)
        || project.cancelled_run_status !== terminal.status
        || terminalKinds.length !== 1
        || terminalKinds[0] !== terminal.kind) {
        throw new Error(
          "depth cancellation project lacks the exact cancellation terminal its cancel reply leads to",
        );
      }
      return {
        ...project,
        sse_event_kinds: kinds.map(stableCancellationTerminalKind),
        sse_terminal: {
          ...terminal,
          kind: stableCancellationTerminalKind(terminal.kind),
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

function stableHostileScenario(scenario) {
  if (scenario.name !== "remote-durable-cancellation" || scenario.result !== "green") {
    return scenario;
  }
  const evidence = scenario.evidence ?? {};
  const events = evidence.events;
  const terminal = Array.isArray(events) ? events.at(-1) : undefined;
  if (!cancellationTerminalMatches(evidence.cancel_status, terminal)
    || evidence.run_status !== terminal.status) {
    throw new Error(
      "remote cancellation replay lacks the exact terminal frame its cancel reply leads to",
    );
  }
  return {
    ...scenario,
    evidence: {
      ...evidence,
      events: [
        ...events.slice(0, -1),
        { ...terminal, kind: stableCancellationTerminalKind(terminal.kind) },
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
