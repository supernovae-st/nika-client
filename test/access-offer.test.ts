import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import type { NikaAccessOffer, NikaAccessOfferRoute } from '../src/index.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
} from './helpers/http-depth-harness.js';

const CAPABILITIES = ['check', 'executionSnapshot', 'eventStream', 'accessSessionOffer'];

function remote(fetch: typeof globalThis.fetch): Nika {
  return new Nika({ url: 'https://nika.example/', token: TOKEN_A, bin: HTTP_DEPTH_FIXTURE, fetch });
}

function health(): Response {
  return healthResponse({ engineVersion: '0.124.3', supportedCapabilities: CAPABILITIES });
}

/** One observed row, as the engine's door serves it. */
function observed(profile: 'completion' | 'agent', tasks: string[]): NikaAccessOfferRoute {
  return {
    via: 'codex',
    protocol: 'acp',
    profile,
    tasks,
    status: 'observed',
    observed_at: '2026-11-10T17:00:00Z',
    fresh_until: '2026-11-10T17:01:00Z',
    adapter: { name: '@agentclientprotocol/codex-acp', version: '1.13.1' },
    model: {
      requested: 'openai/gpt-6-luna',
      status: 'confirmed',
      current: 'gpt-6-luna',
      offered: ['gpt-6-astra', 'gpt-6-luna'],
      omitted: 0,
    },
    effort: {
      status: 'offered',
      option: 'reasoning_effort',
      offered: ['low', 'medium', 'high'],
      omitted: 0,
      current: 'medium',
    },
    service_tier: {
      status: 'offered',
      option: 'fast-mode',
      offered: ['standard', 'fast'],
      omitted: 0,
      current: 'standard',
    },
  };
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'nika/access-offer@1',
    workflow: 'workflows/brief.nika',
    status: 'read',
    declared: { via: 'codex', protocol: 'acp', fallback: 'none', effort: 'low' },
    prompts_sent: 0,
    routes: [observed('completion', ['brief']), observed('agent', ['render'])],
    routes_omitted: 0,
    ...overrides,
  };
}

