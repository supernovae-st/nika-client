import assert from 'node:assert/strict';
import path from 'node:path';
import { supervisedGauntlet } from './gauntlet.mjs';
import { stageCorpus } from './corpus-project.mjs';

const root = path.resolve(import.meta.dirname, '..');
await supervisedGauntlet({ name: 'corpus-check', root, persistReport: false },
  async ({ scratch, nikaBin, env, run }) => {
    const { project, engineEnv, workflowFiles } = stageCorpus(root, scratch, env);
    for (const [index, file] of workflowFiles.entries()) {
      const stdout = await run(nikaBin, ['check', '--json', '--native-strict', path.join(project, 'workflows', file)],
        { cwd: project, env: engineEnv, timeoutMs: 30_000, maxBuffer: 8 * 1024 * 1024 });
      const report = JSON.parse(stdout);
      assert(report?.clean === true && report?.paid_ready === true, `${file}: check is not clean and paid-ready`);
      if ((index + 1) % 10 === 0) process.stdout.write(`checked ${index + 1}/100\n`);
    }
    return { checked: workflowFiles.length, domains: 20, unique_identity_fields: 6 };
  });
