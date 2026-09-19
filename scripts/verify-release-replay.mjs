import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
// status `interrupted` and no settlement once the grace expires inside a task
// (an interrupted terminal carrying a settlement cause is refused).
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

// No settlement rides an interrupted terminal (the contract's RunSettlement has
// no `interrupted` status): one that carries a settlement cause, or a settlement
// object, is not the shape the door records and is refused.
export function isInterruptedCancellationTerminal(event) {
  return event !== null
    && typeof event === "object"
    && event.kind === INTERRUPTED_TERMINAL_KIND
    && event.status === "interrupted"
    && event.settlement_cause === undefined
    && event.settlement === undefined;
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

const PACK_SHA256 = /^[0-9a-f]{64}$/;
const PACK_LEAF = /^supernovae-st-nika-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/;

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function sha512Integrity(filePath) {
  return `sha512-${createHash("sha512").update(readFileSync(filePath)).digest("base64")}`;
}

export function assertPackBasename(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("depth evidence lacks a packed tarball filename");
  }
  if (name !== path.basename(name) || path.isAbsolute(name)
    || name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`packed tarball filename is not a plain basename: ${name}`);
  }
  if (!PACK_LEAF.test(name)) {
    throw new Error(`packed tarball filename is not the expected package leaf: ${name}`);
  }
  return name;
}

export function depthPackProvenance(report) {
  const name = assertPackBasename(report?.package);
  const digest = report?.package_sha256;
  if (typeof digest !== "string" || !PACK_SHA256.test(digest)) {
    throw new Error("depth evidence lacks a 64-hex package_sha256 provenance digest");
  }
  return { package: name, package_sha256: digest };
}

// The digest names the exact tarball this ledger measured. Documentation-only
// pack changes (README in the npm tarball) retarget it. Compare it to the
// artifact bytes, never to committed behavior. The committed digest is a
// historical ledger identity, not a claim that this replay re-hashed that pack.
export function assertReplayPackProvenance(report, replayResults) {
  const provenance = depthPackProvenance(report);
  const replayRoot = path.resolve(replayResults);
  const artifact = path.join(replayRoot, provenance.package);
  if (!existsSync(artifact)) {
    throw new Error(
      `replay pack artifact missing: expected ${provenance.package} beside the depth ledger`,
    );
  }
  const actual = sha256File(artifact);
  if (actual !== provenance.package_sha256) {
    throw new Error(
      `replay package_sha256 ${provenance.package_sha256} does not match packed tarball ${actual}`,
    );
  }
  const manifestPath = path.join(replayRoot, "depth-package.json");
  if (!existsSync(manifestPath)) {
    throw new Error("replay pack manifest missing: expected depth-package.json beside the depth ledger");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.filename !== provenance.package) {
    throw new Error(
      `depth-package.json filename ${String(manifest.filename)} does not match ledger ${provenance.package}`,
    );
  }
  const size = statSync(artifact).size;
  if (manifest.size !== size) {
    throw new Error(
      `depth-package.json size ${String(manifest.size)} does not match packed tarball ${size}`,
    );
  }
  const integrity = sha512Integrity(artifact);
  if (manifest.integrity !== integrity) {
    throw new Error("depth-package.json integrity does not match packed tarball");
  }
  if (manifest.name !== undefined && manifest.name !== "@supernovae-st/nika") {
    throw new Error(`depth-package.json name ${String(manifest.name)} is not @supernovae-st/nika`);
  }
  const versionFromLeaf = provenance.package.slice("supernovae-st-nika-".length, -".tgz".length);
  if (manifest.version !== undefined && manifest.version !== versionFromLeaf) {
    throw new Error(
      `depth-package.json version ${String(manifest.version)} does not match ${versionFromLeaf}`,
    );
  }
  return { ...provenance, artifact, size, integrity, historical: false };
}

export function stableDepthEvidence(report) {
  const { package_sha256: _packageSha256, ...rest } = report;
  return {
    ...rest,
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
      // The app binds this journal identity to the actual run receipt and
      // rejects a substituted trace before recording evidence. A fresh run
      // necessarily has a new trace id; retain it in the raw ledger but compare
      // its verified shape and every behavioral verdict across replays.
      let receipt = project.remote_receipt_verdict;
      if (receipt !== undefined) {
        const { trace_id: traceId, ...verdict } = receipt;
        if (typeof traceId !== "string" || !/^[0-9a-f]{32}$/.test(traceId)
          || /^0+$/.test(traceId) || verdict.verified !== true
          || project.mismatched_trace_rejected !== true) {
          throw new Error("depth receipt evidence lacks a verified trace identity and substitution refusal");
        }
        receipt = verdict;
      }
      return {
        ...project,
        ...(receipt === undefined ? {} : { remote_receipt_verdict: receipt }),
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

  const committedDepthRaw = readJson(
    path.join(repositoryRoot, "gauntlet", "projects-depth"),
    "results.json",
  );
  const replayedDepthRaw = readJson(replayResults, "depth-projects.json");
  const committedPack = depthPackProvenance(committedDepthRaw);
  const replayedPack = assertReplayPackProvenance(replayedDepthRaw, replayResults);
  const committedDepth = stableDepthEvidence(committedDepthRaw);
  const replayedDepth = stableDepthEvidence(replayedDepthRaw);
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
    committedPackageSha256: committedPack.package_sha256,
    historicalLedgerPackageSha256: committedPack.package_sha256,
    replayedPackageSha256: replayedPack.package_sha256,
    packDigestChanged: committedPack.package_sha256 !== replayedPack.package_sha256,
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
      + result.engine
      + (result.packDigestChanged
        ? `; historical ledger pack ${result.historicalLedgerPackageSha256}; this replay ${result.replayedPackageSha256} (artifact+manifest matched)`
        : `; pack digest ${result.replayedPackageSha256} (matches historical ledger)`),
  );
}
