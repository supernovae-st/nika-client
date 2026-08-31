import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [packJsonPath, tarballDirectory, preparedCommit, expectedVersion] = process.argv.slice(2);
if (!packJsonPath || !tarballDirectory || !preparedCommit || !expectedVersion) {
  throw new Error(
    'Usage: verify-client-pack.mjs <npm-pack-json> <tarball-directory> <prepared-commit> <version>',
  );
}

const result = JSON.parse(await readFile(packJsonPath, 'utf8'))[0];
if (!result) throw new Error(`No npm pack result in ${packJsonPath}`);

const required = [
  'package.json',
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.d.cts',
  'dist/bin/nika.js',
  'LICENSE',
];
const files = new Map(result.files.map((entry) => [entry.path, entry]));
for (const file of required) {
  if (!files.has(file)) throw new Error(`${result.name} pack is missing ${file}`);
}
if ((files.get('dist/bin/nika.js').mode & 0o111) === 0) {
  throw new Error(`${result.name} dist/bin/nika.js is not executable`);
}
const manifest = JSON.parse(execFileSync(
  'tar',
  ['-xOf', path.join(tarballDirectory, result.filename), 'package/package.json'],
  { encoding: 'utf8' },
));
if (
  manifest.version !== expectedVersion
  || manifest.nikaRelease?.version !== expectedVersion
  || manifest.nikaRelease?.preparedCommit !== preparedCommit
) {
  throw new Error(`${result.name} packed release metadata does not bind ${preparedCommit}`);
}
const expectedExports = {
  '.': {
    import: { types: './dist/index.d.ts', default: './dist/index.js' },
    require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
  },
};
if (
  manifest.name !== '@supernovae-st/nika-client'
  || manifest.type !== 'module'
  || manifest.main !== './dist/index.cjs'
  || manifest.module !== './dist/index.js'
  || manifest.types !== './dist/index.d.ts'
  || manifest.bin?.nika !== './dist/bin/nika.js'
  || JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports)
) {
  throw new Error(`${result.name} packed client manifest entrypoints are not canonical`);
}
console.log(`Verified ${result.name}@${result.version}: ${required.join(', ')}`);
