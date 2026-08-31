import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

interface PackageLock {
  packages: Record<string, {
    version?: string;
    optional?: boolean;
    license?: string;
    os?: string[];
    cpu?: string[];
    libc?: string[];
    engines?: Record<string, string>;
  }>;
}

interface NativeManifest {
  name: string;
  version: string;
  os: string[];
  cpu: string[];
  libc?: string[];
}

const NATIVE_TARGETS = [
  { directory: 'darwin-arm64', name: '@supernovae-st/nika-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { directory: 'darwin-x64', name: '@supernovae-st/nika-darwin-x64', os: 'darwin', cpu: 'x64' },
  { directory: 'linux-arm64-gnu', name: '@supernovae-st/nika-linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { directory: 'linux-x64-gnu', name: '@supernovae-st/nika-linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
] as const;

describe('native package lock coverage', () => {
  it('locks every optional native payload for cross-platform npm ci', () => {
    const manifest = readJson('package.json') as {
      version: string;
      optionalDependencies: Record<string, string>;
    };
    const lock = readJson('package-lock.json') as PackageLock;

    expect(Object.keys(manifest.optionalDependencies).sort()).toEqual(
      NATIVE_TARGETS.map((target) => target.name).sort(),
    );
    for (const target of NATIVE_TARGETS) {
      const nativeManifest = readJson(
        `packages/native/${target.directory}/package.json`,
      ) as NativeManifest;
      assertNativeManifest(nativeManifest, target, manifest.version);
      expect(manifest.optionalDependencies[target.name]).toBe(manifest.version);

      const entry = lock.packages[`node_modules/${target.name}`];
      expect(entry, `${target.name} is absent from package-lock.json`).toBeDefined();
      expect(entry).toMatchObject({ version: manifest.version, optional: true });
      expect(entry.os).toHaveLength(1);
      expect(entry.cpu).toHaveLength(1);

      const expectedKeys = entry.libc
        ? ['version', 'cpu', 'libc', 'license', 'optional', 'os', 'engines']
        : ['version', 'cpu', 'license', 'optional', 'os', 'engines'];
      expect(Object.keys(entry), `${target.name} must retain npm 11.19.1 lock order`).toEqual(
        expectedKeys,
      );
    }
  });

  it('refuses a real native manifest with a stale root version', () => {
    const target = NATIVE_TARGETS[0];
    const nativeManifest = readJson(
      `packages/native/${target.directory}/package.json`,
    ) as NativeManifest;

    expect(() => assertNativeManifest(
      { ...nativeManifest, version: '0.115.0' },
      target,
      '0.116.2',
    )).toThrow('native manifest version 0.115.0 does not match root 0.116.2');
  });
});

function assertNativeManifest(
  manifest: NativeManifest,
  target: typeof NATIVE_TARGETS[number],
  rootVersion: string,
): void {
  if (manifest.version !== rootVersion) {
    throw new Error(
      `native manifest version ${manifest.version} does not match root ${rootVersion}`,
    );
  }
  expect(manifest.name).toBe(target.name);
  expect(manifest.os).toEqual([target.os]);
  expect(manifest.cpu).toEqual([target.cpu]);
  if ('libc' in target) {
    expect(manifest.libc).toEqual([target.libc]);
  } else {
    expect(manifest.libc).toBeUndefined();
  }
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}
