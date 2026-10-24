import { Nika } from '@supernovae-st/nika';

const nika = new Nika({ cwd: process.cwd() });
const run = await nika.run<{ brief: string }>('brief.nika', { maxCostUsd: 0 });

// One lifecycle vocabulary; the engine's own frame stays on event.raw.
const t0 = performance.now();
for await (const event of run.events()) {
  const at = ((performance.now() - t0) / 1000).toFixed(1).padStart(4);
  const frame = event.kind === 'engine.event' ? `(${event.raw.kind})` : '';
  console.log(`${at}s  ${event.kind.padEnd(15)} ${event.task ?? ''}${event.status ?? ''}${frame}`);
}

// Events are observation; result() is the terminal truth.
const { status, settlement } = await run.result();
const tasks = settlement?.tasks;
console.log(`\nresult  ${status} · cause ${settlement?.cause} · ${tasks?.ok}/${tasks?.total} tasks ok`);
