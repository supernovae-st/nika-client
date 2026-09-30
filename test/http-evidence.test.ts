import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaProtocolError } from '../src/index.js';
import { healthResponse, jsonResponse, sseResponse, TOKEN_A } from './helpers/http-depth-harness.js';
import type { NikaEvent } from '../src/index.js';

const loss = { status: 'mirror_lost', reason: 'write_failed' } as const;
function client(event: Record<string, unknown>) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(healthResponse())
    .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'queued' }, 202))
    .mockResolvedValueOnce(sseResponse([{ sequence: 1, kind: 'execution.settled', status: 'succeeded', ...event } as NikaEvent]));
  return new Nika({ url: 'https://nika.example', token: TOKEN_A, fetch });
}

describe('current resident event and journal evidence contract', () => {
  it('keeps event time and journal loss separate from successful execution', async () => {
    const nika = client({ at: '2026-09-28T02:35:00Z', evidence: loss });
    const run = await nika.run('workflows/flow.nika', { idempotencyKey: 'evidence-case' });
    const events = [];
    for await (const event of nika.events(run)) events.push(event);
    expect(events[0]).toMatchObject({ at: '2026-09-28T02:35:00Z', evidence: loss });
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded', evidence: loss });
  });

  it.each([
    { at: 7 }, { at: 'not-a-time' },
    { evidence: { ...loss, path: '/private/journal' } },
    { evidence: { status: 'sealed', reason: 'write_failed' } },
    { evidence: { status: 'mirror_lost', reason: 'invented' } },
    { evidence: null }, { private_field: 'still-forbidden' },
  ])('refuses invalid or private event fields: %j', async (event) => {
    const run = await client(event).run('workflows/flow.nika', { idempotencyKey: 'evidence-case' });
    await expect(run.done).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('keeps the same typed loss when a consumer reattaches after settlement', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'succeeded', evidence: loss }))
      .mockResolvedValueOnce(sseResponse([{ sequence: 1, kind: 'execution.settled', status: 'succeeded', evidence: loss }]));
    const nika = new Nika({ url: 'https://nika.example', token: TOKEN_A, fetch });
    const run = await nika.attachRun('job-1');
    await expect(run.done).resolves.toMatchObject({ status: 'succeeded', evidence: loss });
    const events = [];
    for await (const event of nika.events(run)) events.push(event);
    expect(events[0]).toMatchObject({ evidence: loss });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
