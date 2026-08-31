import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

function readJson(directory, name) {
  return JSON.parse(readFileSync(path.join(directory, name), "utf8"));
}

export function stableHostileEvidence(report) {
  return {
    schema_version: report.schema_version,
    engine: report.engine,
    scenarios: report.scenarios.map(({ duration_ms: _duration, ...scenario }) => scenario),
    summary: report.summary,
    result: report.result,
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

  return {
    engine: replayedLocal.engine,
    workflows: replayedLocal.workflows,
    distinctOutputHashes: replayedLocal.distinct_output_hashes,
    hostileScenarios: replayedHostile.summary.total,
    realEngineRuns: replayedHostile.summary.real_engine_runs,
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
      + `${result.realEngineRuns} real engine runs, ${result.engine}`,
  );
}
