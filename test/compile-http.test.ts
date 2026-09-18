import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError } from '../src/index.js';
import { healthResponse, TOKEN_A } from './helpers/http-depth-harness.js';

// Issue #128 · HTTP compile is a typed refusal until nika serve grows its
// authoring door (engine nika#1670). The refusal happens after the identity
// probe alone; nothing is POSTed, and the SDK never spins up a local compile
// as a substitute for the connected engine.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPILE_ENGINE = path.join(HERE, 'fixtures', 'fake-nika-compile.mjs');
const scratch: string[] = [];

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error('expected a refusal');
}

describe('compile over HTTP (no door yet)', () => {
  afterEach(() => {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    for (const file of scratch.splice(0)) rmSync(file, { force: true });
  });

  it('typed-refuses after /health alone, posting nothing and spawning nothing', async () => {
    const fetch = vi.fn().mockResolvedValue(healthResponse());
    const argvLog = path.join(tmpdir(), `nika-sdk-compile-http-${process.pid}.log`);
    scratch.push(argvLog);
    process.env.NIKA_FAKE_ARGV_LOG = argvLog;
    const nika = new Nika({
      url: 'https://nika.example',
      token: TOKEN_A,
      // A compile-capable LOCAL engine on purpose: the refusal must not use it.
      bin: COMPILE_ENGINE,
      fetch: fetch as typeof globalThis.fetch,
    });
    const cause = await failure(nika.compile('classify-and-route'));
    expect(cause).toBeInstanceOf(NikaCompatibilityError);
    expect(cause).toMatchObject({ capability: 'compile', transport: 'http' });
    expect((cause as Error).message).toMatch(/nika#1670/);
    expect((cause as Error).message).toMatch(/never compiles locally/);
    // Exactly one request — the identity probe — and no local process at all.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/health$/);
    expect(existsSync(argvLog)).toBe(false);
  });

  it('refuses EDIT the same way, without touching the local engine', async () => {
    const fetch = vi.fn().mockResolvedValue(healthResponse({
      supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'compile'],
    }));
    const nika = new Nika({
      url: 'https://nika.example',
      token: TOKEN_A,
      bin: COMPILE_ENGINE,
      fetch: fetch as typeof globalThis.fetch,
    });
    // Even a serve that advertised a future compile token gets no consumer in
    // this slice: the accepted Serve wire lands with engine nika#1670.
    const cause = await failure(nika.compile({ workflow: 'nika: w\n', change: 'x' }));
    expect(cause).toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
