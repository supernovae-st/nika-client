import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaConfigurationError, NikaProtocolError } from '../src/index.js';
import type { NikaScheduleOptions } from '../src/index.js';
import { healthResponse, jsonResponse, scheduleStatus } from './helpers/http-depth-harness.js';

const revision = `sha256:${'a'.repeat(64)}`;
const options: NikaScheduleOptions = { id: 'daily', when: { kind: 'cadence', expression: 'TZ=Europe/Paris 0 9 * * *' },
  maxCostUsd: 0.25, missed: 'skip' };
const health = () => healthResponse({ supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'schedule'] });
const client = (fetch: typeof globalThis.fetch) => new Nika({ url: 'https://nika.example', token: 'a'.repeat(32), fetch });
const status = (inputs?: unknown) => {
  const result = scheduleStatus(revision);
  if (inputs !== undefined) Object.assign(result.definition, { inputs });
  return result;
};
const ack = (inputs?: unknown) => jsonResponse({ applied: true, changed: true, status: status(inputs) });

describe('resident schedule input declarations', () => {
  it.each([undefined, {}, { ticketId: '001', limit: 2.5, enabled: false, text: ' 雪\n"literal" ' }])(
    'preserves omission or scalar bytes and returns engine-normalized text: %j', async (inputs) => {
      const normalized = inputs === undefined ? undefined : Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)]));
      const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(ack(normalized));
      const result = await client(fetch).schedule('flow.nika', { ...options, inputs });
      const body = JSON.parse(fetch.mock.calls[1][1].body);
      expect(body).toEqual({ workflow: 'flow.nika', when: options.when, maxCostUsd: 0.25, missed: 'skip',
        ...(inputs === undefined ? {} : { inputs }) });
      expect(fetch.mock.calls[1][0]).toBe('https://nika.example/v1/schedules/daily');
      expect(new Headers(fetch.mock.calls[1][1].headers).get('If-None-Match')).toBe('*');
      expect(result.status.definition.inputs).toEqual(normalized);
    },
  );

  it('captures the map before asynchronous negotiation and carries inputs on CAS replacement', async () => {
    const inputs = { limit: 2 };
    const fetch = vi.fn().mockImplementationOnce(async () => { inputs.limit = 99; return health(); })
      .mockResolvedValueOnce(ack({ limit: '2' }));
    await client(fetch).schedule('flow.nika', { ...options, revision, inputs });
    expect(JSON.parse(fetch.mock.calls[1][1].body).inputs).toEqual({ limit: 2 });
    expect(new Headers(fetch.mock.calls[1][1].headers).get('If-Match')).toBe(`"${revision}"`);
  });

  it.each([null, [], { x: null }, { x: [] }, { x: {} }, { x: undefined }, { x: NaN }, { x: Infinity },
    { x: 1n }, { x: () => 1 }, { x: '\ud800' }, { x: 'a'.repeat(1024 * 1024) }])(
    'refuses non-scalar or non-JSON input before health (%#)', async (inputs) => {
      const fetch = vi.fn();
      await expect(client(fetch).schedule('flow.nika', { ...options, inputs: inputs as NikaScheduleOptions['inputs'] }))
        .rejects.toBeInstanceOf(NikaConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('never calls map accessors, toJSON or Proxy traps', async () => {
    const getter = vi.fn(() => 'hidden'); const trap = vi.fn(); const toJSON = vi.fn(() => ({}));
    for (const inputs of [Object.defineProperty({}, 'x', { get: getter, enumerable: true }),
      new Proxy({}, { ownKeys: trap }), { x: new Proxy({}, { ownKeys: trap }) }, { toJSON }]) {
      const fetch = vi.fn();
      await expect(client(fetch).schedule('flow.nika', { ...options, inputs: inputs as NikaScheduleOptions['inputs'] }))
        .rejects.toBeInstanceOf(NikaConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled();
  });

  it('does not expand @env and preserves a resident binding refusal', async () => {
    const findings = [{ code: 'schedule.inputs', detail: '@env: references are not permitted' }];
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(jsonResponse({ findings }, 422));
    await expect(client(fetch).schedule('flow.nika', { ...options, inputs: { value: '@env:PRIVATE_VALUE' } }))
      .rejects.toMatchObject({ name: 'NikaOperationError', operation: 'schedule', code: 'schedule_refused', findings });
    expect(JSON.parse(fetch.mock.calls[1][1].body).inputs).toEqual({ value: '@env:PRIVATE_VALUE' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the schedule capability gate without inventing an inputs capability', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse());
    await expect(client(fetch).schedule('flow.nika', { ...options, inputs: { x: 1 } }))
      .rejects.toMatchObject({ name: 'NikaCompatibilityError', capability: 'schedule' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([null, [], { x: 1 }, { x: true }, { x: {} }])('rejects malformed returned normalized inputs: %j', async (inputs) => {
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(ack(inputs));
    await expect(client(fetch).schedule('flow.nika', options)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('reads normalized inputs from scheduleStatus', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(jsonResponse(status({ x: 'true' })));
    expect((await client(fetch).scheduleStatus('daily')).definition.inputs).toEqual({ x: 'true' });
  });
});
