import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { supervisedGauntlet } from './gauntlet.mjs';

const root = path.resolve(import.meta.dirname, '..');
await supervisedGauntlet({ name: 'local-execution', root }, async ({ scratch, nikaBin, env, run }) => {
  const project = path.join(scratch, 'project');
  const fixtureHome = path.join(scratch, 'home');
  mkdirSync(fixtureHome, { mode: 0o700 });
  cpSync(path.join(root, 'gauntlet', 'corpus'), project, { recursive: true });
  // Workflow bytes are copied unchanged. Only this owned project and signing
  // home can receive engine journals, retention effects or generated keys.
  const engineEnv = { ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM']
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
    HOME: fixtureHome, NIKA_KEYCHAIN: 'off' };
  const execute = (args, timeoutMs) => run(nikaBin, args,
    { cwd: project, env: engineEnv, timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const engine = (await execute(['--version'], 5000)).trim();
  await execute(['key', 'init', '--plain'], 15_000);
  const inventory = JSON.parse(readFileSync(path.join(project, 'use-cases.json'), 'utf8'));
  assert.equal(inventory.length, 100, 'expected exactly 100 corpus cases');
  const rows = [];
  for (const entry of inventory) {
    assert(typeof entry.workflow === 'string' && /^workflows\/[^/\\]+\.nika\.yaml$/.test(entry.workflow),
      'corpus workflows must remain inside the isolated project');
    const file = path.join(project, entry.workflow);
    assert(readFileSync(file).equals(readFileSync(path.join(root, 'gauntlet', 'corpus', entry.workflow))),
      'executed workflow bytes must match the committed corpus');
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
