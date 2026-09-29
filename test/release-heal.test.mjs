import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scratch = [];
const workflow = await readFile(new URL('../.github/workflows/release-heal.yml', import.meta.url), 'utf8');
const healStep = workflow.split('      - name: npm follows the engine release\n')[1]
  .split('\n      - ')[0];
const script = healStep.split('        run: |\n')[1]
  .split('\n').map((line) => line.replace(/^          /, '')).join('\n');

/* The published package is @supernovae-st/nika since the 2026-09-10 rename;
   reading the retired @supernovae-st/nika-client dist-tag (frozen at its last
   publish) made npm always differ from the engine tag, so the guard at the
   top could never fire and the daily cron dispatched release.yml into its
   assert-absent wall once per version. These states pin the whole table. */

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function execute({ npmLatest, repoVersion, registryDown = false }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nika-release-heal-'));
  scratch.push(dir);
  const gh = [
    '#!/bin/sh',
    'case "$1 $2" in',
    '  "release view") printf "%s\\n" "v0.120.1" ;;',
    '  "workflow run") printf "%s\\n" "$*" >> "$CALL_LOG" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n');
  const curl = registryDown
    ? '#!/bin/sh\nexit 22\n'
    : `#!/bin/sh\nprintf '%s\\n' '{"dist-tags":{"latest":"${npmLatest}"}}'\n`;
  const node = [
    '#!/bin/sh',
    'python3 -c \'import json;print(json.load(open("package.json"))["version"])\'',
  ].join('\n');
  for (const [name, body] of Object.entries({ gh, curl, node })) {
    await writeFile(path.join(dir, name), `${body}\n`, { mode: 0o755 });
  }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: repoVersion }));
  const log = path.join(dir, 'calls');
  await writeFile(log, '');
  const result = spawnSync('/bin/bash', ['-c', script], {
    cwd: dir,
    env: {
      PATH: `${dir}:/usr/bin:/bin`,
      GH_TOKEN: 'fixture-only',
      GITHUB_REPOSITORY: 'supernovae-st/nika-client',
      CALL_LOG: log,
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { ...result, calls: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) };
}

test('npm already at the engine version exits quietly, nothing to heal', async () => {
  const result = await execute({ npmLatest: '0.120.1', repoVersion: '0.120.1' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('nothing to heal');
  expect(result.calls).toEqual([]);
});

test('npm behind while the SDK train is not merged warns and waits', async () => {
  const result = await execute({ npmLatest: '0.120.0', repoVersion: '0.120.0' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('waiting for its version PR');
  expect(result.calls).toEqual([]);
});

test('npm behind with the matching SDK train merged dispatches the Release workflow', async () => {
  const result = await execute({ npmLatest: '0.120.0', repoVersion: '0.120.1' });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.calls).toEqual([
    'workflow run release.yml --repo supernovae-st/nika-client --ref main -f version=0.120.1',
  ]);
});

test('an unreadable registry fails the step red and never dispatches', async () => {
  const result = await execute({ npmLatest: '0.120.0', repoVersion: '0.120.1', registryDown: true });
  expect(result.status).not.toBe(0);
  expect(result.calls).toEqual([]);
});

test('the step reads the current package name, not the retired one', () => {
  expect(script).toContain('https://registry.npmjs.org/@supernovae-st%2Fnika');
  expect(script).not.toContain('nika-client');
});
