import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { assertAbsent, publishExact } from '../scripts/npm-publication.mjs';

const name = '@supernovae-st/nika';
const version = '0.118.7';
const bytes = Buffer.from('prepared immutable tarball');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const tarball = 'https://registry.npmjs.org/@supernovae-st/nika/-/nika-0.118.7.tgz';
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nika-npm-proof-'));
  directories.push(dir);
  const file = path.join(dir, 'candidate.tgz');
  await writeFile(file, bytes);
  return file;
}
function metadata(overrides = {}) { return Response.json({ name, version, dist: { integrity, tarball }, ...overrides }); }
function absent() { return Response.json({ error: 'Not found' }, { status: 404 }); }
function registry(...responses) {
  return vi.fn(async (_url, options) => {
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    if (!responses.length) throw new Error('unexpected registry read');
    return responses.shift();
  });
}

test('only explicit registry 404 proves absence', async () => {
  await expect(assertAbsent(name, version, registry(absent()))).resolves.toBeUndefined();
  await expect(assertAbsent(name, version, registry(metadata()))).rejects.toThrow('already exists');
});

test.each([401, 403, 429, 500, 503])('registry HTTP %i cannot become absence or authorize a publish', async (status) => {
  const fetch = registry(new Response('unavailable', { status }));
  const run = vi.fn();
  await expect(publishExact(name, version, await fixture(), { fetch, run })).rejects.toThrow(`HTTP ${status}`);
  expect(run).not.toHaveBeenCalled();
});

test('network refusal and malformed metadata remain failures', async () => {
  await expect(assertAbsent(name, version, vi.fn().mockRejectedValue(new Error('offline')))).rejects.toThrow('offline');
  await expect(assertAbsent(name, version, registry(new Response('not json')))).rejects.toThrow();
});

test('identical occupied bytes are independently downloaded and never republished', async () => {
  const fetch = registry(metadata(), new Response(bytes));
  const run = vi.fn();
  await expect(publishExact(name, version, await fixture(), { fetch, run })).resolves.toEqual({ published: false, integrity });
  expect(fetch.mock.calls[1][0]).toBe(tarball);
  expect(run).not.toHaveBeenCalled();
});

test.each(['integrity', 'bytes', 'identity', 'redirect-target'])('occupied %s disagreement refuses without publishing', async (kind) => {
  const dist = { integrity, tarball };
  if (kind === 'integrity') dist.integrity = 'sha512-different';
  if (kind === 'redirect-target') dist.tarball = 'https://example.com/package.tgz';
  const fetch = registry(metadata({ dist, ...(kind === 'identity' ? { version: '0.118.0' } : {}) }), new Response('different bytes'));
  const run = vi.fn();
  await expect(publishExact(name, version, await fixture(), { fetch, run })).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

test('absent version publishes the explicit prepared archive once then proves public bytes', async () => {
  const file = await fixture();
  const fetch = registry(absent(), metadata(), new Response(bytes));
  const run = vi.fn();
  await expect(publishExact(name, version, file, { fetch, run })).resolves.toEqual({ published: true, integrity });
  expect(run).toHaveBeenCalledExactlyOnceWith('npm', ['publish', file, '--access', 'public', '--provenance', '--ignore-scripts', '--registry=https://registry.npmjs.org'], expect.objectContaining({ timeout: 180_000, killSignal: 'SIGKILL' }));
});

test('publication refusal is not followed by a success claim', async () => {
  const fetch = registry(absent());
  const run = vi.fn(() => { throw new Error('publish refused'); });
  await expect(publishExact(name, version, await fixture(), { fetch, run })).rejects.toThrow('publish refused');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('success exit with absent public bytes is still a failed release', async () => {
  const wait = { attempts: 1, waitMs: 0 };
  await expect(publishExact(name, version, await fixture(), { fetch: registry(absent(), absent()), run: vi.fn(), wait })).rejects.toThrow('not observable');
});

// Measured 2026-09-10 on @supernovae-st/nika-darwin-arm64@0.118.7: `npm publish`
// answered `+ …@0.118.7`, the metadata was readable at once, and the tarball URL
// kept answering 404 for minutes. The registry serves a publication in two steps.
test('a freshly published archive that lags its metadata is re-read until served', async () => {
  const file = await fixture();
  const notYet = () => new Response('later', { status: 404 });
  const outage = () => new Response('later', { status: 503 });
  const fetch = registry(absent(), metadata(), notYet(), outage(), new Response(bytes));
  const sleep = vi.fn(async () => {});
  await expect(publishExact(name, version, file, { fetch, run: vi.fn(), wait: { attempts: 5, waitMs: 7 }, sleep })).resolves.toEqual({ published: true, integrity });
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(7);
});

test('metadata that lags a publish is re-read before the archive', async () => {
  const fetch = registry(absent(), absent(), metadata(), new Response(bytes));
  await expect(publishExact(name, version, await fixture(), { fetch, run: vi.fn(), wait: { attempts: 3, waitMs: 0 } })).resolves.toEqual({ published: true, integrity });
  expect(fetch).toHaveBeenCalledTimes(4);
});

test('the archive wait is bounded and keeps its words', async () => {
  const notYet = () => new Response('later', { status: 404 });
  const fetch = registry(absent(), metadata(), notYet(), notYet());
  const run = vi.fn();
  await expect(publishExact(name, version, await fixture(), { fetch, run, wait: { attempts: 2, waitMs: 0 } })).rejects.toThrow('npm archive HTTP 404');
  expect(run).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(4);
});

test('an occupied version whose archive is not served yet waits too, and a 4xx other than 404 still refuses', async () => {
  const fetch = registry(metadata(), new Response('later', { status: 404 }), new Response(bytes));
  await expect(publishExact(name, version, await fixture(), { fetch, run: vi.fn(), wait: { attempts: 3, waitMs: 0 } })).resolves.toEqual({ published: false, integrity });
  const forbidden = registry(metadata(), new Response('no', { status: 403 }));
  await expect(publishExact(name, version, await fixture(), { fetch: forbidden, run: vi.fn(), wait: { attempts: 3, waitMs: 0 } })).rejects.toThrow('npm archive HTTP 403');
});

test('prepared bytes changing during publication cannot be accepted', async () => {
  const file = await fixture();
  const run = vi.fn(async () => { await writeFile(file, 'changed'); });
  await expect(publishExact(name, version, file, { fetch: registry(absent(), metadata(), new Response(bytes)), run })).rejects.toThrow('changed');
});

test('untrusted coordinates, symlinks and oversized bodies refuse', async () => {
  const fetch = registry(metadata());
  await expect(assertAbsent('@other/package', version, fetch)).rejects.toThrow('coordinate');
  await expect(assertAbsent(name, '01.118.1', fetch)).rejects.toThrow('coordinate');
  expect(fetch).not.toHaveBeenCalled();
  const file = await fixture();
  await symlink(file, `${file}.link`);
  await expect(publishExact(name, version, `${file}.link`, { fetch, run: vi.fn() })).rejects.toThrow('regular');
  await expect(assertAbsent(name, version, registry(new Response('x', { headers: { 'content-length': '1048577' } })))).rejects.toThrow('limit');
});

test('both workflow decisions share the fail-closed npm owner', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  expect(workflow).toContain('node scripts/npm-publication.mjs assert-absent "$package_name" "$VERSION"');
  expect(workflow).toContain('node scripts/npm-publication.mjs publish "$pkg" "$VERSION" "$tarball"');
  expect(workflow).not.toContain('npm view "$pkg@$VERSION" version');
  expect(workflow).not.toContain('npm view "$package_name@$VERSION" version');
});
