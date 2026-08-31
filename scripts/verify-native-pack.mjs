import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [packJsonPath, tarballDirectory, preparedCommit, expectedVersion] = process.argv.slice(2);
if (!packJsonPath || !tarballDirectory || !preparedCommit || !expectedVersion) {
  throw new Error(
    'Usage: verify-native-pack.mjs <npm-pack-json> <tarball-directory> <prepared-commit> <version>',
  );
}
const result = JSON.parse(await readFile(packJsonPath, 'utf8'))[0];
if (!result) throw new Error(`No npm pack result in ${packJsonPath}`);

const required = ['package.json', 'bin/nika', 'LICENSE', 'SOURCE.json', 'INTEGRITY.json'];
const files = new Map(result.files.map((entry) => [entry.path, entry]));
for (const file of required) {
  if (!files.has(file)) throw new Error(`${result.name} pack is missing ${file}`);
}
if ((files.get('bin/nika').mode & 0o111) === 0) {
  throw new Error(`${result.name} bin/nika is not executable`);
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
console.log(`Verified ${result.name}@${result.version}: ${required.join(', ')}`);
