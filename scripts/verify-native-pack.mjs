import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertExecutableIdentity,
  assertExecutableTarget,
  assertNativeManifest,
  checksumForAsset,
  isCommit,
  isSha256,
  sha256File,
} from './native-release-contract.mjs';

const [
  packJsonPath,
  tarballDirectory,
  preparedCommit,
  expectedVersion,
  engineCommit,
  checksumsPath,
] = process.argv.slice(2);
if (
  !packJsonPath
  || !tarballDirectory
  || !preparedCommit
  || !expectedVersion
  || !engineCommit
  || !checksumsPath
) {
  throw new Error(
    'Usage: verify-native-pack.mjs <npm-pack-json> <tarball-directory> '
      + '<prepared-commit> <version> <engine-commit> <SHA256SUMS>',
  );
}
if (!isCommit(preparedCommit)) throw new Error('prepared commit must be 40 lowercase hex');
if (!isCommit(engineCommit)) throw new Error('engine commit must be 40 lowercase hex');

const result = JSON.parse(await readFile(packJsonPath, 'utf8'))[0];
if (!result) throw new Error(`No npm pack result in ${packJsonPath}`);
const tarball = path.join(tarballDirectory, result.filename);
const extractionRoot = await mkdtemp(path.join(tmpdir(), 'nika-native-pack-proof-'));

try {
  execFileSync('tar', ['-xzf', tarball, '-C', extractionRoot]);
  const packageRoot = path.join(extractionRoot, 'package');
  const required = ['package.json', 'bin/nika', 'LICENSE', 'SOURCE.json', 'INTEGRITY.json'];
  const reportedFiles = new Map(result.files.map((entry) => [entry.path, entry]));
  for (const file of required) {
    if (!reportedFiles.has(file)) throw new Error(`${result.name} pack report is missing ${file}`);
    const metadata = await stat(path.join(packageRoot, file)).catch(() => undefined);
    if (!metadata?.isFile()) throw new Error(`${result.name} tarball is missing ${file}`);
  }
  if ((reportedFiles.get('bin/nika').mode & 0o111) === 0) {
    throw new Error(`${result.name} bin/nika is not executable in the pack report`);
  }
  const executable = path.join(packageRoot, 'bin', 'nika');
  if (((await stat(executable)).mode & 0o111) === 0) {
    throw new Error(`${result.name} bin/nika is not executable in the tarball`);
  }

  const manifest = await readJson(path.join(packageRoot, 'package.json'), 'package.json');
  const target = assertNativeManifest(manifest, expectedVersion);
  if (result.name !== manifest.name || result.version !== expectedVersion) {
    throw new Error(`npm pack report does not describe ${manifest.name}@${expectedVersion}`);
  }
  if (
    manifest.nikaRelease?.version !== expectedVersion
    || manifest.nikaRelease?.preparedCommit !== preparedCommit
  ) {
    throw new Error(`${result.name} packed release metadata does not bind ${preparedCommit}`);
  }

  const source = await readJson(path.join(packageRoot, 'SOURCE.json'), 'SOURCE.json');
  assertExactKeys(source, ['repository', 'tag', 'commit', 'releaseAsset', 'sourceArchive'], 'SOURCE.json');
  const expectedSource = {
    repository: 'https://github.com/supernovae-st/nika',
    tag: `v${expectedVersion}`,
    commit: engineCommit,
    releaseAsset: target.asset,
    sourceArchive: `https://github.com/supernovae-st/nika/archive/refs/tags/v${expectedVersion}.tar.gz`,
  };
  for (const [key, expected] of Object.entries(expectedSource)) {
    if (source[key] !== expected) {
      throw new Error(`SOURCE.json ${key} is ${String(source[key])}, expected ${expected}`);
    }
  }

  const integrity = await readJson(path.join(packageRoot, 'INTEGRITY.json'), 'INTEGRITY.json');
  assertExactKeys(
    integrity,
    ['algorithm', 'os', 'cpu', 'libc', 'archive', 'executable'],
    'INTEGRITY.json',
  );
  if (
    integrity.algorithm !== 'sha256'
    || integrity.os !== target.os
    || integrity.cpu !== target.cpu
    || integrity.libc !== target.libc
  ) {
    throw new Error(`INTEGRITY.json target does not bind ${target.os}-${target.cpu}`);
  }
  const archive = record(integrity.archive, 'INTEGRITY.json archive');
  assertExactKeys(archive, ['file', 'sha256'], 'INTEGRITY.json archive');
  const expectedArchiveSha = checksumForAsset(
    await readFile(checksumsPath, 'utf8'),
    target.asset,
  );
  if (
    archive.file !== target.asset
    || archive.sha256 !== expectedArchiveSha
    || !isSha256(archive.sha256)
  ) {
    throw new Error(`INTEGRITY.json archive does not match SHA256SUMS for ${target.asset}`);
  }

  const executableIntegrity = record(integrity.executable, 'INTEGRITY.json executable');
  assertExactKeys(executableIntegrity, ['file', 'sha256'], 'INTEGRITY.json executable');
  const executableSha = await sha256File(executable);
  if (
    executableIntegrity.file !== 'bin/nika'
    || executableIntegrity.sha256 !== executableSha
    || !isSha256(executableIntegrity.sha256)
  ) {
    throw new Error('INTEGRITY.json executable checksum does not match packed bin/nika');
  }
  const detected = await assertExecutableTarget(executable, target);
  await assertExecutableIdentity(executable, expectedVersion, engineCommit);
  console.log(
    `Verified ${result.name}@${result.version}: ${detected.format} ${target.os}-${target.cpu}, `
      + 'source and checksums bound',
  );
} finally {
  await rm(extractionRoot, { recursive: true, force: true });
}

async function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (cause) {
    throw new Error(`Cannot parse ${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return record(value, label);
}

function record(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    throw new Error(`${label} keys are ${actual.join(', ')}, expected ${canonical.join(', ')}`);
  }
}
