import { writeFile } from 'node:fs/promises';
import { Nika, isNikaRunSucceeded } from '@supernovae-st/nika';

const nika = new Nika({ cwd: process.cwd() });
const run = await nika.run<{ greeting: string }>('hello.nika', { maxCostUsd: 0 });
const result = await run.result();
if (!isNikaRunSucceeded(result) || !result.receipt) process.exit(1);

// Executed: the run succeeded. Sealed is a separate fact, carried by the receipt.
const { sealed, chain_len, chain_head } = result.receipt;
console.log(`run      ${result.status} · ${result.outputs?.greeting}`);
console.log(`receipt  sealed ${sealed} · ${chain_len} events · head ${String(chain_head).slice(0, 12)}…`);
await writeFile('receipt.json', JSON.stringify(result.receipt, null, 2)); // store it with your record

// Verified: the engine re-reads the trace the receipt names.
const proof = await nika.traceVerify(result.receipt);
console.log(`verify   ${proof.verified ? 'verified' : `not verified · ${proof.verdict} · ${proof.reason}`}`);
