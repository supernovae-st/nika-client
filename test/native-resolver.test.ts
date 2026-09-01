import { describe, expect, it } from 'vitest';
import { NikaConfigurationError } from '../src/errors.js';
import { NikaEngineUnavailable, resolveNikaBinary } from '../src/lib/binary/index.js';

describe('native binary resolver', () => {
  it('prefers config.bin, then NIKA_BIN, then the exact host package', () => {
    const resolvePackageJson = (specifier: string) => `/payload/${specifier}`;
    expect(resolveNikaBinary('/configured/nika', {
      env: { NIKA_BIN: '/environment/nika' },
      platform: 'linux',
      arch: 'x64',
      glibc: true,
      resolvePackageJson,
    })).toBe('/configured/nika');
    expect(resolveNikaBinary(undefined, {
      env: { NIKA_BIN: '/environment/nika' },
      platform: 'linux',
      arch: 'x64',
      glibc: true,
      resolvePackageJson,
    })).toBe('/environment/nika');
    expect(resolveNikaBinary(undefined, {
      env: {},
      platform: 'linux',
      arch: 'x64',
      glibc: true,
      resolvePackageJson,
    })).toBe('/payload/@supernovae-st/nika-linux-x64/bin/nika');
  });

  it('rejects empty explicit values instead of falling through', () => {
    expect(() => resolveNikaBinary('', { env: {} })).toThrow(NikaConfigurationError);
    expect(() => resolveNikaBinary(undefined, { env: { NIKA_BIN: '' } }))
      .toThrow(NikaConfigurationError);
  });

  it('refuses a bare name or a relative path, which the OS would resolve through PATH or cwd', () => {
    // A bare `nika` in NIKA_BIN used to reach spawn(), where the operating
    // system walked PATH for it: the implicit lookup the README refuses.
    for (const value of ['nika', './nika', 'bin/nika', '../nika']) {
      expect(() => resolveNikaBinary(value, { env: {} })).toThrow(NikaConfigurationError);
      expect(() => resolveNikaBinary(undefined, { env: { NIKA_BIN: value } }))
        .toThrow(NikaConfigurationError);
    }
    let caught: unknown;
    try {
      resolveNikaBinary(undefined, { env: { NIKA_BIN: 'nika' } });
    } catch (error) {
      caught = error;
    }
    const message = String((caught as Error).message);
    expect(message).toContain('NIKA_BIN must be an absolute path');
    expect(message).toContain('"nika"');
    expect(message).toContain('PATH');
    expect(resolveNikaBinary('/absolute/nika', { env: {} })).toBe('/absolute/nika');
  });

  it('uses the stable unavailable error for unsupported and missing payloads', () => {
    expect(() => resolveNikaBinary(undefined, {
      env: {},
      platform: 'linux',
      arch: 'x64',
      glibc: false,
    })).toThrow(NikaEngineUnavailable);
    let caught: unknown;
    try {
      resolveNikaBinary(undefined, {
        env: {},
        platform: 'darwin',
        arch: 'arm64',
        glibc: true,
        resolvePackageJson: () => {
          const error = new Error('missing') as NodeJS.ErrnoException;
          error.code = 'MODULE_NOT_FOUND';
          throw error;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'NikaEngineUnavailable',
      code: 'NIKA_ENGINE_UNAVAILABLE',
      packageName: '@supernovae-st/nika-darwin-arm64',
    });
    // The refusal teaches every valid path and names the one it will not take.
    const message = String((caught as Error).message);
    expect(message).toContain('NIKA_BIN=/absolute/path/to/nika');
    expect(message).toContain('config.bin');
    expect(message).toContain('payload package');
    expect(message).toContain('PATH is deliberately not used');
    expect(message).toContain('UNMET OPTIONAL');
  });
});
