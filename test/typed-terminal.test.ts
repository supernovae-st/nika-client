import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isNikaRunSealedEvent,
  isNikaRunSettledEvent,
  Nika,
} from '../src/index.js';
import type {
  NikaCancelResult,
  NikaEvent,
  NikaExecutionId,
  NikaJobId,
  NikaReceipt,
  NikaRun,
  NikaRunId,
  NikaRunResult,
  NikaRunSealedEvent,
  NikaRunSettledEvent,
  NikaRunStatus,
} from '../src/index.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);
const posix = process.platform !== 'win32';

// Compile-time only: this function is never invoked, so nothing in it runs.
async function genericFlows(client: Nika): Promise<void> {
  // The caller's Outputs type flows run → done → events.
  const run = await client.run<{ answer: number }>('flow.nika.yaml');
  expectTypeOf(run).toEqualTypeOf<NikaRun<{ answer: number }>>();
  expectTypeOf(run.id).toEqualTypeOf<NikaRunId>();
  expectTypeOf(run.done).toEqualTypeOf<Promise<NikaRunResult<{ answer: number }>>>();
  const result = await run.done;
  expectTypeOf(result.outputs).toEqualTypeOf<{ answer: number } | undefined>();
  expectTypeOf(result.execution_id).toEqualTypeOf<NikaExecutionId | undefined>();

  const attached = await client.attachRun<{ answer: number }>('durable-job');
  expectTypeOf(attached.done).toEqualTypeOf<Promise<NikaRunResult<{ answer: number }>>>();

  for await (const event of client.events(run)) {
    expectTypeOf(event).toEqualTypeOf<NikaEvent<{ answer: number }>>();
    if (event.kind === 'run_settled') {
      // Kind equality keeps the forward-compat variant: outputs widen.
      expectTypeOf(event.outputs).toEqualTypeOf<
        { answer: number } | Record<string, unknown> | undefined
      >();
    }
    if (isNikaRunSettledEvent(event)) {
      // The guard narrows to the exact terminal frame.
      expectTypeOf(event).toEqualTypeOf<NikaRunSettledEvent<{ answer: number }>>();
      expectTypeOf(event.outputs).toEqualTypeOf<{ answer: number } | undefined>();
      expectTypeOf(event.status).toEqualTypeOf<NikaRunStatus | undefined>();
      expectTypeOf(event.receipt).toEqualTypeOf<NikaReceipt | undefined>();
    }
  }

  // Omitting the generic keeps the transport shape, so existing code compiles.
  const untyped = await client.run('flow.nika.yaml');
  expectTypeOf(untyped).toEqualTypeOf<NikaRun>();
  const untypedResult = await untyped.done;
  expectTypeOf(untypedResult.outputs).toEqualTypeOf<Record<string, unknown> | undefined>();
  for await (const event of client.events(untyped)) {
    expectTypeOf(event).toEqualTypeOf<NikaEvent>();
    expectTypeOf(event.kind).toEqualTypeOf<string | undefined>();
    expectTypeOf(event.outputs).toEqualTypeOf<Record<string, unknown> | undefined>();
  }
}
void genericFlows;

describe('typed terminal hop', () => {
  it('types the terminal frame payload without closing its fields', () => {
    expectTypeOf<NikaRunSettledEvent['kind']>().toEqualTypeOf<'run_settled'>();
    expectTypeOf<NikaRunSealedEvent['kind']>().toEqualTypeOf<'run_sealed'>();
    expectTypeOf<NikaRunSettledEvent<{ answer: number }>['outputs']>()
      .toEqualTypeOf<{ answer: number } | undefined>();
    expectTypeOf<NikaRunSettledEvent['status']>().toEqualTypeOf<NikaRunStatus | undefined>();
    expectTypeOf<NikaRunSettledEvent['receipt']>().toEqualTypeOf<NikaReceipt | undefined>();
    // Future engine fields stay open on the terminal frame and the result.
    expectTypeOf<NikaRunSettledEvent['future_field']>().toEqualTypeOf<unknown>();
    expectTypeOf<NikaRunResult['diagnostics']>().toEqualTypeOf<unknown>();
  });

  it('keeps unknown event kinds representable by design', () => {
    const future = {
      kind: 'execution.custom_2030',
      status: 'succeeded',
      sequence: 9,
      future_field: { nested: true },
    } satisfies NikaEvent;
    expect(isNikaRunSettledEvent(future)).toBe(false);
    expect(isNikaRunSealedEvent(future)).toBe(false);
  });

  it('brands identities while keeping them assignable to string', () => {
    expectTypeOf<NikaRun['id']>().toEqualTypeOf<NikaRunId>();
    expectTypeOf<NikaRunResult['id']>().toEqualTypeOf<NikaRunId>();
    expectTypeOf<NikaCancelResult['runId']>().toEqualTypeOf<NikaRunId>();
    expectTypeOf<NikaRunId>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<NikaRunId>();
    expectTypeOf<NikaRunId>().not.toExtend<NikaExecutionId>();
    expectTypeOf<NikaExecutionId>().not.toExtend<NikaRunId>();
    expectTypeOf<NikaJobId>().not.toExtend<NikaRunId>();
  });
});

describe('terminal frame guards', () => {
  it('recognizes only the terminal settlement frame', () => {
    expect(isNikaRunSettledEvent({ kind: 'run_settled' })).toBe(true);
    expect(isNikaRunSettledEvent({
      kind: 'run_settled',
      status: 'succeeded',
      outputs: { answer: 42 },
    })).toBe(true);
    expect(isNikaRunSettledEvent({ kind: 'run_sealed' })).toBe(false);
    expect(isNikaRunSettledEvent({ kind: 'workflow_completed' })).toBe(false);
    expect(isNikaRunSettledEvent({ kind: 'task_completed' })).toBe(false);
    expect(isNikaRunSettledEvent({ kind: 'execution.custom' })).toBe(false);
    expect(isNikaRunSettledEvent({})).toBe(false);
  });

  it('recognizes only the seal frame', () => {
    expect(isNikaRunSealedEvent({ kind: 'run_sealed' })).toBe(true);
    expect(isNikaRunSealedEvent({ kind: 'run_settled' })).toBe(false);
    expect(isNikaRunSealedEvent({ kind: 'workflow_completed' })).toBe(false);
    expect(isNikaRunSealedEvent({ kind: 'execution.custom' })).toBe(false);
    expect(isNikaRunSealedEvent({})).toBe(false);
  });
});

describe.skipIf(!posix)('typed terminal hop through a real run', () => {
  it('flows the caller outputs type through events and the terminal result', async () => {
    const client = new Nika({ bin: FIXTURE });
    const run = await client.run<{ answer: number }>('ok.nika.yaml');
    expectTypeOf(run.id).toEqualTypeOf<NikaRunId>();
    const seen: Array<string | undefined> = [];
    for await (const event of client.events(run)) {
      seen.push(event.kind);
      if (isNikaRunSettledEvent(event)) {
        expectTypeOf(event.outputs).toEqualTypeOf<{ answer: number } | undefined>();
      }
    }
    const result = await run.done;
    expectTypeOf(result.outputs).toEqualTypeOf<{ answer: number } | undefined>();
    expect(result).toMatchObject({
      status: 'succeeded',
      transport: 'native-process',
      outputs: { answer: 42 },
    });
    expect(seen).toEqual(['workflow_started', 'task_completed', 'workflow_completed']);
  });
});
