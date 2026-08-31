import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
const sha = 'a'.repeat(40);
const version = '0.116.0';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(preparedCommit: string): { report: string; tarballs: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-pack-proof-'));
  roots.push(root);
  const packageRoot = path.join(root, 'package');
  const tarballs = path.join(root, 'tarballs');
  mkdirSync(packageRoot);
  mkdirSync(tarballs);
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@supernovae-st/nika-client',
    version,
    nikaRelease: { preparedCommit, version },
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
});
