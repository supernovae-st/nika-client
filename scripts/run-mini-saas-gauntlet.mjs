import assert from 'node:assert/strict';
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject, supervisedGauntlet, packSdk } from './gauntlet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runMiniSaasGauntlet() {
  return supervisedGauntlet({ name: 'mini-saas', root }, async ({ scratch, nikaBin, run }) => {
    const { filename, tarball } = await packSdk(root, scratch, run);
    const projectsRoot = path.join(root, 'gauntlet', 'projects');
    const rows = [];
    for (const name of readdirSync(projectsRoot).sort()) {
      const project = path.join(scratch, name);
      await installProject(path.join(projectsRoot, name), project, tarball, run);
      const stdout = await run(process.execPath, ['app.mjs'], { cwd: project, timeoutMs: 30_000 });
      const result = JSON.parse(stdout.trim().split('\n').at(-1));
      assert.equal(result.project, name);
      assert.equal(result.status, 'succeeded');
      rows.push({ name, ...result, installed_from_pack: true });
      process.stdout.write(`mini-saas ${rows.length}/5 · ${name} · ${result.status}\n`);
    }
    assert.equal(rows.length, 5, 'expected 5 mini-SaaS projects');
    return {
      engine: (await run(nikaBin, ['--version'], { timeoutMs: 5_000 })).trim(),
      package: filename,
      install_mode: 'npm pack + npm install --omit=optional + explicit NIKA_BIN',
      projects: rows,
    };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await runMiniSaasGauntlet();
