import assert from 'node:assert/strict';
import { Nika } from '@supernovae-st/nika-client';

const mode = process.argv[2];
const config = {
  url: process.env.NIKA_URL,
  token: process.env.NIKA_TOKEN,
  allowInsecureHttp: true,
  bin: process.env.NIKA_BIN,
  cwd: process.cwd(),
};
const nika = new Nika(config);

if (mode === 'producer') {
  const run = await nika.run('workflow.nika.yaml', {
    idempotencyKey: 'sdk-0116-two-process-recovery',
  });
  for await (const event of nika.events(run)) {
    assert(Number.isSafeInteger(event.sequence));
    process.stdout.write(`${JSON.stringify({
      id: run.id,
      lastEventId: event.sequence,
    })}\n`);
    process.exit(0);
  }
  throw new Error('producer observed no durable event');
}

if (mode === 'consumer') {
  const saved = JSON.parse(process.env.NIKA_RECOVERY_STATE ?? 'null');
  assert.equal(typeof saved?.id, 'string');
  assert(Number.isSafeInteger(saved.lastEventId));
  const run = await nika.attachRun(saved.id, { lastEventId: saved.lastEventId });
  const resumed = [];
  for await (const event of nika.events(run)) resumed.push(event.sequence);
  const result = await run.done;
  assert.equal(result.id, saved.id);
  assert.equal(result.status, 'succeeded');
  assert(resumed.every((sequence) => sequence > saved.lastEventId));
  process.stdout.write(`${JSON.stringify({
    project: 'two-process-durable-recovery',
    status: result.status,
    job_id: result.id,
    producer_last_event_id: saved.lastEventId,
    resumed_sequences: resumed,
    duplicate_sequences: resumed.filter((sequence) => sequence <= saved.lastEventId),
  })}\n`);
  process.exit(0);
}

throw new Error(`unknown recovery mode: ${mode}`);
