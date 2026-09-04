import assert from 'node:assert/strict';
import { compareControlledCancellation, compareSameJobResult } from './one-door/contract.mjs';

export function bounded(promise, milliseconds, label, signal) {
  assert(Number.isFinite(milliseconds) && milliseconds > 0, 'a finite positive deadline is required');
  let timer;
  let abort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
      abort = () => reject(signal.reason ?? new Error(`${label} aborted`));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    }),
  ]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

export async function collectRunEvents(client, run, signal, { maxEvents = 256, maxBytes = 1024 * 1024 } = {}) {
  const events = [];
  let bytes = 0;
  try {
    for await (const event of client.events(run, { signal })) {
      bytes += Buffer.byteLength(JSON.stringify(event));
      assert(events.length < maxEvents && bytes <= maxBytes,
        `run event output exceeded ${maxEvents} events or ${maxBytes} bytes`);
      events.push(structuredClone(event));
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
  return events;
}

// Shared by the older cancellation gates. An accepted request is only an
// action; the actual terminal frame must agree with run.done in full.
export async function cancelHeldRun(client, run, gate, signal) {
  const observer = new AbortController();
  const abort = () => observer.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const observation = collectRunEvents(client, run, observer.signal);
  observation.catch(() => {});
  try {
    await bounded(Promise.race([
      gate.arrived,
      run.done.then(() => { throw new Error('run settled before the cancellation rendezvous'); }),
    ]), 15_000, 'cancellation rendezvous', signal);
    const first = client.cancel(run);
    assert.equal(client.cancel(run), first, 'accepted cancellation must be memoized');
    const cancellation = await bounded(first, 5_000, 'cancellation action', signal);
    assert.equal(cancellation.accepted, true);
    assert.equal(cancellation.status, 'cancellation_requested');
    await bounded(gate.release(), 5_000, 'held request release', signal);
    const [result, events] = await bounded(Promise.all([run.done, observation]), 15_000, 'actual cancellation settlement', signal);
    compareControlledCancellation(result);
    compareSameJobResult(result, events.at(-1), 'older gauntlet cancellation');
    const rendezvous = gate.finish();
    return { cancellation, result, events, rendezvous };
  } finally {
    signal?.removeEventListener('abort', abort);
    observer.abort();
    await bounded(observation.catch(() => {}), 2_000, 'cancellation observer cleanup');
  }
}
