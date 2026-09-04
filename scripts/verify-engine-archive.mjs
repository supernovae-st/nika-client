import { verifyEngineArchive } from './native-release-contract.mjs';

const [archive, sums, version, expectedCommit, ...extra] = process.argv.slice(2);
if (!archive || !sums || !version || extra.length) {
  throw new Error('usage: verify-engine-archive.mjs <archive> <SHA256SUMS> <version> [expected-engine-commit]');
}
console.log(JSON.stringify(await verifyEngineArchive(archive, sums, version, expectedCommit)));
