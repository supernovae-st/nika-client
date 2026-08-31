import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const rootPackagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const nativePackages = [
  ['@supernovae-st/nika-darwin-arm64', 'packages/native/darwin-arm64/package.json'],
  ['@supernovae-st/nika-darwin-x64', 'packages/native/darwin-x64/package.json'],
  ['@supernovae-st/nika-linux-arm64', 'packages/native/linux-arm64-gnu/package.json'],
  ['@supernovae-st/nika-linux-x64', 'packages/native/linux-x64-gnu/package.json'],
];

const rootPackage = await readJson(rootPackagePath);
const { version } = rootPackage;
if (typeof version !== 'string' || !/^0\.\d+\.\d+$/.test(version)) {
  throw new Error(`Root package version must be 0.x.y, received ${String(version)}`);
}

rootPackage.optionalDependencies = Object.fromEntries(
  nativePackages.map(([name]) => [name, version]),
);
await writeJson(rootPackagePath, rootPackage);

const lockEntries = [];
for (const [expectedName, relativePath] of nativePackages) {
  const manifestPath = path.join(root, relativePath);
  const manifest = await readJson(manifestPath);
  if (manifest.name !== expectedName) {
    throw new Error(`${relativePath} must be named ${expectedName}`);
  }
  manifest.version = version;
  await writeJson(manifestPath, manifest);
  lockEntries.push([expectedName, manifest]);
}

const lock = await readJson(lockPath);
lock.version = version;
lock.packages[''].version = version;
lock.packages[''].optionalDependencies = rootPackage.optionalDependencies;
for (const [name, manifest] of lockEntries) {
  // Match npm@11.19.1's package-lock serialization so release validation is idempotent.
  lock.packages[`node_modules/${name}`] = {
    version,
    cpu: manifest.cpu,
    ...(manifest.libc ? { libc: manifest.libc } : {}),
    license: manifest.license,
    optional: true,
    os: manifest.os,
    engines: manifest.engines,
  };
}
await writeJson(lockPath, lock);

console.log(`Synchronized all native payload references to ${version}`);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
