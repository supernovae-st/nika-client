import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
const sha = 'a'.repeat(40);
const engineSha = 'e'.repeat(40);
const version = '0.116.0';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  preparedCommit: string,
  manifestOverrides: Record<string, unknown> = {},
): { report: string; tarballs: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-pack-proof-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  const tarballs = path.join(root, 'tarballs');
  mkdirSync(packageRoot);
  mkdirSync(tarballs);
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@supernovae-st/nika-client',
    version,
    type: 'module',
    exports: {
      '.': {
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      },
      './package.json': './package.json',
    },
    main: './dist/index.cjs',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    bin: { nika: './dist/bin/nika.js' },
    nikaRelease: { preparedCommit, version },
    ...manifestOverrides,
  }));
  const filename = 'supernovae-st-nika-client-0.116.0.tgz';
  execFileSync('tar', ['-czf', path.join(tarballs, filename), '-C', root, 'package']);
  const report = path.join(root, 'pack.json');
  writeFileSync(report, JSON.stringify([{
    name: '@supernovae-st/nika-client',
    version,
    filename,
    files: [
      { path: 'package.json', mode: 0o644 },
      { path: 'dist/index.js', mode: 0o644 },
      { path: 'dist/index.cjs', mode: 0o644 },
      { path: 'dist/index.d.ts', mode: 0o644 },
      { path: 'dist/index.d.cts', mode: 0o644 },
      { path: 'dist/bin/nika.js', mode: 0o755 },
      { path: 'LICENSE', mode: 0o644 },
    ],
  }]));
  return { report, tarballs };
}

