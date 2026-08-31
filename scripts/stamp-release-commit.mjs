import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const manifestPaths = [
  'package.json',
  'packages/native/darwin-arm64/package.json',
  'packages/native/darwin-x64/package.json',
  'packages/native/linux-arm64-gnu/package.json',
  'packages/native/linux-x64-gnu/package.json',
];

const preparedCommit = process.argv[2];
const root = path.resolve(process.argv[3] ?? process.cwd());

if (!/^[0-9a-f]{40}$/.test(preparedCommit ?? '')) {
  throw new Error('prepared commit must be exactly 40 lowercase hexadecimal characters');
}

const manifests = manifestPaths.map((relativePath) => {
  const absolutePath = path.join(root, relativePath);
  const manifest = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${relativePath} must declare a non-empty version`);
  }
  return { absolutePath, manifest, relativePath };
});

const releaseVersion = manifests[0].manifest.version;
const mismatched = manifests.find(({ manifest }) => manifest.version !== releaseVersion);
if (mismatched) {
  throw new Error(
    `${mismatched.relativePath} version ${mismatched.manifest.version} differs from root ${releaseVersion}`,
  );
}

for (const { absolutePath, manifest } of manifests) {
  manifest.nikaRelease = {
    preparedCommit,
    version: releaseVersion,
  };
  writeFileSync(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`Stamped ${manifests.length} manifests for ${releaseVersion} at ${preparedCommit}`);
