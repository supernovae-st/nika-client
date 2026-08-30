import { readFile } from 'node:fs/promises';

const [packJsonPath] = process.argv.slice(2);
if (!packJsonPath) throw new Error('Usage: verify-native-pack.mjs <npm-pack-json>');
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
console.log(`Verified ${result.name}@${result.version}: ${required.join(', ')}`);
