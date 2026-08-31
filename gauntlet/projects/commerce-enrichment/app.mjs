import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({ cwd: process.cwd(), eventBufferSize: 64 });
const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
if (!checked.clean) throw new Error('batch workflow is not clean');
const run = await nika.run('workflow.nika.yaml', { maxCostUsd: 0 });
let events = 0;
for await (const _event of nika.events(run)) events += 1;
const result = await run.done;
console.log(JSON.stringify({
  project: 'commerce-enrichment',
  status: result.status,
  mode: 'bounded-fan-out',
  events,
  output_keys: Object.keys(result.outputs ?? {}),
}));
