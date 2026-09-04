import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Nika } from '../src/index.js';
import { eventSettlement } from '../src/lib/machine.js';
import type { NikaEvent } from '../src/index.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);

describe('the settlement rides run.done (engine 0.118+ · ADR-128)', () => {
  it('reads cause · elapsed · tasks · spend from a flattened run_settled frame', () => {
    const frame = {
      kind: 'run_settled',
      status: 'succeeded',
      cause: 'normal',
      elapsed_ms: 3,
      tasks: { total: 1, ok: 1 },
      spend: { qualifier: 'unmetered' },
    } as unknown as NikaEvent;
    expect(eventSettlement(frame)).toEqual({
      cause: 'normal',
      elapsed_ms: 3,
      tasks: { total: 1, ok: 1 },
      spend: { qualifier: 'unmetered' },
    });
  });

  it('reads a nested settlement from the resident and nothing from an older frame', () => {
    const nested = {
      kind: 'execution.settled',
      status: 'failed',
      settlement: { cause: 'task_failed', tasks: { failed: 1 } },
    } as unknown as NikaEvent;
    expect(eventSettlement(nested)).toEqual({ cause: 'task_failed', tasks: { failed: 1 } });
    const older = { kind: 'run_settled', status: 'succeeded' } as unknown as NikaEvent;
    expect(eventSettlement(older)).toBeUndefined();
    expect(eventSettlement(undefined)).toBeUndefined();
  });

  it('carries the settlement on run.done over the native transport', async () => {
    const client = new Nika({ bin: FIXTURE });
    const run = await client.run('settled.nika.yaml');
    const result = await run.done;
    expect(result.status).toBe('succeeded');
    expect(result.settlement).toEqual({
      cause: 'normal',
      elapsed_ms: 12,
      tasks: { total: 2, ok: 2, failed: 0, recovered: 1, skipped: 0, cancelled: 0, never_started: 0 },
      spend: { total_cost_usd: null, priced_calls: 0, unpriced_calls: 0, qualifier: 'unmetered' },
    });
    expect(result.outputs).toEqual({ answer: 'x' });
  });
});