describe('packed release commit proof', () => {
  it('accepts the stamped manifest inside the actual tarball', () => {
    const packed = fixture(sha);
    expect(() => execFileSync('node', [
      path.join(repo, 'scripts/verify-client-pack.mjs'),
      packed.report,
      packed.tarballs,
      sha,
      version,
    ])).not.toThrow();
  });

  it('accepts the repository manifest entrypoints as canonical', () => {
    // The release gate runs only at tag time. Binding it to the checked-in
    // manifest here keeps a manifest edit from turning the train red later.
    const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
      exports: unknown; main: string; module: string; types: string; bin: unknown;
    };
    const packed = fixture(sha, {
      exports: manifest.exports,
      main: manifest.main,
      module: manifest.module,
      types: manifest.types,
      bin: manifest.bin,
    });
    expect(() => execFileSync('node', [
      path.join(repo, 'scripts/verify-client-pack.mjs'),
      packed.report,
      packed.tarballs,
      sha,
      version,
    ])).not.toThrow();
  });

  it('refuses a tarball that drops the package.json export', () => {
    const packed = fixture(sha, {
      exports: {
        '.': {
          import: { types: './dist/index.d.ts', default: './dist/index.js' },
          require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
        },
      },
    });
    const result = spawnSync('node', [
      path.join(repo, 'scripts/verify-client-pack.mjs'),
      packed.report,
      packed.tarballs,
      sha,
      version,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('manifest entrypoints are not canonical');
  });

  it('refuses a tarball stamped for another commit', () => {
    const packed = fixture('b'.repeat(40));
    const result = spawnSync('node', [
      path.join(repo, 'scripts/verify-client-pack.mjs'),
      packed.report,
      packed.tarballs,
      sha,
      version,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('packed release metadata');
  });

  it('refuses a tarball whose installed CLI points away from the shim', () => {
    const packed = fixture(sha, { bin: { nika: './dist/index.js' } });
    const result = spawnSync('node', [
      path.join(repo, 'scripts/verify-client-pack.mjs'),
      packed.report,
      packed.tarballs,
      sha,
      version,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('manifest entrypoints are not canonical');
  });
});

describe('packed native release proof', () => {
  it('binds the package, source, release checksum, executable checksum, and architecture', () => {
    const packed = nativeFixture();
    expect(() => verifyNative(packed)).not.toThrow();
  });

  it('refuses executable bytes changed after INTEGRITY.json was written', () => {
    const packed = nativeFixture({ executableSha: 'f'.repeat(64) });
    const result = verifyNativeResult(packed);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('executable checksum does not match');
  });

  it('refuses SOURCE.json bound to another engine commit', () => {
    const packed = nativeFixture({ sourceCommit: 'b'.repeat(40) });
    const result = verifyNativeResult(packed);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('SOURCE.json commit');
  });

  it('refuses archive metadata that differs from release SHA256SUMS', () => {
    const packed = nativeFixture({ integrityArchiveSha: 'd'.repeat(64) });
    const result = verifyNativeResult(packed);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('archive does not match SHA256SUMS');
  });

  it('refuses an ARM64 executable inside the Linux x64 package', () => {
    const packed = nativeFixture({ elfMachine: 183 });
    const result = verifyNativeResult(packed);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('expected linux-x64');
  });

  it('refuses a previous-version executable with the correct architecture', () => {
    const packed = nativeFixture({ identityVersion: '0.115.0' });
    const result = verifyNativeResult(packed);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('expected exactly 0.116.0');
  });

  it('refuses a stale executable with the expected identity appended as an overlay', () => {
    const packed = nativeFixture({
      identityVersion: '0.115.0',
      appendedIdentity: `0.116.0 (${engineSha.slice(0, 9)})`,
    });
    const result = verifyNativeResult(packed);

    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain('expected exactly 0.116.0');
  });
});

interface NativeFixtureOptions {
  executableSha?: string;
  sourceCommit?: string;
  integrityArchiveSha?: string;
  elfMachine?: number;
  identityVersion?: string;
  appendedIdentity?: string;
}

function nativeFixture(options: NativeFixtureOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-native-pack-proof-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  const tarballs = path.join(root, 'tarballs');
  const binDirectory = path.join(packageRoot, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(tarballs);

  const packageName = '@supernovae-st/nika-linux-x64';
  const asset = `nika-linux-x64-${version}.tar.gz`;
  const archiveSha = 'c'.repeat(64);
  const baseBinary = elf64(options.elfMachine ?? 62, options.identityVersion ?? version);
  const binary = options.appendedIdentity
    ? Buffer.concat([baseBinary, Buffer.from(options.appendedIdentity, 'ascii')])
    : baseBinary;
  const executableSha = createHash('sha256').update(binary).digest('hex');
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    os: ['linux'],
    cpu: ['x64'],
    libc: ['glibc'],
    nikaRelease: { preparedCommit: sha, version },
  }));
  const executable = path.join(binDirectory, 'nika');
  writeFileSync(executable, binary);
  chmodSync(executable, 0o755);
  writeFileSync(path.join(packageRoot, 'LICENSE'), 'AGPL fixture\n');
  writeFileSync(path.join(packageRoot, 'SOURCE.json'), JSON.stringify({
    repository: 'https://github.com/supernovae-st/nika',
    tag: `v${version}`,
    commit: options.sourceCommit ?? engineSha,
    releaseAsset: asset,
    sourceArchive: `https://github.com/supernovae-st/nika/archive/refs/tags/v${version}.tar.gz`,
  }));
  writeFileSync(path.join(packageRoot, 'INTEGRITY.json'), JSON.stringify({
    algorithm: 'sha256',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
    archive: { file: asset, sha256: options.integrityArchiveSha ?? archiveSha },
    executable: { file: 'bin/nika', sha256: options.executableSha ?? executableSha },
  }));

  const filename = 'supernovae-st-nika-linux-x64-0.116.0.tgz';
  execFileSync('tar', ['-czf', path.join(tarballs, filename), '-C', root, 'package']);
  const report = path.join(root, 'pack.json');
  writeFileSync(report, JSON.stringify([{
    name: packageName,
    version,
    filename,
    files: [
      { path: 'package.json', mode: 0o644 },
      { path: 'bin/nika', mode: 0o755 },
      { path: 'LICENSE', mode: 0o644 },
      { path: 'SOURCE.json', mode: 0o644 },
      { path: 'INTEGRITY.json', mode: 0o644 },
    ],
  }]));
  const checksums = path.join(root, 'SHA256SUMS');
  writeFileSync(checksums, `${archiveSha}  ${asset}\n`);
  return { report, tarballs, checksums };
}

function verifyNative(packed: ReturnType<typeof nativeFixture>): void {
  execFileSync(process.execPath, nativeArgs(packed));
}

function verifyNativeResult(packed: ReturnType<typeof nativeFixture>) {
  return spawnSync(process.execPath, nativeArgs(packed));
}

function nativeArgs(packed: ReturnType<typeof nativeFixture>): string[] {
  return [
    path.join(repo, 'scripts/verify-native-pack.mjs'),
    packed.report,
    packed.tarballs,
    sha,
    version,
    engineSha,
    packed.checksums,
  ];
}

function elf64(machine: number, identityVersion: string): Buffer {
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
  header.write(`${identityVersion} (${engineSha.slice(0, 9)})`, 128, 'ascii');
  return header;
}
