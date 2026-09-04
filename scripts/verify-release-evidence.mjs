import { requiresCurrentCancellation, stableDepthEvidence, stableHostileEvidence } from './verify-release-replay.mjs';
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CURRENT_EVIDENCE = new Set([
  "gauntlet/projects-depth/results.json",
  "gauntlet/results/hostile.json",
  "gauntlet/results/local-execution.json",
  "gauntlet/results/mini-saas.json",
  "gauntlet/results/recovery-e2e.json",
]);
const HISTORICAL_EVIDENCE = new Set([
  "gauntlet/results/paid-provider-matrix.json",
  "gauntlet/results/trace-verification.json",
]);
const PACKED_EVIDENCE = new Set([
  "gauntlet/projects-depth/results.json",
  "gauntlet/results/mini-saas.json",
  "gauntlet/results/recovery-e2e.json",
]);
const MINI_SAAS_PROJECTS = new Set([
  "commerce-enrichment",
  "document-evidence",
  "operator-console",
  "research-monitor",
  "support-webhook",
]);
const DEPTH_PROJECTS = new Set([
  "deployment-gate",
  "evidence-provenance-pipeline",
  "incident-response-controller",
  "multi-tenant-webhook-router",
  "scheduled-research-monitor",
]);
const CANCELLATION_TERMINAL_KINDS = new Set([
  "execution.cancelled",
  "execution.settled",
]);
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

export function verifyReleaseEvidence(root = path.resolve(import.meta.dirname, "..")) {
  const version = readJson(root, "package.json").version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json has an invalid version: ${String(version)}`);
  }

  const resultFiles = readdirSync(path.join(root, "gauntlet/results"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `gauntlet/results/${name}`);
  const evidenceFiles = [...resultFiles, "gauntlet/projects-depth/results.json"].sort();
  const missing = [...CURRENT_EVIDENCE].filter((relativePath) => !evidenceFiles.includes(relativePath));
  if (missing.length > 0) {
    throw new Error(`missing current release evidence: ${missing.join(", ")}`);
  }

  const expectedPackage = `supernovae-st-nika-client-${version}.tgz`;
  const currentIdentities = new Set();
  let currentFiles = 0;
  let historicalFiles = 0;

  for (const relativePath of evidenceFiles) {
    const evidence = readJson(root, relativePath);
    const identity = typeof evidence.engine === "string"
      ? evidence.engine.match(/^nika (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(([0-9a-f]{9,40})\)$/)
      : null;
    if (!identity) {
      throw new Error(`${relativePath} has an invalid or missing engine identity`);
    }

    if (HISTORICAL_EVIDENCE.has(relativePath)) {
      if (typeof evidence.evidence_scope !== "string"
        || !/^historical .+; not a \d+\.\d+ release gate$/.test(evidence.evidence_scope)) {
        throw new Error(`${relativePath} is not explicitly scoped as historical non-gating evidence`);
      }
      if ("package" in evidence) {
        throw new Error(`${relativePath} must not bind a historical observation to the current package`);
      }
      historicalFiles += 1;
      continue;
    }

    if (!CURRENT_EVIDENCE.has(relativePath)) {
      throw new Error(`${relativePath} is unclassified; declare it current or explicitly historical`);
    }
    if (identity[1] !== version) {
      throw new Error(`${relativePath} records engine ${identity[1]}, expected package version ${version}`);
    }
    if (PACKED_EVIDENCE.has(relativePath) && evidence.package !== expectedPackage) {
      throw new Error(`${relativePath} records package ${String(evidence.package)}, expected ${expectedPackage}`);
    }
    if (!PACKED_EVIDENCE.has(relativePath) && "package" in evidence && evidence.package !== expectedPackage) {
      throw new Error(`${relativePath} records package ${String(evidence.package)}, expected ${expectedPackage}`);
    }
    verifyBehavior(relativePath, evidence);
    currentIdentities.add(evidence.engine);
    currentFiles += 1;
  }

  if (currentIdentities.size !== 1) {
    throw new Error(`current release evidence spans ${currentIdentities.size} engine identities`);
  }
  const [engine] = currentIdentities;
  const report = readFileSync(path.join(root, "gauntlet/projects-depth/REPORT.md"), "utf8");
  if (!report.includes(`engine \`${engine}\``) || !report.includes(`\`${expectedPackage}\``)) {
    throw new Error("gauntlet/projects-depth/REPORT.md does not name the current engine and package");
  }

  return { version, engine, package: expectedPackage, currentFiles, historicalFiles };
}

function verifyBehavior(relativePath, evidence) {
  if (requiresCurrentCancellation(evidence.engine)) {
    if (relativePath === 'gauntlet/projects-depth/results.json') stableDepthEvidence(evidence);
    if (relativePath === 'gauntlet/results/hostile.json') stableHostileEvidence(evidence);
  }
  if (relativePath === "gauntlet/results/mini-saas.json") {
    verifyProjects(relativePath, evidence.projects, MINI_SAAS_PROJECTS);
    if (evidence.result !== "green") {
      throw new Error(`${relativePath} does not record a green result`);
    }
  }
  if (relativePath === "gauntlet/projects-depth/results.json") {
    verifyProjects(relativePath, evidence.projects, DEPTH_PROJECTS);
    if (evidence.summary?.total !== 5
      || evidence.summary?.succeeded !== 5
      || evidence.summary?.result !== "green") {
      throw new Error(`${relativePath} does not record a 5/5 green summary`);
    }
    const incident = evidence.projects.find(
      (project) => project.project === "incident-response-controller",
    );
    const kinds = incident?.sse_event_kinds;
    const terminal = incident?.sse_terminal;
    if (!Array.isArray(kinds)
      || kinds.filter((kind) => CANCELLATION_TERMINAL_KINDS.has(kind)).length !== 1
      || !CANCELLATION_TERMINAL_KINDS.has(terminal?.kind)
      || terminal?.status !== "cancelled"
      || !kinds.includes(terminal.kind)) {
      throw new Error(`${relativePath} has contradictory cancellation event evidence`);
    }
  }
  if (relativePath === "gauntlet/results/recovery-e2e.json") {
    if (evidence.process_count !== 2
      || evidence.installed_from_pack !== true
      || evidence.status !== "succeeded"
      || !Array.isArray(evidence.resumed_sequences)
      || evidence.resumed_sequences.length === 0
      || !Array.isArray(evidence.duplicate_sequences)
      || evidence.duplicate_sequences.length !== 0
      || typeof evidence.job_id !== "string"
      || !UUID_PATTERN.test(evidence.job_id)) {
      throw new Error(`${relativePath} does not record successful duplicate-free two-process recovery`);
    }
  }
}

function verifyProjects(relativePath, projects, expectedNames) {
  if (!Array.isArray(projects) || projects.length !== expectedNames.size) {
    throw new Error(`${relativePath} does not record ${expectedNames.size} packed projects`);
  }
  const names = new Set(projects.map((project) => project.name ?? project.project));
  if (names.size !== expectedNames.size
    || [...expectedNames].some((name) => !names.has(name))
    || projects.some((project) => project.status !== "succeeded"
      || project.installed_from_pack !== true)) {
    throw new Error(`${relativePath} has a missing or non-green packed project`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyReleaseEvidence();
  console.log(
    `release evidence matches package ${result.version}: ${result.currentFiles} current, `
      + `${result.historicalFiles} historical, ${result.engine}`,
  );
}
