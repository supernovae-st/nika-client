import { writeFile } from 'node:fs/promises';
import { Nika, nextCompileRequest, type NikaCompileRequest } from '@supernovae-st/nika';

const nika = new Nika({ cwd: process.cwd() });
const request: NikaCompileRequest = { intent: process.argv[2] ?? '' };

// Round 1 · no provider is seated, so no model is called: the engine says what it lacks
const first = await nika.compile(request);
const required = first.questions.filter((q) => q.mandatory);
console.log(`round 1  ${first.status} · ${required.length} required, ${first.questions.length - required.length} optional question(s)`);
for (const q of required) console.log(`         ? ${q.key}\n           ${q.label}`);
for (const d of first.diagnostics) console.log(`         · ${d.message.split(':')[0]}`);

// Round 2 · answer it; the candidate is source text, not a run
console.log('answer   model = mock/echo (the offline rehearsal model)');
const outcome = await nika.compile(nextCompileRequest(request, first, { model: 'mock/echo' }));
console.log(`round 2  ${outcome.status} · provider calls: ${outcome.compile_version === 2 ? 'yes' : 'none'}`);
if (outcome.requested_trigger) console.log(`         trigger ${outcome.requested_trigger.kind} · ${outcome.requested_trigger.cadence} · ${outcome.requested_trigger.status}`);
if (!outcome.ready || outcome.candidate === null) process.exit(1);

// You review and keep it; run() would admit it like any other file
await writeFile('digest.nika', outcome.candidate);
const report = await nika.check('digest.nika');
console.log(`check    ${report.clean ? 'clean' : 'refused'} · exit ${report.exitCode} · kept as digest.nika`);
