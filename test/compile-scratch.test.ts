import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { Nika, NikaTransportError } from '../src/index.js';

const fault = vi.hoisted(() => ({ code: 'EIO', scratch: '' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const directory = await actual.mkdtemp(...args);
      fault.scratch = String(directory);
      return directory;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      // Exercise cleanup of a real partial file, not just a mocked directory.
      await actual.writeFile(args[0], 'partial source', args[2]);
      throw Object.assign(new Error('injected write failure'), { code: fault.code });
    },
  };
});

afterEach(() => { vi.clearAllMocks(); });
it.each(['EIO', 'ENOSPC'])('cleans partial EDIT scratch on %s before any child exists', async (code) => {
  fault.code = code;
  const client = new Nika({ bin: fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url)) });
  const error = await client.compile({ workflow: 'nika: base\n', change: 'Set const.x to 1' }).catch((e) => e);
  expect(error).toBeInstanceOf(NikaTransportError);
  expect(error.cause.code).toBe(code);
  expect(fault.scratch).toContain('nika-sdk-compile-');
  expect(existsSync(fault.scratch)).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});
