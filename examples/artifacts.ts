/**
 * Run a job on your `nika serve`, list the files it produced, and download one.
 *
 *   npm run build                       # the example imports the package by name
 *   export NIKA_URL=http://127.0.0.1:8787 NIKA_TOKEN="$(cat .nika/serve.token)"
 *   node artifacts.ts [workflow] [artifact-name]
 *
 * Submits the served workflow (default `chart.nika`: one `nika:chart` task, no
 * model, no provider key, no network), waits for the job to settle, prints the
 * artifacts its sealed journal records, then downloads one (default: the
 * first listed) into `downloads/`. The bytes are written under a temporary
 * name and kept only once the stream closed, which it does only after the
 * package proved them against the recorded size and SHA-256. The server needs
 * a run key: without one, it answers 409 `artifact_journal_unverified`.
 * Node 22.18+ runs this file as is. examples/README.md shows how to start the
 * server.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Nika } from '@supernovae-st/nika';

const [workflow = 'chart.nika', wanted] = process.argv.slice(2);
const url = process.env.NIKA_URL;
const token = process.env.NIKA_TOKEN;
if (!url || !token) {
  console.error('usage: NIKA_URL=… NIKA_TOKEN=… node artifacts.ts [workflow] [artifact-name]');
  process.exit(64);
}
// Plain HTTP stays limited to a loopback server (a local `nika serve`).
const nika = new Nika({ url, token, allowInsecureHttp: url.startsWith('http://') });

const run = await nika.run(workflow, { idempotencyKey: `artifacts-${randomUUID()}` });
const result = await run.result(); // a job's artifacts are served once it has settled
console.log(`job ${run.id} · ${result.status}`);

const manifest = await run.artifacts();
for (const entry of manifest.artifacts) {
  const digest = entry.sha256.slice(0, 12);
  console.log(`${entry.name} · ${entry.mime} · ${entry.size} bytes · sha256 ${digest}…`);
}
const artifact = wanted === undefined
  ? manifest.artifacts[0]
  : manifest.artifacts.find((entry) => entry.name === wanted);
if (!artifact) {
  console.error(wanted === undefined ? 'the job lists no artifact' : `the job lists no ${wanted}`);
  process.exit(1);
}

// A name is a key, never a path: the local file takes only its last segment.
await mkdir('downloads', { recursive: true });
const file = path.join('downloads', path.basename(artifact.name));
const partial = `${file}.part`;
// The entry, rather than its name, spares the package a second manifest read.
const download = await run.downloadArtifact(artifact);
try {
  await pipeline(Readable.fromWeb(download.stream), createWriteStream(partial));
} catch (cause) {
  await rm(partial, { force: true }); // a stream that errored delivered no proven artifact
  throw cause;
}
await rename(partial, file);
console.log(`saved ${file} · ${artifact.size} bytes, proven against the job's journal`);
