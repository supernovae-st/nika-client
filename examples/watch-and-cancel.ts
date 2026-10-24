/**
 * Watch a run while it happens, then stop it cleanly.
 *
 *   npm run build                       # the example imports the package by name
 *   cd examples && node watch-and-cancel.ts [workflow] [cancel-after-ms]
 *
 * Runs `wait.nika` (a five-second `nika:wait`) on the bundled engine, prints
 * each lifecycle event with the time it arrived, asks the engine to cancel
 * after 1000 ms (or when you press Ctrl+C), then prints the result the engine
 * settled. Node 22.18+ runs this file as is.
 *
 * The same code drives a `nika serve` when NIKA_URL and NIKA_TOKEN are set
 * (the workflow is then a name the server serves, and the run needs an
 * idempotency key). A server streams `run.started` and `run.settled` only;
 * a local engine also reports each task.
 */
import { randomUUID } from 'node:crypto';
import { Nika } from '@supernovae-st/nika';

const [workflow = 'wait.nika', cancelAfter = '1000'] = process.argv.slice(2);
const url = process.env.NIKA_URL;
const token = process.env.NIKA_TOKEN;
const nika = url && token
  // Plain HTTP stays limited to a loopback server (a local `nika serve`).
  ? new Nika({ url, token, allowInsecureHttp: url.startsWith('http://') })
  : new Nika({ cwd: process.cwd() });

const started = Date.now();
const at = () => `${String(Date.now() - started).padStart(5)} ms`;

// run() resolves once the engine admitted the workflow; a refusal throws here.
const run = await nika.run(workflow, url ? { idempotencyKey: `watch-${randomUUID()}` } : {});
console.log(`${at()}  admitted · run ${run.id}`);

async function stop(why: string): Promise<void> {
  // Idempotent: every call returns the same request.
  const request = await run.cancel();
  console.log(`${at()}  cancel (${why}) · accepted ${request.accepted} · ${request.status}`);
}
const timer = setTimeout(() => void stop(`after ${cancelAfter} ms`), Number(cancelAfter));
process.once('SIGINT', () => void stop('Ctrl+C'));

for await (const event of run.events()) {
  const task = event.task === undefined ? '' : ` · ${event.task}`;
  const status = event.status === undefined ? '' : ` · ${event.status}`;
  console.log(`${at()}  ${event.kind}${task}${status}`);
}
clearTimeout(timer);

// The engine's own ending: `cancelled`, or `succeeded` if the run finished first.
const result = await run.result();
const cause = result.settlement?.cause === undefined ? '' : ` · cause ${result.settlement.cause}`;
console.log(`${at()}  result · ${result.status}${cause}`);
