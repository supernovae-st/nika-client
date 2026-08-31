import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({ cwd: process.cwd() });
const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
if (!checked.clean) throw new Error('operator workflow is not clean');
const run = await nika.run('workflow.nika.yaml', { maxCostUsd: 0 });
const kinds = [];
for await (const event of nika.events(run)) kinds.push(event.kind ?? 'unknown');
const result = await run.done;
console.log(JSON.stringify({
  project: 'operator-console',
  status: result.status,
  transport: result.transport,
  observed_event_kinds: [...new Set(kinds)].sort(),
  output_keys: Object.keys(result.outputs ?? {}),
}));
