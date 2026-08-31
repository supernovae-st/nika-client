import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/build-native-package.mjs');
const VERSION = '0.116.0';
const SOURCE_COMMIT = 'e'.repeat(40);
const ARCHIVE_SHA = 'c'.repeat(64);
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native payload construction', () => {
  it('writes source and integrity metadata for the canonical target', () => {
    const fixture = createFixture(62);
    const result = build(fixture, `nika-linux-x64-${VERSION}.tar.gz`);

    expect(result.status).toBe(0);
    expect(readJson(path.join(fixture.packageDir, 'SOURCE.json'))).toMatchObject({
      commit: SOURCE_COMMIT,
      releaseAsset: `nika-linux-x64-${VERSION}.tar.gz`,
    });
    expect(readJson(path.join(fixture.packageDir, 'INTEGRITY.json'))).toMatchObject({
      algorithm: 'sha256',
      os: 'linux',
      cpu: 'x64',
      libc: 'glibc',
      archive: { sha256: ARCHIVE_SHA },
    });
  });

  it('refuses a release asset that does not belong to the package target', () => {
    const fixture = createFixture(62);
    const result = build(fixture, `nika-linux-arm64-${VERSION}.tar.gz`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be built from nika-linux-x64');
  });

  it('refuses a binary architecture that does not match the package target', () => {
    const fixture = createFixture(183);
    const result = build(fixture, `nika-linux-x64-${VERSION}.tar.gz`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('expected linux-x64');
  });

  it('refuses a matching 64-byte header that is not an executable image', () => {
    const fixture = createFixture(62);
    const header = Buffer.alloc(64);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    header.writeUInt16LE(62, 18);
    writeFileSync(fixture.binary, header);
    const result = build(fixture, `nika-linux-x64-${VERSION}.tar.gz`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not describe a bounded executable image');
  });
});

function createFixture(machine: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-native-build-proof-'));
  scratch.push(root);
  const packageDir = path.join(root, 'packages/native/linux-x64-gnu');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: VERSION }));
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@supernovae-st/nika-linux-x64',
    version: VERSION,
    os: ['linux'],
    cpu: ['x64'],
    libc: ['glibc'],
  }));
  const binary = path.join(root, 'nika');
  const header = Buffer.alloc(256);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(machine, 18);
  header.writeUInt32LE(1, 20);
  header.writeBigUInt64LE(128n, 24);
  header.writeBigUInt64LE(64n, 32);
  header.writeUInt16LE(64, 52);
  header.writeUInt16LE(56, 54);
  header.writeUInt16LE(1, 56);
  header.writeUInt32LE(1, 64);
  header.writeUInt32LE(5, 68);
  header.writeBigUInt64LE(0n, 72);
  header.writeBigUInt64LE(0n, 80);
  header.writeBigUInt64LE(BigInt(header.length), 96);
  header.writeBigUInt64LE(BigInt(header.length), 104);
  header.writeBigUInt64LE(4096n, 112);
  header.write(`${VERSION} (${SOURCE_COMMIT.slice(0, 9)})`, 128, 'ascii');
  writeFileSync(binary, header);
  const license = path.join(root, 'LICENSE');
  writeFileSync(license, 'AGPL fixture\n');
  return { root, packageDir, binary, license };
}

function build(
  fixture: ReturnType<typeof createFixture>,
  asset: string,
) {
  return spawnSync(process.execPath, [
    SCRIPT,
    '--package', fixture.packageDir,
    '--binary', fixture.binary,
    '--license', fixture.license,
    '--asset', asset,
    '--asset-sha256', ARCHIVE_SHA,
    '--source-commit', SOURCE_COMMIT,
  ], { cwd: fixture.root, encoding: 'utf8' });
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}
