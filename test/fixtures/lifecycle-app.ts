// An application, not a test: it imports only the package's public surface
// and speaks only the SDK's lifecycle vocabulary. The same file is driven over
// the native process and over HTTP by run-lifecycle.test.ts, which also reads
// this source and refuses any protocol word in it. The packed-consumer check
// compiles it, strictly, against the published types.
import type { Nika, NikaRun, NikaRunOptions } from '../../src/index.js';

export type LifecycleOutcome =
  | 'succeeded'
  | 'waiting'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'unknown';

export interface LifecycleReport {
  runId: string;
  /** Every lifecycle fact observed, in order. */
  facts: string[];
  /** `fact:task` for each per-task fact the transport emitted. */
  tasks: string[];
  /** The last replay cursor seen; a native process offers none. */
  cursor?: number;
  outcome: LifecycleOutcome;
  failure?: { code?: string; message?: string; task?: string };
  outputs?: Record<string, unknown>;
}

/** Start a run and read it to its result: the whole happy path. */
export async function runToReport(
  nika: Nika,
  workflow: string,
  options?: NikaRunOptions,
): Promise<LifecycleReport> {
  return observe(await nika.run(workflow, options));
}

/** Observe any owned run, freshly started or recovered through attachRun. */
export async function observe(run: NikaRun): Promise<LifecycleReport> {
  const facts: string[] = [];
  const tasks: string[] = [];
  let cursor: number | undefined;

  for await (const event of run.events()) {
    facts.push(event.kind);
    if (event.sequence !== undefined) cursor = event.sequence;
    switch (event.kind) {
      case 'task.scheduled':
      case 'task.started':
      case 'task.completed':
      case 'task.failed':
        tasks.push(`${event.kind}:${event.task ?? '?'}`);
        break;
      default:
        break;
    }
  }

  // An admitted failure is result data: nothing above or below throws for it.
  const result = await run.result();
  return {
    runId: run.id,
    facts,
    tasks,
    ...(cursor !== undefined ? { cursor } : {}),
    outcome: outcomeOf(result.status),
    ...(result.error ? { failure: result.error } : {}),
    ...(result.outputs ? { outputs: result.outputs } : {}),
  };
}

function outcomeOf(status: string): LifecycleOutcome {
  switch (status) {
    case 'succeeded': return 'succeeded';
    // A human gate holds the run. It is neither a failure nor a completion.
    case 'paused': return 'waiting';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'interrupted';
    default: return 'unknown';
  }
}
