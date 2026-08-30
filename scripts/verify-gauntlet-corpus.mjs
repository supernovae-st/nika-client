import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = join(root, "gauntlet", "corpus");
const workflowsRoot = join(corpusRoot, "workflows");
const inventory = JSON.parse(readFileSync(join(corpusRoot, "use-cases.json"), "utf8"));
const workflowFiles = readdirSync(workflowsRoot).filter((name) => name.endsWith(".nika.yaml")).sort();
const requiredUniqueFields = ["id", "actor", "trigger", "failure_oracle", "business_outcome", "workflow"];

if (inventory.length !== 100 || workflowFiles.length !== 100) {
  throw new Error(`expected 100 inventory rows and workflows; got ${inventory.length} and ${workflowFiles.length}`);
}
for (const field of requiredUniqueFields) {
  const count = new Set(inventory.map((entry) => entry[field])).size;
  if (count !== 100) throw new Error(`${field} is not unique: ${count}/100`);
}
if (new Set(inventory.map((entry) => entry.domain)).size !== 20) {
  throw new Error("expected 20 distinct domains");
}

const nikaBin = process.env.NIKA_GAUNTLET_BIN || "nika";
const failures = [];
for (const [index, file] of workflowFiles.entries()) {
  const path = join(workflowsRoot, file);
  const check = spawnSync(nikaBin, ["check", "--json", "--native-strict", path], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (check.status !== 0) {
    failures.push({ file, stage: "check", status: check.status, stderr: check.stderr, stdout: check.stdout });
    continue;
  }
  const report = JSON.parse(check.stdout);
  if (report.clean !== true || report.paid_ready !== true) {
    failures.push({ file, stage: "readiness", clean: report.clean, paid_ready: report.paid_ready, next: report.next });
  }
  if ((index + 1) % 10 === 0) process.stdout.write(`checked ${index + 1}/100\n`);
}

if (failures.length > 0) {
  console.error(JSON.stringify(failures.slice(0, 10), null, 2));
  throw new Error(`${failures.length} workflows failed corpus verification`);
}

console.log("100/100 workflows clean, native-strict, paid-ready; 20 domains and six semantic identity fields unique");
