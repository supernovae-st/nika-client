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

describe('native package lock coverage', () => {
  it('locks every optional native payload for cross-platform npm ci', () => {
    const manifest = readJson('package.json') as {
      optionalDependencies: Record<string, string>;
    };
    const lock = readJson('package-lock.json') as PackageLock;

    for (const [name, version] of Object.entries(manifest.optionalDependencies)) {
      const entry = lock.packages[`node_modules/${name}`];
      expect(entry, `${name} is absent from package-lock.json`).toBeDefined();
      expect(entry).toMatchObject({ version, optional: true });
      expect(entry.os).toHaveLength(1);
      expect(entry.cpu).toHaveLength(1);

      const expectedKeys = entry.libc
        ? ['version', 'cpu', 'libc', 'license', 'optional', 'os', 'engines']
        : ['version', 'cpu', 'license', 'optional', 'os', 'engines'];
      expect(Object.keys(entry), `${name} must retain npm 11.19.1 lock order`).toEqual(
        expectedKeys,
      );
    }
  });
});

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8'));
}
