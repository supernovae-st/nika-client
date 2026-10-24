import { readFile, writeFile } from 'node:fs/promises';

// Change one byte of the record a run wrote, as an attacker or a careless edit would.
const { trace_path } = JSON.parse(await readFile('receipt.json', 'utf8'));
const lines = (await readFile(trace_path, 'utf8')).split('\n');
const edited = lines[3].replace('greeting', 'greetinG');
if (edited === lines[3]) throw new Error('line 4 names no greeting: nothing was changed');
lines[3] = edited;
await writeFile(trace_path, lines.join('\n'));
console.log(`changed one byte on line 4 of ${trace_path}`);
