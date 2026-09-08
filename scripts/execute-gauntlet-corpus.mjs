import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { supervisedGauntlet } from './gauntlet.mjs';
import { stageCorpus } from './corpus-project.mjs';

const root = path.resolve(import.meta.dirname, '..');
await supervisedGauntlet({ name: 'local-execution', root }, async ({ scratch, nikaBin, env, run }) => {
  const { project, engineEnv, inventory } = stageCorpus(root, scratch, env);
  const execute = (args, timeoutMs) => run(nikaBin, args,
    { cwd: project, env: engineEnv, timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const engine = (await execute(['--version'], 5000)).trim();
  await execute(['key', 'init', '--plain'], 15_000);
  const rows = [];
  for (const entry of inventory) {
    const file = path.join(project, entry.workflow);
    const output = JSON.parse(await execute(['run', file, '--output', 'json', '--max-cost-usd', '0'], 30_000));
    rows.push({ id: entry.id, domain: entry.domain, recipe: entry.recipe,
      output_sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex') });
    if (rows.length % 10 === 0) process.stdout.write(`executed ${rows.length}/100\n`);
  }
  const distinctOutputs = new Set(rows.map((row) => row.output_sha256)).size;
  assert(distinctOutputs >= 90, `execution diversity failed: ${distinctOutputs}/100 distinct output hashes`);
  return { engine, workflows: rows.length, domains: new Set(rows.map((row) => row.domain)).size,
    recipes: new Set(rows.map((row) => row.recipe)).size, distinct_output_hashes: distinctOutputs, rows };
});
