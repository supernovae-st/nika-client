import { readFile } from 'node:fs/promises';
import { Nika, NikaOperationError } from '@supernovae-st/nika';

const url = process.env.NIKA_URL ?? 'http://127.0.0.1:8787';
const token = (await readFile('.nika/serve.token', 'utf8')).trim();
const nika = new Nika({ url, token, allowInsecureHttp: true }); // plain HTTP: loopback only

console.log(`served   ${(await nika.listWorkflows()).join(' ')}`);
console.log(`check    ${(await nika.check('hello.nika')).clean ? 'clean' : 'refused'}`);

// Store the key before the call; a retry with the same key reuses the job.
const idempotencyKey = 'hello-2026-10-24-0001';
const run = await nika.run<{ greeting: string }>('hello.nika', { idempotencyKey });
console.log(`job      ${run.id}`);
for await (const event of run.events()) console.log(`  #${event.sequence} ${event.kind} ${event.status ?? ''}`);
const result = await run.result();
console.log(`result   ${result.status} · ${result.outputs?.greeting}`);
if (result.receipt) {
  // Over HTTP, read `verified` first: the verdict is the server's word about its own journal.
  const proof = await nika.traceVerify(result.receipt);
  console.log(`verify   ${proof.verified ? 'verified' : 'not verified'} · ${proof.verdict} (the server's verdict on its own journal)`);
}

const retry = await nika.run('hello.nika', { idempotencyKey });
console.log(`retry    ${retry.id === run.id ? 'the same job: it did not run twice' : `a new job ${retry.id}`}`);

try {
  await new Nika({ url, token: 'not-the-token-'.repeat(3), allowInsecureHttp: true }).listWorkflows();
} catch (error) {
  if (!(error instanceof NikaOperationError)) throw error;
  console.log(`bad token ${error.status} ${error.code}`);
}
