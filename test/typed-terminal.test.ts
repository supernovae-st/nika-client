import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  isNikaRunSealedEvent,
  isNikaRunSettledEvent,
  isNikaTerminalEvent,
  Nika,
} from '../src/index.js';
import type {
  NikaCancelResult,
  NikaEvent,
  NikaExecutionCancelledEvent,
  NikaExecutionId,
  NikaExecutionInterruptedEvent,
  NikaExecutionRefusedEvent,
  NikaExecutionSettledEvent,
  NikaExecutionStartedEvent,
  NikaJobId,
  NikaReceipt,
  NikaRun,
  NikaRunId,
  NikaRunResult,
  NikaRunSealedEvent,
  NikaRunSettledEvent,
  NikaRunStatus,
} from '../src/index.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
  sseResponse,
} from './helpers/http-depth-harness.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);
const posix = process.platform !== 'win32';

/** The engine's terminal statuses, whichever transport reported them. */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'interrupted', 'cancelled'] as const;

/** An engine-issued receipt for the durable job observed below. */
const HTTP_RECEIPT = Object.freeze({
  job_id: 'durable-job',
  execution_id: 'execution-1',
  trace_id: 'trace-1',
  snapshot_digest: 'a'.repeat(64),
});

// Every expectTypeOf assertion in this file is judged by `tsc`; vitest runs it
// as a no-op, so a green run alone does not prove one. The repo tsconfig covers
// `src`, so typecheck this file explicitly to make them speak:
//   npx tsc --noEmit --strict --target ES2022 --module ESNext \
//     --moduleResolution bundler --skipLibCheck --lib ES2022,DOM \
//     test/typed-terminal.test.ts

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
      // The guard narrows to the settlement frame of either transport.
      expectTypeOf(event).toEqualTypeOf<
        NikaRunSettledEvent<{ answer: number }> | NikaExecutionSettledEvent<{ answer: number }>
      >();
      expectTypeOf(event.outputs).toEqualTypeOf<{ answer: number } | undefined>();
      expectTypeOf(event.status).toEqualTypeOf<NikaRunStatus | undefined>();
      expectTypeOf(event.receipt).toEqualTypeOf<NikaReceipt | undefined>();
    }
    if (isNikaTerminalEvent(event)) {
      // Status, not kind, is the axis: the frame is terminal and says so.
      expectTypeOf(event.status).not.toEqualTypeOf<NikaRunStatus | undefined>();
      expectTypeOf(event.status).toExtend<NikaRunStatus>();
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

  it('types the HTTP transport event kinds the engine actually emits', () => {
    expectTypeOf<NikaExecutionStartedEvent['kind']>().toEqualTypeOf<'execution.started'>();
    expectTypeOf<NikaExecutionSettledEvent['kind']>().toEqualTypeOf<'execution.settled'>();
    expectTypeOf<NikaExecutionCancelledEvent['kind']>().toEqualTypeOf<'execution.cancelled'>();
    expectTypeOf<NikaExecutionRefusedEvent['kind']>().toEqualTypeOf<'execution.refused'>();
    // A resident that restarts marks an orphaned running job with either word.
    expectTypeOf<NikaExecutionInterruptedEvent['kind']>()
      .toEqualTypeOf<'execution.interrupted' | 'interrupted'>();
    // The HTTP settlement frame carries the same three payloads as run_settled.
    expectTypeOf<NikaExecutionSettledEvent<{ answer: number }>['outputs']>()
      .toEqualTypeOf<{ answer: number } | undefined>();
    expectTypeOf<NikaExecutionSettledEvent['status']>().toEqualTypeOf<NikaRunStatus | undefined>();
    expectTypeOf<NikaExecutionSettledEvent['receipt']>().toEqualTypeOf<NikaReceipt | undefined>();
    // Every new variant keeps its future fields open.
    expectTypeOf<NikaExecutionSettledEvent['future_field']>().toEqualTypeOf<unknown>();
    expectTypeOf<NikaExecutionStartedEvent['future_field']>().toEqualTypeOf<unknown>();
    // The union stays non-exhaustive: the new kinds join, they do not close it.
    expectTypeOf<NikaExecutionStartedEvent>().toExtend<NikaEvent>();
    expectTypeOf<NikaExecutionSettledEvent>().toExtend<NikaEvent>();
    expectTypeOf<NikaExecutionCancelledEvent>().toExtend<NikaEvent>();
    expectTypeOf<NikaExecutionRefusedEvent>().toExtend<NikaEvent>();
    expectTypeOf<NikaExecutionInterruptedEvent>().toExtend<NikaEvent>();
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
    // A kind we cannot name is still terminal when its status says so.
    expect(isNikaTerminalEvent(future)).toBe(true);
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

  it('recognizes the settlement frame of either transport', () => {
    // Measured HTTP terminal frame: kind execution.settled, status succeeded.
    expect(isNikaRunSettledEvent({
      kind: 'execution.settled',
      status: 'succeeded',
      outputs: { answer: 42 },
      receipt: HTTP_RECEIPT,
    })).toBe(true);
    expect(isNikaRunSettledEvent({ kind: 'execution.settled' })).toBe(true);
    // The other HTTP kinds are not the settlement frame.
    expect(isNikaRunSettledEvent({ kind: 'execution.started', status: 'running' })).toBe(false);
    expect(isNikaRunSettledEvent({ kind: 'execution.cancelled', status: 'cancelled' })).toBe(false);
    expect(isNikaRunSettledEvent({ kind: 'execution.refused' })).toBe(false);
    expect(isNikaRunSettledEvent({ kind: 'interrupted', status: 'interrupted' })).toBe(false);
  });

  it('recognizes a terminal frame by status on either transport', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isNikaTerminalEvent({ kind: 'execution.settled', status })).toBe(true);
      expect(isNikaTerminalEvent({ kind: 'run_settled', status })).toBe(true);
      // A refusal is terminal on whichever terminal status it carries.
      expect(isNikaTerminalEvent({ kind: 'execution.refused', status })).toBe(true);
      expect(isNikaTerminalEvent({ status })).toBe(true);
    }
    // Measured frames from both transports.
    expect(isNikaTerminalEvent({ kind: 'execution.cancelled', status: 'cancelled' })).toBe(true);
    expect(isNikaTerminalEvent({ kind: 'interrupted', status: 'interrupted' })).toBe(true);
    expect(isNikaTerminalEvent({ kind: 'execution.interrupted', status: 'interrupted' }))
      .toBe(true);
    expect(isNikaTerminalEvent({ kind: 'workflow_completed', status: 'succeeded' })).toBe(true);
    expect(isNikaTerminalEvent({ kind: 'workflow_failed', status: 'failed' })).toBe(true);
    expect(isNikaTerminalEvent({ kind: 'workflow_interrupted', status: 'interrupted' }))
      .toBe(true);
    // Non-terminal or status-free frames are not terminal.
    expect(isNikaTerminalEvent({ kind: 'execution.started', status: 'running' })).toBe(false);
    expect(isNikaTerminalEvent({ kind: 'workflow_started', status: 'queued' })).toBe(false);
    expect(isNikaTerminalEvent({ kind: 'task_completed' })).toBe(false);
    expect(isNikaTerminalEvent({ kind: 'run_sealed' })).toBe(false);
    expect(isNikaTerminalEvent({ status: 'paused' })).toBe(true);
    expect(isNikaTerminalEvent({})).toBe(false);
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

describe('typed terminal hop through the HTTP transport', () => {
  it('fires the settlement guard once, on the execution.settled frame', async () => {
    // The wire vocabulary measured against a live `nika serve --bind`:
    // [[1,"execution.started","running"],[2,"execution.settled","succeeded"]].
    const frames = [
      { sequence: 1, kind: 'execution.started', status: 'running' },
      {
        sequence: 2,
        kind: 'execution.settled',
        status: 'succeeded',
        outputs: { answer: 1 },
        receipt: HTTP_RECEIPT,
      },
    ] satisfies NikaEvent[];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return healthResponse();
      if (path === '/v1/jobs/durable-job') {
        return jsonResponse({ id: 'durable-job', status: 'running' });
      }
      if (path === '/v1/jobs/durable-job/events') return sseResponse(frames);
      throw new Error(`unexpected ${path}`);
    });
    const client = new Nika({
      url: 'https://nika.example',
      token: TOKEN_A,
      bin: HTTP_DEPTH_FIXTURE,
      fetch: fetch as typeof globalThis.fetch,
    });

    const run = await client.attachRun<{ answer: number }>('durable-job');
    const kinds: Array<string | undefined> = [];
    const settledAnswers: Array<number | undefined> = [];
    const terminalKinds: Array<string | undefined> = [];
    for await (const event of client.events(run)) {
      kinds.push(event.kind);
      if (isNikaRunSettledEvent(event)) {
        expectTypeOf(event.outputs).toEqualTypeOf<{ answer: number } | undefined>();
        settledAnswers.push(event.outputs?.answer);
        expect(event.receipt).toEqual(HTTP_RECEIPT);
        expect(event.status).toBe('succeeded');
      }
      if (isNikaTerminalEvent(event)) terminalKinds.push(event.kind);
    }

    expect(kinds).toEqual(['execution.started', 'execution.settled']);
    // The guard the README teaches now fires on the HTTP transport too.
    expect(settledAnswers).toEqual([1]);
    expect(terminalKinds).toEqual(['execution.settled']);
    await expect(run.done).resolves.toMatchObject({
      id: 'durable-job',
      status: 'succeeded',
      transport: 'http',
      outputs: { answer: 1 },
      receipt: HTTP_RECEIPT,
    });
  });

  it('reads cancelled and interrupted frames as terminal without a settlement', async () => {
    // Measured cancel: [[1,"execution.started","running"],[2,"execution.cancelled","cancelled"]].
    // Measured resident restart then attachRun: [[2,"interrupted","interrupted"]].
    for (const terminal of [
      { sequence: 2, kind: 'execution.cancelled', status: 'cancelled' },
      { sequence: 2, kind: 'interrupted', status: 'interrupted' },
    ] satisfies NikaEvent[]) {
      const frames = [
        { sequence: 1, kind: 'execution.started', status: 'running' },
        terminal,
      ] satisfies NikaEvent[];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/health') return healthResponse();
        if (path === '/v1/jobs/durable-job') {
          return jsonResponse({ id: 'durable-job', status: 'running' });
        }
        if (path === '/v1/jobs/durable-job/events') return sseResponse(frames);
        throw new Error(`unexpected ${path}`);
      });
      const client = new Nika({
        url: 'https://nika.example',
        token: TOKEN_A,
        bin: HTTP_DEPTH_FIXTURE,
        fetch: fetch as typeof globalThis.fetch,
      });

      const run = await client.attachRun('durable-job');
      const observed: Array<[string | undefined, boolean, boolean]> = [];
      for await (const event of client.events(run)) {
        observed.push([
          event.kind,
          isNikaRunSettledEvent(event),
          isNikaTerminalEvent(event),
        ]);
      }

      expect(observed).toEqual([
        ['execution.started', false, false],
        [terminal.kind, false, true],
      ]);
      await expect(run.done).resolves.toMatchObject({ status: terminal.status });
    }
  });
});
