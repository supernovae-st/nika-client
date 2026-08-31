import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({ cwd: process.cwd() });
const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
if (!checked.clean) throw new Error('research workflow is not clean');
const first = await nika.run('workflow.nika.yaml', { maxCostUsd: 0 });
const second = await nika.run('workflow.nika.yaml', { maxCostUsd: 0 });
const [a, b] = await Promise.all([first.done, second.done]);
if (a.status !== b.status) throw new Error('repeat runs diverged');
console.log(JSON.stringify({
  project: 'research-monitor',
  status: a.status,
  repeated_runs: 2,
  deterministic_status: true,
  output_keys: Object.keys(a.outputs ?? {}),
}));
