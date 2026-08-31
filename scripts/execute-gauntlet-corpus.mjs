import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = join(root, "gauntlet", "corpus");
const resultsRoot = join(root, "gauntlet", "results");
const inventory = JSON.parse(readFileSync(join(corpusRoot, "use-cases.json"), "utf8"));
const nikaBin = process.env.NIKA_BIN || process.env.NIKA_GAUNTLET_BIN || "nika";
const version = spawnSync(nikaBin, ["--version"], { encoding: "utf8" });

if (version.status !== 0) throw new Error(`cannot identify ${nikaBin}: ${version.stderr}`);

const rows = [];
const failures = [];
for (const entry of inventory) {
  const path = join(corpusRoot, entry.workflow);
  const run = spawnSync(nikaBin, ["run", path, "--output", "json", "--max-cost-usd", "0"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.status !== 0) {
    failures.push({ id: entry.id, status: run.status, stderr: run.stderr, stdout: run.stdout });
    continue;
  }
  let output;
  try {
    output = JSON.parse(run.stdout);
  } catch (error) {
    failures.push({ id: entry.id, status: "invalid-json", error: String(error), stdout: run.stdout });
    continue;
  }
  rows.push({
    id: entry.id,
    domain: entry.domain,
    recipe: entry.recipe,
    output_sha256: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
  });
  if (rows.length % 10 === 0) process.stdout.write(`executed ${rows.length}/100\n`);
}

if (failures.length > 0) {
  console.error(JSON.stringify(failures.slice(0, 10), null, 2));
  throw new Error(`${failures.length} workflows failed execution`);
}

const distinctOutputs = new Set(rows.map((row) => row.output_sha256)).size;
if (rows.length !== 100 || distinctOutputs < 90) {
  throw new Error(`execution diversity failed: ${rows.length} rows, ${distinctOutputs} distinct output hashes`);
}

mkdirSync(resultsRoot, { recursive: true });
writeFileSync(
  join(resultsRoot, "local-execution.json"),
  `${JSON.stringify(
    {
      schema_version: 1,
      engine: version.stdout.trim(),
      workflows: rows.length,
      domains: new Set(rows.map((row) => row.domain)).size,
      recipes: new Set(rows.map((row) => row.recipe)).size,
      distinct_output_hashes: distinctOutputs,
      result: "pass",
      rows,
    },
    null,
    2,
  )}\n`,
);

console.log(`100/100 workflows executed; ${distinctOutputs}/100 output hashes distinct on ${version.stdout.trim()}`);
