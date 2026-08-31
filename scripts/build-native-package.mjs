import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertExecutableIdentity,
  assertExecutableTarget,
  assertNativeManifest,
  isCommit,
  isSha256,
  sha256File,
} from './native-release-contract.mjs';

const args = parseArgs(process.argv.slice(2));
for (const required of ['package', 'binary', 'license', 'asset', 'asset-sha256', 'source-commit']) {
  if (!args[required]) throw new Error(`Missing --${required}`);
}

const packageDir = path.resolve(args.package);
const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
const target = assertNativeManifest(manifest, rootManifest.version);
if (args.asset !== target.asset) {
  throw new Error(`${manifest.name} must be built from ${target.asset}, got ${args.asset}`);
}
if (!isSha256(args['asset-sha256'])) {
  throw new Error('--asset-sha256 must be exactly 64 lowercase hexadecimal characters');
}
if (!isCommit(args['source-commit'])) {
  throw new Error('--source-commit must be exactly 40 lowercase hexadecimal characters');
}
await assertExecutableTarget(path.resolve(args.binary), target);
await assertExecutableIdentity(path.resolve(args.binary), rootManifest.version, args['source-commit']);

const metadata = {
  os: target.os,
  cpu: target.cpu,
  libc: target.libc,
};
const binDir = path.join(packageDir, 'bin');
const outputBin = path.join(binDir, 'nika');
await rm(binDir, { recursive: true, force: true });
await mkdir(binDir, { recursive: true });
await copyFile(path.resolve(args.binary), outputBin);
await chmod(outputBin, 0o755);
await copyFile(path.resolve(args.license), path.join(packageDir, 'LICENSE'));

const source = {
  repository: 'https://github.com/supernovae-st/nika',
  tag: `v${rootManifest.version}`,
  commit: args['source-commit'],
  releaseAsset: args.asset,
  sourceArchive: `https://github.com/supernovae-st/nika/archive/refs/tags/v${rootManifest.version}.tar.gz`,
};
const integrity = {
  algorithm: 'sha256',
  ...metadata,
  archive: { file: args.asset, sha256: args['asset-sha256'] },
  executable: { file: 'bin/nika', sha256: await sha256File(outputBin) },
};
await writeJson(path.join(packageDir, 'SOURCE.json'), source);
await writeJson(path.join(packageDir, 'INTEGRITY.json'), integrity);
console.log(`Prepared ${manifest.name}@${manifest.version} from ${args.asset}`);

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!flag?.startsWith('--') || values[index + 1] === undefined) {
      throw new Error(`Invalid argument near ${String(flag)}`);
    }
    result[flag.slice(2)] = values[index + 1];
  }
  return result;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
