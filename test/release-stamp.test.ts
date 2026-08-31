import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'stamp-release-commit.mjs');
const PREPARED_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const manifestPaths = [
  'package.json',
  'packages/native/darwin-arm64/package.json',
  'packages/native/darwin-x64/package.json',
  'packages/native/linux-arm64-gnu/package.json',
  'packages/native/linux-x64-gnu/package.json',
];
const scratch: string[] = [];

interface FixtureManifest {
  name: string;
  version: string;
  nikaRelease?: {
    preparedCommit: string;
    version: string;
  };
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('release commit stamping', () => {
  it('embeds the prepared commit and uniform version in all five manifests', () => {
    const fixture = createFixture('0.116.0');

    execFileSync(process.execPath, [SCRIPT, PREPARED_COMMIT, fixture]);

    for (const relativePath of manifestPaths) {
      const manifest = readManifest(fixture, relativePath);
      expect(manifest.nikaRelease).toEqual({
        preparedCommit: PREPARED_COMMIT,
        version: '0.116.0',
      });
    }
  });

  it('refuses a commit that is not exactly 40 lowercase hex characters', () => {
    const fixture = createFixture('0.116.0');
    const result = spawnSync(process.execPath, [SCRIPT, 'ABC123', fixture], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'prepared commit must be exactly 40 lowercase hexadecimal characters',
    );
    expect(readManifest(fixture, 'package.json').nikaRelease).toBeUndefined();
  });

  it('refuses version drift without partially stamping the manifests', () => {
    const fixture = createFixture('0.116.0');
    const mismatchedPath = manifestPaths.at(-1)!;
    writeManifest(fixture, mismatchedPath, {
      name: '@supernovae-st/nika-linux-x64',
      version: '0.115.0',
    });

    const result = spawnSync(process.execPath, [SCRIPT, PREPARED_COMMIT, fixture], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('version 0.115.0 differs from root 0.116.0');
    for (const relativePath of manifestPaths) {
      expect(readManifest(fixture, relativePath).nikaRelease).toBeUndefined();
    }
  });

  it('carries the prepared commit across the GitHub Actions step boundary', () => {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const packStep = workflow.split('      - name: Pack and inspect all packages\n')[1]
      ?.split('      - name: Refuse an already-started public train\n')[0];
    expect(packStep).toContain(
      'PREPARED_SHA: ${{ steps.release-metadata.outputs.prepared_sha }}',
    );
    expect(packStep).toContain('"$PREPARED_SHA"');
    expect(packStep).not.toContain('"$prepared_sha"');
  });
});

function createFixture(version: string): string {
  const fixture = mkdtempSync(path.join(tmpdir(), 'nika-release-stamp-'));
  scratch.push(fixture);
  for (const [index, relativePath] of manifestPaths.entries()) {
    writeManifest(fixture, relativePath, {
      name: index === 0 ? '@supernovae-st/nika-client' : `@supernovae-st/native-${index}`,
      version,
    });
  }
  return fixture;
}

function readManifest(root: string, relativePath: string): FixtureManifest {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeManifest(
  root: string,
  relativePath: string,
  manifest: FixtureManifest,
): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
}
