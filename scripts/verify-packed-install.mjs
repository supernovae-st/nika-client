import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isCommit, nativeTarget } from './native-release-contract.mjs';

const [
  clientTarballArg,
  nativeTarballArg,
  expectedVersion,
  preparedCommit,
  nativePackageName,
] = process.argv.slice(2);
if (
  !clientTarballArg
  || !nativeTarballArg
  || !expectedVersion
  || !preparedCommit
  || !nativePackageName
) {
  throw new Error(
    'Usage: verify-packed-install.mjs <client.tgz> <host-native.tgz> '
      + '<version> <prepared-commit> <native-package>',
  );
}
if (!/^0\.\d+\.\d+$/.test(expectedVersion)) throw new Error('version must be 0.x.y');
if (!isCommit(preparedCommit)) throw new Error('prepared commit must be 40 lowercase hex');
const nativeTargetContract = nativeTarget(nativePackageName, expectedVersion);
if (
  nativeTargetContract.os !== process.platform
  || nativeTargetContract.cpu !== process.arch
) {
  throw new Error(
    `${nativePackageName} targets ${nativeTargetContract.os}-${nativeTargetContract.cpu}, `
      + `but this runner is ${process.platform}-${process.arch}`,
  );
}

const clientTarball = path.resolve(clientTarballArg);
const nativeTarball = path.resolve(nativeTarballArg);
const project = await mkdtemp(path.join(tmpdir(), 'nika-packed-consumer-'));

try {
  await writeFile(path.join(project, 'package.json'), '{"private":true,"type":"module"}\n');
  run('npm', [
    'install',
    '--ignore-scripts',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    clientTarball,
    nativeTarball,
  ]);

  const clientManifest = await readJson(
    path.join(project, 'node_modules/@supernovae-st/nika-client/package.json'),
  );
  const nativeManifest = await readJson(
    path.join(project, 'node_modules', ...nativePackageName.split('/'), 'package.json'),
  );
  for (const manifest of [clientManifest, nativeManifest]) {
    if (
      manifest.version !== expectedVersion
      || manifest.nikaRelease?.version !== expectedVersion
      || manifest.nikaRelease?.preparedCommit !== preparedCommit
    ) {
      throw new Error(`${String(manifest.name)} install is not bound to ${preparedCommit}`);
    }
  }

  await writeFile(path.join(project, 'packed-release-smoke.nika.yaml'), [
    'nika: packed-release-smoke',
    'model: mock/echo',
    'tasks:',
    '  prove:',
    '    infer:',
    '      prompt: "verify the freshly packed native engine"',
    '',
  ].join('\n'));
  run(process.execPath, ['--input-type=module', '--eval', [
    "import { Nika } from '@supernovae-st/nika-client';",
    'const nika = new Nika({ cwd: process.cwd() });',
    "if (nika.transportKind !== 'native-process') process.exit(1);",
    "const report = await nika.check('packed-release-smoke.nika.yaml');",
    'if (report.clean !== true || report.exitCode !== 0) process.exit(2);',
  ].join(' ')], { cwd: project });

  const cli = path.join(project, 'node_modules/.bin/nika');
  const identityResult = run(cli, ['--sdk-identity'], { cwd: project });
  let identity;
  try {
    identity = JSON.parse(identityResult.stdout.trim());
  } catch (cause) {
    throw new Error(`packed CLI identity is not JSON: ${cause instanceof Error ? cause.message : cause}`);
  }
  if (identity.engineVersion !== expectedVersion) {
    throw new Error(
      `packed engine identity is ${String(identity.engineVersion)}, expected ${expectedVersion}`,
    );
  }

  const versionResult = run(cli, ['--version'], { cwd: project });
  if (!new RegExp(`^nika\\s+${escapeRegex(expectedVersion)}(?:\\s|$)`).test(versionResult.stdout)) {
    throw new Error(`packed CLI --version did not identify nika ${expectedVersion}`);
  }
  console.log(
    `Installed and executed packed SDK + ${nativePackageName} ${expectedVersion} at ${preparedCommit}`,
  );
} finally {
  await rm(project, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const env = { ...process.env };
  delete env.NIKA_BIN;
  const result = spawnSync(command, args, {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result;
}

async function readJson(file) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file} does not contain an object`);
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
