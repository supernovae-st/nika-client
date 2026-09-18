import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaConfigurationError } from '../src/index.js';
import { compileSignal, normalizeCompileOptions } from '../src/lib/compile.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe('Compile owns its cancellation signal', () => {
  it('does not inspect public fields on sources of a caller composite', () => {
    const controller = new AbortController();
    const caller = AbortSignal.any([controller.signal]);
    const get = vi.fn(() => { throw new Error('nested caller getter ran'); });
    Object.defineProperty(controller.signal, 'aborted', { get });
    const composed = compileSignal(normalizeCompileOptions({ signal: caller }));
    try {
      expect(composed.signal?.aborted).toBe(false);
      controller.abort();
      expect(composed.signal?.aborted).toBe(true);
      expect(get).not.toHaveBeenCalled();
    } finally { composed.dispose(); }
  });
  it('propagates cancellation past stopImmediatePropagation and releases its listener', () => {
    const controller = new AbortController();
    controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
    const composed = compileSignal(normalizeCompileOptions({ signal: controller.signal }));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(2);
    controller.abort();
    expect(composed.signal?.aborted).toBe(true);
    composed.dispose();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
  });
  it('cleans up intrinsically even if the caller later shadows removeEventListener', () => {
    const controller = new AbortController();
    const composed = compileSignal(normalizeCompileOptions({ signal: controller.signal }));
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    const get = vi.fn(() => { throw new Error('caller cleanup getter ran'); });
    Object.defineProperty(controller.signal, 'removeEventListener', { get });
    composed.dispose();
    composed.dispose();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(get).not.toHaveBeenCalled();
  });
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
  it.each(['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener', 'dispatchEvent'])('refuses a branded signal with an own %s getter without invoking it', async (key) => {
    const get = vi.fn(() => { throw new Error('caller signal getter ran'); });
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, key, { get });
    const { client, fetch } = setup();
    await expect(client.compile('hello', { signal: controller.signal })).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(get).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses a non-aborted branded signal with a shadowed aborted getter', async () => {
    const get = vi.fn(() => { throw new Error('caller signal getter ran'); });
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'aborted', { get });
    const { client, fetch } = setup();
    await expect(client.compile('hello', { signal: controller.signal })).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(get).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses a branded signal whose own aborted data field hides cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, 'aborted', { value: false });
    const { client, fetch } = setup();
    await expect(client.compile('hello', { signal: controller.signal })).rejects.toBeInstanceOf(NikaConfigurationError);
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
