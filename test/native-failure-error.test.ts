import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Nika } from '../src/index.js';
import { eventError } from '../src/lib/machine.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-nika.mjs',
);

describe('a failed native run carries the engine failure', () => {
  it('reads the code, message and task from a task_failed frame', () => {
    expect(eventError({
      kind: 'task_failed',
      fields: [
        { key: 'task', value: 'boom' },
        { key: 'detail', value: 'NIKA-EXEC-001 · command exited with status 1: ' },
      ],
    })).toEqual({
      code: 'NIKA-EXEC-001',
      message: 'command exited with status 1:',
      task: 'boom',
    });
  });

  it('keeps a detail without a code as the message alone', () => {
    expect(eventError({
      kind: 'task_failed',
      fields: [{ key: 'detail', value: 'the provider hung up' }],
    })).toEqual({ message: 'the provider hung up' });
  });

  it('reads the cause a 0.117+ run_settled frame carries', () => {
    expect(eventError({
      kind: 'run_settled',
      status: 'failed',
      outputs: { result: null },
      error: { code: 'NIKA-BUILTIN-READ-001', message: 'no such file: ./missing.md', task: 'brief' },
    })).toEqual({
      code: 'NIKA-BUILTIN-READ-001',
      message: 'no such file: ./missing.md',
      task: 'brief',
    });
    expect(eventError({ kind: 'run_settled', status: 'succeeded', outputs: { result: 1 } }))
      .toBeUndefined();
  });

  it('reads nothing from frames that carry no failure', () => {
    expect(eventError({ kind: 'task_started', fields: [{ key: 'task', value: 'boom' }] }))
      .toBeUndefined();
    expect(eventError({ kind: 'workflow_failed', fields: [{ key: 'workflow', value: 'x' }] }))
      .toBeUndefined();
    expect(eventError({ kind: 'task_failed' })).toBeUndefined();
  });

  it('settles run.done with the failure the engine named', async () => {
    const nika = new Nika({ bin: FIXTURE });
    const run = await nika.run('fields-failure.nika.yaml');
    const kinds: string[] = [];
    for await (const event of nika.events(run)) kinds.push(String(event.kind));
    const result = await run.done;
    expect(kinds).toEqual(['workflow_started', 'task_completed', 'task_failed', 'workflow_failed', 'run_settled']);
    expect(result.status).toBe('failed');
    expect(result.error).toEqual({
      code: 'NIKA-EXEC-001',
      message: 'command exited with status 1:',
      task: 'boom',
    });
  });
});
