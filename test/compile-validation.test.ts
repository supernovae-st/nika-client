import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaConfigurationError } from '../src/index.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const binary = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
afterEach(() => { vi.clearAllMocks(); });

describe.each(['native', 'http'])('compile %s never runs caller accessors or Proxy traps', (door) => {
  const setup = () => {
    const fetch = vi.fn();
    const client = new Nika(door === 'native' ? { bin: binary } : {
      url: 'https://nika.example', token: 'x'.repeat(32), bin: binary, fetch,
    });
    return { client, fetch };
  };
  it.each(['intent', 'workflow', 'change', 'answers', 'unknown'])('refuses a request accessor on %s', async (key) => {
    const get = vi.fn(() => { throw new Error('caller getter ran'); });
    const { client, fetch } = setup();
    const request = Object.defineProperty({}, key, { get, enumerable: true });
    await expect(client.compile(request)).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(get).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['signal', 'timeoutMs', 'unknown'])('refuses an options accessor on %s', async (key) => {
    const get = vi.fn(() => { throw new Error('caller getter ran'); });
    const { client, fetch } = setup();
    await expect(client.compile('hello', Object.defineProperty({}, key, { get, enumerable: true })))
      .rejects.toBeInstanceOf(NikaConfigurationError);
    expect(get).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['request', 'options', 'signal', 'timeoutMs', 'answers', 'change', 'revoked'])('refuses %s proxies', async (location) => {
    const trap = vi.fn(() => { throw new Error('caller trap ran'); });
    const revocable = Proxy.revocable({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const proxy = revocable.proxy;
    const { client, fetch } = setup();
    if (location === 'revoked') revocable.revoke();
    const request = ['request', 'revoked'].includes(location) ? proxy
      : location === 'answers' ? { intent: 'hello', answers: proxy }
      : location === 'change' ? { workflow: 'source', change: proxy } : 'hello';
    const options = location === 'options' ? proxy : ['signal', 'timeoutMs'].includes(location) ? { [location]: proxy } : {};
    await expect(client.compile(request as any, options)).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(trap).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses coercion hooks, null options and an unbranded signal without a process or request', async () => {
    const toString = vi.fn(() => { throw new Error('caller coercion ran'); });
    const { client, fetch } = setup();
    for (const options of [null, { timeoutMs: { toString } }, { signal: Object.create(AbortSignal.prototype) }]) {
      await expect(client.compile('hello', options as any)).rejects.toBeInstanceOf(NikaConfigurationError);
    }
    expect(toString).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
