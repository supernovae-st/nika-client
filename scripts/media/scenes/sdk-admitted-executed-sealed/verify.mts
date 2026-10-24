import { readFile } from 'node:fs/promises';
import { Nika } from '@supernovae-st/nika';

// Later, from the receipt you stored: the engine re-reads the trace, it never re-runs it.
const receipt = JSON.parse(await readFile('receipt.json', 'utf8'));
const proof = await new Nika({ cwd: process.cwd() }).traceVerify(receipt);
console.log(`verify   ${proof.verified ? 'verified' : `not verified · ${proof.verdict}`}`);
console.log(`engine   ${proof.output?.split('\n')[0]}`);
