import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nativeTarget } from './native-release-contract.mjs';

const REGISTRY = 'https://registry.npmjs.org';
const ARCHIVE_LIMIT = 256 * 1024 * 1024;

function coordinate(name, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('invalid stable npm coordinate');
  }
  if (name !== '@supernovae-st/nika-client') {
    try { nativeTarget(name, version); } catch { throw new Error('invalid npm package coordinate'); }
  }
  return `${REGISTRY}/${encodeURIComponent(name)}/${version}`;
}

async function response(url, fetch) {
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
}

async function consume(reply, limit, accept) {
  if (Number(reply.headers.get('content-length')) > limit) {
    await reply.body?.cancel();
    throw new Error('npm response exceeds byte limit');
  }
  if (!reply.body) throw new Error('npm response has no body');
  let bytes = 0;
  for await (const chunk of reply.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('npm response exceeds byte limit');
    accept(chunk);
  }
  return bytes;
}

async function published(name, version, fetch) {
  const reply = await response(coordinate(name, version), fetch);
  if (reply.status === 404) {
    await reply.body?.cancel();
    return null;
  }
  if (reply.status !== 200) {
    await reply.body?.cancel();
    throw new Error(`npm registry HTTP ${reply.status}; absence is not proven`);
  }
  const chunks = [];
  await consume(reply, 1024 * 1024, (chunk) => chunks.push(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (value?.name !== name || value.version !== version) {
    throw new Error('npm registry returned a different package identity');
  }
  return value;
}

export async function assertAbsent(name, version, fetch = globalThis.fetch) {
  if (await published(name, version, fetch)) throw new Error(`${name}@${version} already exists publicly`);
}

async function localIntegrity(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size <= 0 || info.size > ARCHIVE_LIMIT) {
    throw new Error('npm candidate must be a bounded nonempty regular file');
  }
  const hash = createHash('sha512');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > ARCHIVE_LIMIT) throw new Error('npm candidate exceeds byte limit');
    hash.update(chunk);
  }
  if (bytes !== info.size) throw new Error('npm candidate changed during hashing');
  return `sha512-${hash.digest('base64')}`;
}

async function verifyBytes(value, name, version, integrity, fetch) {
  const leaf = name.split('/')[1];
  const expectedUrl = `${REGISTRY}/${name}/-/${leaf}-${version}.tgz`;
  if (value.dist?.integrity !== integrity || value.dist?.tarball !== expectedUrl) {
    throw new Error('occupied npm version differs from prepared integrity or canonical URL');
  }
  const reply = await response(expectedUrl, fetch);
  if (reply.status !== 200) {
    await reply.body?.cancel();
    throw new Error(`npm archive HTTP ${reply.status}`);
  }
  const hash = createHash('sha512');
  await consume(reply, ARCHIVE_LIMIT, (chunk) => hash.update(chunk));
  if (`sha512-${hash.digest('base64')}` !== integrity) {
    throw new Error('actual public npm bytes differ from the prepared archive');
  }
}

// The prepared artifact is already pack-inspected and platform-tested upstream.
// This boundary proves immutable byte convergence, not cross-package atomicity
// or provenance on replay. It never adopts a version merely because it exists.
export async function publishExact(name, version, file, { fetch = globalThis.fetch, run = execFileSync } = {}) {
  coordinate(name, version);
  file = path.resolve(file);
  const integrity = await localIntegrity(file);
  let value = await published(name, version, fetch);
  const didPublish = value === null;
  if (didPublish) {
    if (await localIntegrity(file) !== integrity) throw new Error('prepared npm bytes changed before publication');
    await run('npm', ['publish', file, '--access', 'public', '--provenance', '--ignore-scripts', `--registry=${REGISTRY}`], {
      stdio: 'inherit', timeout: 180_000, killSignal: 'SIGKILL',
    });
    value = await published(name, version, fetch);
    if (value === null) throw new Error('published npm version is not observable');
  }
  await verifyBytes(value, name, version, integrity, fetch);
  if (await localIntegrity(file) !== integrity) throw new Error('prepared npm bytes changed during publication');
  return { published: didPublish, integrity };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, name, version, file, ...extra] = process.argv.slice(2);
    if (extra.length || (mode === 'assert-absent' ? file !== undefined : mode !== 'publish' || !file)) {
      throw new Error('usage: npm-publication.mjs assert-absent <package> <version> | publish <package> <version> <archive>');
    }
    if (mode === 'assert-absent') await assertAbsent(name, version);
    else console.log(JSON.stringify(await publishExact(name, version, file)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
