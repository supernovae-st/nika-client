import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

interface PackageEntry {
  name?: string;
  version?: string;
  optional?: boolean;
  license?: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  engines?: Record<string, string>;
  bin?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  name: string;
  version: string;
  lockfileVersion: number;
  requires: boolean;
  packages: Record<string, PackageEntry>;
}

interface RootManifest {
  name: string;
  version: string;
  license: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

interface NativeManifest {
  name: string;
  version: string;
  license: string;
  os: string[];
  cpu: string[];
  libc?: string[];
  files: string[];
  engines: Record<string, string>;
  preferUnplugged: boolean;
  publishConfig: Record<string, string>;
}

const NATIVE_FILES = ['bin/nika', 'LICENSE', 'SOURCE.json', 'INTEGRITY.json'];

const NATIVE_TARGETS = [
  { directory: 'darwin-arm64', name: '@supernovae-st/nika-darwin-arm64', os: 'darwin', cpu: 'arm64' },
  { directory: 'darwin-x64', name: '@supernovae-st/nika-darwin-x64', os: 'darwin', cpu: 'x64' },
  { directory: 'linux-arm64-gnu', name: '@supernovae-st/nika-linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  { directory: 'linux-x64-gnu', name: '@supernovae-st/nika-linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
] as const;

describe('native package lock coverage', () => {
  it('locks every optional native payload for cross-platform npm ci', () => {
    const manifest = readJson('package.json') as RootManifest;
    const lock = readJson('package-lock.json') as PackageLock;
    assertRootLock(lock, manifest);

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
      assertLockEntry(entry, target, manifest.version);
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

  it('refuses native package metadata that would omit the executable', () => {
    const target = NATIVE_TARGETS[0];
    const nativeManifest = readJson(
      `packages/native/${target.directory}/package.json`,
    ) as NativeManifest;

    expect(() => assertNativeManifest(
      { ...nativeManifest, files: nativeManifest.files.filter((file) => file !== 'bin/nika') },
      target,
      nativeManifest.version,
    )).toThrow();
  });

  it('refuses a lock target that disagrees with its native manifest', () => {
    const target = NATIVE_TARGETS[3];
    const lock = readJson('package-lock.json') as PackageLock;
    const entry = lock.packages[`node_modules/${target.name}`];

    expect(() => assertLockEntry(
      { ...entry, libc: ['musl'] },
      target,
      '0.116.2',
    )).toThrow();
  });

  it('refuses stale root identities in the lockfile', () => {
    const manifest = readJson('package.json') as RootManifest;
    const lock = readJson('package-lock.json') as PackageLock;

    expect(() => assertRootLock(
      {
        ...lock,
        version: '0.115.0',
        packages: { ...lock.packages, '': { ...lock.packages[''], version: '0.115.0' } },
      },
      manifest,
    )).toThrow();
  });
});

function assertRootLock(lock: PackageLock, manifest: RootManifest): void {
  expect(lock).toMatchObject({
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
  });
  expect(lock.packages['']).toEqual({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    bin: Object.fromEntries(
      Object.entries(manifest.bin).map(([name, executable]) => [
        name,
        executable.replace(/^\.\//, ''),
      ]),
    ),
    devDependencies: manifest.devDependencies,
    engines: manifest.engines,
    optionalDependencies: manifest.optionalDependencies,
  });
}

function assertLockEntry(
  entry: PackageEntry,
  target: typeof NATIVE_TARGETS[number],
  rootVersion: string,
): void {
  expect(entry).toMatchObject({
    version: rootVersion,
    license: 'AGPL-3.0-or-later',
    optional: true,
    os: [target.os],
    cpu: [target.cpu],
    engines: { node: '>=22' },
  });
  if ('libc' in target) {
    expect(entry.libc).toEqual([target.libc]);
  } else {
    expect(entry.libc).toBeUndefined();
  }

  const expectedKeys = entry.libc
    ? ['version', 'cpu', 'libc', 'license', 'optional', 'os', 'engines']
    : ['version', 'cpu', 'license', 'optional', 'os', 'engines'];
  expect(Object.keys(entry), `${target.name} must retain npm 11.19.1 lock order`).toEqual(
    expectedKeys,
  );
}

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
  expect(manifest.license).toBe('AGPL-3.0-or-later');
  expect(manifest.os).toEqual([target.os]);
  expect(manifest.cpu).toEqual([target.cpu]);
  if ('libc' in target) {
    expect(manifest.libc).toEqual([target.libc]);
  } else {
    expect(manifest.libc).toBeUndefined();
  }
  expect(manifest.files).toEqual(NATIVE_FILES);
  expect(manifest.engines).toEqual({ node: '>=22' });
  expect(manifest.preferUnplugged).toBe(true);
  expect(manifest.publishConfig).toEqual({ access: 'public' });
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}