describe('accessOffer · what a served workflow\'s declared ACP route offers', () => {
  it('asks the door by served name and returns the document as served', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(jsonResponse(document()));
    const offer = await remote(fetch as typeof globalThis.fetch).accessOffer('workflows/brief.nika');

    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      'https://nika.example/v1/access-offers/workflows/brief.nika',
    );
    expect((fetch.mock.calls[1]?.[1] as RequestInit).method).toBe('GET');
    expect(offer).toEqual(document());
    expectTypeOf(offer).toEqualTypeOf<NikaAccessOffer>();
    const [completion] = offer.routes;
    expect(completion?.effort?.offered).toEqual(['low', 'medium', 'high']);
    expect(offer.prompts_sent).toBe(0);
  });

  it('returns a workflow without a declared ACP route as not applicable', async () => {
    const answer = {
      schema: 'nika/access-offer@1',
      workflow: 'workflows/plain.nika',
      status: 'not_applicable',
      reason: 'the workflow declares no `run.access`: it names no route to ask',
      prompts_sent: 0,
      routes: [],
      routes_omitted: 0,
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(jsonResponse(answer));
    await expect(remote(fetch as typeof globalThis.fetch).accessOffer('workflows/plain.nika'))
      .resolves.toEqual(answer);
  });

  it('keeps a session that gave no offer as a row with its code', async () => {
    const unavailable = {
      via: 'codex',
      protocol: 'acp',
      profile: 'completion',
      tasks: ['brief'],
      status: 'unavailable',
      observed_at: '2026-11-10T17:00:00Z',
      fresh_until: '2026-11-10T17:00:15Z',
      code: 'NIKA-1803',
      reason: 'harness unavailable: adapter `codex`: the initialize handshake did not answer in 30s',
      model: { requested: 'openai/gpt-6-luna' },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce(jsonResponse(document({ routes: [unavailable] })));
    const offer = await remote(fetch as typeof globalThis.fetch).accessOffer('workflows/brief.nika');
    expect(offer.routes).toEqual([unavailable]);
  });

  it('asks nothing of a server that does not advertise the capability', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse({ engineVersion: '0.124.2' }));
    const asked = remote(fetch as typeof globalThis.fetch).accessOffer('workflows/brief.nika');
    await expect(asked).rejects.toBeInstanceOf(NikaCompatibilityError);
    await expect(asked).rejects.toMatchObject({ capability: 'accessSessionOffer' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses locally: an offer belongs to a resident server', async () => {
    const local = new Nika({ bin: HTTP_DEPTH_FIXTURE });
    await expect(local.accessOffer('workflows/brief.nika')).rejects.toMatchObject({
      name: 'NikaCompatibilityError',
      capability: 'accessSessionOffer',
    });
  });

  it('names an uncontained workflow before any request', async () => {
    const fetch = vi.fn();
    const client = remote(fetch as typeof globalThis.fetch);
    await expect(client.accessOffer('../secret.nika')).rejects.toThrow(/contained/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the door\'s typed refusals as operation errors', async () => {
    for (const [status, code] of [
      [404, 'not_found'],
      [503, 'access_offer_busy'],
      [422, 'NIKA-PARSE-005'],
      [408, 'request_timeout'],
    ] as const) {
      const fetch = vi.fn()
        .mockResolvedValueOnce(health())
        .mockResolvedValueOnce(jsonResponse({ error: { code, message: 'refused by the door' } }, status));
      const asked = remote(fetch as typeof globalThis.fetch).accessOffer('workflows/brief.nika');
      await expect(asked).rejects.toBeInstanceOf(NikaOperationError);
      await expect(asked).rejects.toMatchObject({ operation: 'accessOffer', code });
    }
  });

  it('refuses a document it cannot read whole, never guessing around it', async () => {
    const route = observed('completion', ['brief']);
    const broken: Record<string, unknown>[] = [
      document({ schema: 'nika/access-offer@2' }),
      document({ workflow: 'workflows/other.nika' }),
      document({ status: 'pending' }),
      document({ prompts_sent: 1 }),
      document({ source: 'nika: secret' }),
      document({ routes_omitted: -1 }),
      document({ routes: Array.from({ length: 9 }, () => route) }),
      document({ routes: [{ ...route, profile: 'conversation' }] }),
      document({ routes: [{ ...route, protocol: 'api' }] }),
      document({ routes: [{ ...route, observed_at: 'yesterday' }] }),
      document({ routes: [{ ...route, prompt: 'hello' }] }),
      document({ routes: [{ ...route, effort: { ...route.effort, offered: ['two words'] } }] }),
      document({ routes: [{ ...route, effort: { status: 'offered' } }] }),
      document({ routes: [{ ...route, effort: { ...route.effort, status: 'maybe' } }] }),
      document({ routes: [{ ...route, model: { ...route.model, status: 'guessed' } }] }),
      document({ routes: [{ ...route, model: { ...route.model, offered: ['x'.repeat(161)] } }] }),
      document({ routes: [{ ...route, effort: undefined }] }),
      document({ routes: [{ ...route, status: 'unavailable' }] }),
      document({ status: 'not_applicable' }),
      document({ status: 'not_applicable', reason: 'no route', routes: [route] }),
    ];
    for (const body of broken) {
      const fetch = vi.fn()
        .mockResolvedValueOnce(health())
        .mockResolvedValueOnce(jsonResponse(body));
      await expect(
        remote(fetch as typeof globalThis.fetch).accessOffer('workflows/brief.nika'),
        JSON.stringify(body).slice(0, 120),
      ).rejects.toBeInstanceOf(NikaProtocolError);
    }
  });

  it('bounds the whole call with its own deadline, apart from the request timeout', async () => {
    const hang = (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockImplementationOnce(hang);
    const client = new Nika({
      url: 'https://nika.example/',
      token: TOKEN_A,
      bin: HTTP_DEPTH_FIXTURE,
      fetch: fetch as typeof globalThis.fetch,
      requestTimeout: 5,
    });
    const started = Date.now();
    const asked = client.accessOffer('workflows/brief.nika', { timeoutMs: 120 });
    await expect(asked).rejects.toBeInstanceOf(NikaTransportError);
    await expect(asked).rejects.toThrow(/timed out after 120ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);

    await expect(client.accessOffer('workflows/brief.nika', { timeoutMs: 0 })).rejects.toThrow(RangeError);
  });

  it('stops when the caller aborts, as the caller\'s own stop', async () => {
    const hang = (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const fetch = vi.fn().mockResolvedValueOnce(health()).mockImplementationOnce(hang);
    const controller = new AbortController();
    const asked = remote(fetch as typeof globalThis.fetch)
      .accessOffer('workflows/brief.nika', { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(asked).rejects.toBeInstanceOf(NikaTransportError);
    await expect(asked).rejects.not.toThrow(/timed out/);
  });
});
