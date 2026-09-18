import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Nika, isNikaRunSucceeded } from '../src/index.js';
import type { NikaRunId, NikaRunResult } from '../src/index.js';
import { TOKEN_A, healthResponse, jsonResponse, sseResponse } from './helpers/http-depth-harness.js';

const id = 'result-fixture' as NikaRunId;

describe('run success guard', () => {
  it.each(['failed', 'paused', 'cancelled', 'interrupted', 'running', 'queued', 'future-status'])(
    'does not mistake %s with partial outputs for success', (status) => {
      const result: NikaRunResult<{ answer: number }> = {
        id, status, transport: 'http', outputs: { answer: 42 },
      };
      const before = structuredClone(result);
      expect(isNikaRunSucceeded(result)).toBe(false);
      expect(result).toEqual(before);
    },
  );

  it('accepts a successful run without inventing outputs', () => {
    const result: NikaRunResult = { id, status: 'succeeded', transport: 'native-process' };
    expect(isNikaRunSucceeded(result)).toBe(true);
    expect(result).not.toHaveProperty('outputs');
  });
});

describe.skipIf(process.platform === 'win32')('native admitted result', () => {
  it.each([
    ['ok.nika.yaml', 'succeeded', true],
    ['fields-failure.nika.yaml', 'failed', false],
  ] as const)('%s resolves and is classified by its engine status', async (workflow, status, succeeded) => {
    const client = new Nika({ bin: path.join(import.meta.dirname, 'fixtures/fake-nika.mjs') });
    const run = await client.run<{ answer: number; boom: null }>(workflow);
    const result = await run.done;
    expect(result.status).toBe(status);
    expect(isNikaRunSucceeded(result)).toBe(succeeded);
    if (status === 'failed') {
      expect(result.error).toMatchObject({ code: 'NIKA-EXEC-001', task: 'boom' });
      expect(result.outputs).toEqual({ boom: null });
    }
  });
});

describe('HTTP admitted result', () => {
  it.each(['succeeded', 'failed', 'paused'] as const)(
    '%s resolves without treating partial output as success', async (status) => {
      const error = status === 'failed'
        ? { code: 'NIKA-TEST-001', message: 'task failed', task: 'work' } : undefined;
      const fetch: typeof globalThis.fetch = async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === '/health') return healthResponse();
        if (pathname === '/v1/jobs/known-job') return jsonResponse({ id: 'known-job', status: 'running' });
        if (pathname === '/v1/jobs/known-job/events') return sseResponse([
          { sequence: 1, kind: 'execution.settled', status, outputs: { answer: 42 },
            settlement: { status, error, cause: status === 'paused' ? 'human_gate' : undefined } },
        ]);
        throw new Error(`unexpected request ${pathname}`);
      };
      const client = new Nika({ url: 'https://nika.example', token: TOKEN_A, fetch });
      const run = await client.attachRun<{ answer: number }>('known-job');
      const result = await run.done;
      expect(result.status).toBe(status);
      expect(result.outputs).toEqual({ answer: 42 });
      expect(isNikaRunSucceeded(result)).toBe(status === 'succeeded');
      if (error) expect(result.error).toEqual(error);
    },
  );
});
