import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({ cwd: process.cwd() });
const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
if (!checked.clean) throw new Error('document workflow is not clean');
const run = await nika.run('workflow.nika.yaml', { maxCostUsd: 0 });
const result = await run.done;
if (!result.receipt) throw new Error('engine did not issue a receipt');
const proof = await nika.traceVerify(result.receipt);
if (!proof.verified) throw new Error(`trace verification failed: ${proof.output}`);
console.log(JSON.stringify({
  project: 'document-evidence',
  status: result.status,
  proof: 'sealed-trace-verified',
  output_keys: Object.keys(result.outputs ?? {}),
}));
