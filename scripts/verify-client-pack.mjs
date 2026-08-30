import { readFile } from 'node:fs/promises';

const [packJsonPath] = process.argv.slice(2);
if (!packJsonPath) throw new Error('Usage: verify-client-pack.mjs <npm-pack-json>');

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
console.log(`Verified ${result.name}@${result.version}: ${required.join(', ')}`);
