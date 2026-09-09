import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const scratch = [];
const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const publishStep = workflow.split('      - name: Publish payloads, then the SDK, with provenance\n')[1]
  .split('      - name: Release summary\n')[0];
const script = publishStep.split('        run: |\n')[1]
  .split('\n').map((line) => line.replace(/^          /, '')).join('\n');

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function execute(oidc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nika-oidc-workflow-'));
  scratch.push(dir);
  for (const [name, body] of Object.entries({
    git: 'printf "%s\\n" prepared-commit',
    jq: 'printf "%s\\n" prepared-commit',
    node: 'printf "%s\\n" "$*" >> "$CALL_LOG"',
  })) {
    await writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const log = path.join(dir, 'calls');
  await writeFile(log, '');
  const result = spawnSync('/bin/bash', ['-c', script], {
    cwd: dir,
    env: { PATH: `${dir}:/usr/bin:/bin`, VERSION: '0.118.7', CALL_LOG: log, ...oidc },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { ...result, calls: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) };
}

test('the publishing shell accepts GitHub OIDC without an npm write token', async () => {
  const result = await execute({
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only',
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.calls.map((call) => call.split(' ')[2])).toEqual([
    '@supernovae-st/nika-darwin-arm64', '@supernovae-st/nika-darwin-x64',
    '@supernovae-st/nika-linux-arm64', '@supernovae-st/nika-linux-x64',
    '@supernovae-st/nika-client',
  ]);
  expect(publishStep).not.toContain('secrets.NPM_TOKEN');
});

test.each([
  {},
  { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc' },
  { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only' },
])('the publishing shell refuses incomplete OIDC before invoking publication', async (oidc) => {
  const result = await execute(oidc);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('GitHub OIDC');
  expect(result.calls).toEqual([]);
});
