import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
for (const required of ['package', 'binary', 'license', 'asset', 'asset-sha256', 'source-commit']) {
  if (!args[required]) throw new Error(`Missing --${required}`);
}

const packageDir = path.resolve(args.package);
const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
if (manifest.version !== rootManifest.version) {
  throw new Error(`${manifest.name} version ${manifest.version} != root ${rootManifest.version}`);
}

const metadata = {
  os: one(manifest.os, 'os'),
  cpu: one(manifest.cpu, 'cpu'),
  libc: manifest.libc ? one(manifest.libc, 'libc') : null,
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
  executable: { file: 'bin/nika', sha256: await sha256(outputBin) },
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

function one(value, field) {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') {
    throw new Error(`${manifest.name} must declare one ${field} value`);
  }
  return value[0];
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
