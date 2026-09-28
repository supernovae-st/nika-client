import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'nika-package-surface-'));
const consumer = path.join(scratch, 'consumer');
const packageRoot = path.join(scratch, 'package');

try {
  // Other package tests build the repository dist concurrently. Own both the
  // build output and the pack input so a competing clean cannot remove types
  // between our successful build and npm's archive read.
  await mkdir(packageRoot);
  for (const file of ['package.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'docs', 'openapi.json']) {
    await cp(path.join(root, file), path.join(packageRoot, file), { recursive: true });
  }
  run('npm', ['run', 'build', '--', '--out-dir', path.join(packageRoot, 'dist')], { cwd: root });
  const packed = JSON.parse(run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    scratch,
  ], { cwd: packageRoot }).stdout);
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename');

  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  run('npm', [
    'install',
    '--ignore-scripts',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    path.join(scratch, filename),
  ], { cwd: consumer });

  const expectedVersion = packed[0]?.version;
  if (typeof expectedVersion !== 'string') throw new Error('npm pack returned no version');
  const packageName = '@supernovae-st/nika';
  const commonJs = [
    `const sdk = require('${packageName}');`,
    `const manifest = require('${packageName}/package.json');`,
    `if (!sdk.Nika || manifest.version !== '${expectedVersion}') process.exit(1);`,
  ].join(' ');
  run(process.execPath, ['--eval', commonJs], { cwd: consumer });

  const esm = [
    `import { Nika } from '${packageName}';`,
    `const manifest = await import('${packageName}/package.json', { with: { type: 'json' } });`,
    `if (!Nika || manifest.default.version !== '${expectedVersion}') process.exit(1);`,
  ].join(' ');
  run(process.execPath, ['--input-type=module', '--eval', esm], { cwd: consumer });

  const typedConsumer = [
    `import { Nika, type NikaConfig, type NikaEngineIdentity } from '${packageName}';`,
    "const config: NikaConfig = { bin: '/tmp/nika' };",
    'const client: Nika = new Nika(config);',
    'const identity: Promise<NikaEngineIdentity> = client.serverIdentity();',
    'void identity;',
    '',
  ].join('\n');
  await writeFile(path.join(consumer, 'consumer.mts'), typedConsumer);
  await writeFile(path.join(consumer, 'consumer.cts'), typedConsumer);
  run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--strict',
    '--noEmit',
    '--types',
    'node',
    '--typeRoots',
    path.join(root, 'node_modules/@types'),
    'consumer.mts',
    'consumer.cts',
  ], { cwd: consumer });

  process.stdout.write(
    `Packed ${packageName}@${expectedVersion} exposes typed ESM, CommonJS and package metadata\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function run(command, args, options) {
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  return { stdout: result };
}
