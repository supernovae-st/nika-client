import { describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError } from '../src/index.js';
import { healthResponse, HTTP_DEPTH_FIXTURE, TOKEN_A } from './helpers/http-depth-harness.js';

describe('server identity for an HTTP-only consumer', () => {
  it('returns a detached capability snapshot without resolving a local binary', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse({
      extension: { labels: ['original'] },
    }));
    const client = new Nika({ url: 'https://nika.example', token: TOKEN_A,
      bin: '/absent/consumer-must-not-spawn-nika', fetch: fetch as typeof globalThis.fetch });
    const first = await client.serverIdentity();
    expect(first.engineVersion).toBe('0.114.0');
    expect(first.supportedCapabilities).toContain('check');
    first.supportedCapabilities.push('costReviewV1');
    (first.extension as { labels: string[] }).labels[0] = 'changed';
    const second = await client.serverIdentity();
    expect(second.supportedCapabilities).not.toContain('costReviewV1');
    expect(second.extension).toEqual({ labels: ['original'] });
    await expect(client.prepareCostReview({ workflow: 'sample.nika' }))
      .rejects.toMatchObject({ capability: 'costReviewV1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://nika.example/health');
  });

  it('cannot advertise capabilities from an incompatible server', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(healthResponse({ machineProtocolVersion: 999 }));
    const client = new Nika({ url: 'https://nika.example', token: TOKEN_A,
      bin: '/absent/consumer-must-not-spawn-nika', fetch: fetch as typeof globalThis.fetch });
    await expect(client.serverIdentity()).rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares a failed handshake, then permits a fresh caller to retry health only', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('temporarily unavailable'))
      .mockResolvedValueOnce(healthResponse());
    const client = new Nika({ url: 'https://nika.example', token: TOKEN_A,
      bin: '/absent/consumer-must-not-spawn-nika', fetch: fetch as typeof globalThis.fetch });
    const failed = await Promise.allSettled([client.serverIdentity(), client.serverIdentity()]);
    expect(failed.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await client.serverIdentity()).engineVersion).toBe('0.114.0');
    await client.serverIdentity();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/health'))).toBe(true);
  });

  it('refuses server discovery on a native transport', async () => {
    const client = new Nika({ bin: HTTP_DEPTH_FIXTURE });
    await expect(client.serverIdentity()).rejects.toMatchObject({
      capability: 'serverIdentity', transport: 'native-process',
    });
  });
});
