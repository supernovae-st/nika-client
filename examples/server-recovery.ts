/**
 * Run a job on your `nika serve`, lose the process, then pick the job back up.
 *
 *   npm run build                       # the example imports the package by name
 *   export NIKA_URL=http://127.0.0.1:8787 NIKA_TOKEN="$(cat .nika/serve.token)"
 *   node server-recovery.ts start [workflow]
 *   node server-recovery.ts resume
 *
 * `start` stores an idempotency key, submits the served workflow (default
 * `wait.nika`), shows that retrying with the same key returns the same job,
 * records the job id and the last event sequence it processed in
 * `recovery.json`, and exits after the first event, as a crashed worker would.
 * `resume` reattaches with attachRun() from that cursor, reads the rest,
 * then asks the server to verify the job's record. Node 22.18+ runs this file
 * as is. examples/README.md shows how to start the server.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Nika } from '@supernovae-st/nika';

interface Checkpoint {
  idempotencyKey: string;
  workflow: string;
  jobId?: string;
  lastEventSequence?: number;
}

const STATE = 'recovery.json';
const SEALED_VERDICTS = ['sealed', 'anchored', 'replayed'];

const [command, workflow = 'wait.nika'] = process.argv.slice(2);
const url = process.env.NIKA_URL;
const token = process.env.NIKA_TOKEN;
if (!url || !token || (command !== 'start' && command !== 'resume')) {
  console.error('usage: NIKA_URL=… NIKA_TOKEN=… node server-recovery.ts start [workflow] | resume');
  process.exit(64);
}
// Plain HTTP stays limited to a loopback server (a local `nika serve`).
const nika = new Nika({ url, token, allowInsecureHttp: url.startsWith('http://') });

async function save(checkpoint: Checkpoint): Promise<void> {
  // A real application writes this in the same transaction as its own effects.
  await writeFile(STATE, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

if (command === 'start') {
  // Store the key before the call: after a lost answer, the same key is a safe retry.
  const checkpoint: Checkpoint = { idempotencyKey: `recovery-${randomUUID()}`, workflow };
  await save(checkpoint);
  const run = await nika.run(workflow, { idempotencyKey: checkpoint.idempotencyKey });
  checkpoint.jobId = run.id;
  await save(checkpoint);
  console.log(`job ${run.id} admitted`);

  const retried = await nika.run(workflow, { idempotencyKey: checkpoint.idempotencyKey });
  console.log(`retry with the same key · same job: ${retried.id === run.id}`);

  for await (const event of run.events()) {
    console.log(`${event.sequence} ${event.kind} ${event.status ?? ''}`);
    checkpoint.lastEventSequence = event.sequence;
    await save(checkpoint);
    break;
  }
  console.log(`stopping after sequence ${checkpoint.lastEventSequence}: run "node server-recovery.ts resume"`);
  process.exit(0);
}

const checkpoint = JSON.parse(await readFile(STATE, 'utf8')) as Checkpoint;
if (!checkpoint.jobId) {
  console.error(`${STATE} holds no job id: run "start" first`);
  process.exit(64);
}
// attachRun proves the job exists, then resumes the stream after the cursor.
const run = await nika.attachRun(checkpoint.jobId, { lastEventId: checkpoint.lastEventSequence ?? 0 });
for await (const event of run.events()) {
  console.log(`${event.sequence} ${event.kind} ${event.status ?? ''}`);
  checkpoint.lastEventSequence = event.sequence;
  await save(checkpoint);
}
const result = await run.result();
console.log(`job ${run.id} · ${result.status}`);

if (result.receipt) {
  // Over HTTP, read `verified` first: `verdict` is the server's word on the job's
  // journal and does not say that this receipt matches it.
  const proof = await nika.traceVerify(result.receipt);
  const sealed = proof.verified && SEALED_VERDICTS.includes(String(proof.verdict));
  console.log(`trace · verified ${proof.verified} · ${proof.verdict} (${proof.reason}) · sealed ${sealed}`);
}
