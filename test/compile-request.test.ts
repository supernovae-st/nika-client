import { describe, expect, it } from 'vitest';
import {
  Nika,
  NikaConfigurationError,
} from '../src/index.js';
import type { NikaCompileRequest } from '../src/index.js';

// Issue #128 · request/options validation is caller-mistake territory: it
// throws NikaConfigurationError and never reaches a transport, so these tests
// need no engine at all (the configured bin is never spawned).

function client(): Nika {
  return new Nika({ bin: '/nonexistent/nika' });
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error(`expected a refusal, compile() resolved ${JSON.stringify(promise)}`);
}

describe('compile request validation (no engine involved)', () => {
  it('accepts the bare-string shorthand as a create intent', async () => {
    // Reaches the transport (and fails there on the absent binary), proving
    // validation passed.
    const cause = await refusal(client().compile('classify-and-route'));
    expect(cause).not.toBeInstanceOf(NikaConfigurationError);
  });

  it('refuses an empty intent string', async () => {
    const cause = await refusal(client().compile(''));
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    expect((cause as Error).message).toMatch(/must not be empty/);
  });

  it('refuses a non-string non-object request without downgrading it', async () => {
    for (const bad of [42, null, undefined, ['classify-and-route'], true]) {
      const cause = await refusal(client().compile(bad as unknown as string));
      expect(cause).toBeInstanceOf(NikaConfigurationError);
      expect((cause as Error).message).toMatch(/intent string|workflow/);
    }
  });

  it('refuses an empty object: nothing would compile', async () => {
    const cause = await refusal(client().compile({} as unknown as NikaCompileRequest));
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    expect((cause as Error).message).toMatch(/neither intent nor workflow/);
  });

  it('refuses intent mixed with workflow/change instead of picking a mode', async () => {
    const cause = await refusal(client().compile({
      intent: 'x',
      workflow: 'nika: w\n',
      change: 'Set const.request to 1',
    } as unknown as NikaCompileRequest));
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    expect((cause as Error).message).toMatch(/never mixes/);
  });

  it('refuses an edit without the change or without the base source', async () => {
    const noChange = await refusal(client().compile({ workflow: 'nika: w\n' } as unknown as NikaCompileRequest));
    expect((noChange as Error).message).toMatch(/change request/);
    const noBase = await refusal(client().compile({ change: 'x' } as unknown as NikaCompileRequest));
    expect((noBase as Error).message).toMatch(/workflow source/);
  });

  it('refuses unknown request fields — dest/force are not this slice', async () => {
    const cause = await refusal(client().compile({
      intent: 'x',
      dest: 'out.nika.yaml',
    } as unknown as NikaCompileRequest));
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    expect((cause as Error).message).toMatch(/unknown request field dest/);
  });

  it('refuses a non-map answers field', async () => {
    const cause = await refusal(client().compile({
      intent: 'x',
      answers: ['const.request=1'],
    } as unknown as NikaCompileRequest));
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    expect((cause as Error).message).toMatch(/answers must be a plain object/);
  });

  it('refuses invalid timeouts before anything else', async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cause = await refusal(client().compile('classify-and-route', { timeoutMs }));
      expect(cause).toBeInstanceOf(NikaConfigurationError);
      expect((cause as Error).message).toMatch(/timeoutMs must be a positive safe integer/);
    }
  });

  it('refuses unknown options', async () => {
    const cause = await refusal(client().compile('classify-and-route', {
      timeout: 1000,
    } as unknown as { timeoutMs: number }));
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    expect((cause as Error).message).toMatch(/unknown option timeout/);
  });
});
