import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { verifyEngineArchive } from '../scripts/native-release-contract.mjs';

const commit = 'a'.repeat(40);
const asset = 'nika-macos-arm64-0.118.1.tar.gz';
const tag = 'v0.118.1';

async function fixture(body) {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-artifact-proof-'));
  const archive = path.join(root, asset);
  const sums = path.join(root, 'SHA256SUMS');
  const bytes = Buffer.from('not executable: verifier tests never extract or run it');
  const hash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(archive, bytes);
  writeFileSync(sums, `${hash}  ${asset}\n`);
  const release = { tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-04T20:00:00Z',
    assets: [{ name: asset, state: 'uploaded', size: bytes.length,
      browser_download_url: `https://github.com/supernovae-st/nika/releases/download/${tag}/${asset}` }] };
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'api') return JSON.stringify(args[1].includes('/commits/') ? { sha: commit } : release);
    return '';
  };
  try { await body({ root, archive, sums, release, calls, run, hash }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('native archive proof binds bytes to the exact hosted workflow, tag and source commit', async () => {
  await fixture(async ({ archive, sums, calls, run, hash }) => {
    assert.deepEqual(await verifyEngineArchive(archive, sums, '0.118.1', commit, run),
      { tag, commit, asset, sha256: hash });
    assert.deepEqual(calls.at(-1).args, ['attestation', 'verify', archive,
      '--repo', 'supernovae-st/nika', '--cert-identity',
      `https://github.com/supernovae-st/nika/.github/workflows/release.yml@refs/tags/${tag}`,
      '--source-ref', `refs/tags/${tag}`, '--source-digest', commit,
      '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners']);
    assert(calls.every(({ command, options }) => command === 'gh' && options.timeout === 90_000));
  });
});

test.each(['draft', 'prerelease', 'unpublished', 'wrong-tag', 'duplicate', 'size', 'source'])('archive proof refuses %s metadata before attestation', async (kind) => {
  await fixture(async ({ archive, sums, release, run, calls }) => {
    if (kind === 'draft') release.draft = true;
    if (kind === 'prerelease') release.prerelease = true;
    if (kind === 'unpublished') release.published_at = null;
    if (kind === 'wrong-tag') release.tag_name = 'v0.118.0';
    if (kind === 'duplicate') release.assets.push(release.assets[0]);
    if (kind === 'size') release.assets[0].size++;
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1', kind === 'source' ? 'b'.repeat(40) : commit, run));
    assert(!calls.some(({ args }) => args[0] === 'attestation'));
  });
});

test('changed bytes, ambiguous checksums and invalid coordinates cannot reach attestation', async () => {
  await fixture(async ({ archive, sums, run, calls, hash }) => {
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1+dirty', commit, run));
    writeFileSync(sums, `${hash}  ${asset}\n${hash}  ${asset}\n`);
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1', commit, run), /exactly one/);
    writeFileSync(sums, `${'b'.repeat(64)}  ${asset}\n`);
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1', commit, run), /digest mismatch/);
    assert.equal(calls.length, 0);
  });
});

test('a failed attestation is a failed proof, never an executable fallback', async () => {
  await fixture(async ({ archive, sums, run }) => {
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1', commit, (command, args, options) => {
      if (args[0] === 'attestation') throw new Error('untrusted signer');
      return run(command, args, options);
    }), /untrusted signer/);
  });
});

test('oversized archives are refused before reading or invoking the verifier', async () => {
  await fixture(async ({ archive, sums, run, calls }) => {
    truncateSync(archive, 128 * 1024 * 1024 + 1);
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1', commit, run), /bounded regular/);
    assert.equal(calls.length, 0);
  });
});

test('a concurrent archive replacement cannot retain the earlier checksum claim', async () => {
  await fixture(async ({ archive, sums, run }) => {
    await assert.rejects(verifyEngineArchive(archive, sums, '0.118.1', commit, (command, args, options) => {
      if (args[0] === 'attestation') writeFileSync(archive, 'replacement bytes');
      return run(command, args, options);
    }), /changed during provenance verification/);
  });
});

test('both CI consumers and release packaging use the one strict archive verifier', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.equal(ci.match(/scripts\/verify-engine-archive\.mjs/g)?.length, 2);
  assert.equal(release.match(/scripts\/verify-engine-archive\.mjs/g)?.length, 1);
  assert(!`${ci}\n${release}`.includes('gh attestation verify "$asset" --repo supernovae-st/nika'));
});
