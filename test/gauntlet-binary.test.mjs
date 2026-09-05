import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let scratch;
let fixture;
let environment;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'nika-gauntlet-selection-'));
  fixture = path.join(scratch, 'nika');
  mkdirSync(path.join(scratch, 'home'));
  writeFileSync(fixture, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(path.join(scratch, 'calls'))}, 'called\\n');
if (process.argv.includes('--version')) process.stdout.write('fixture');
else if (process.argv.includes('check')) process.stdout.write(JSON.stringify({ clean: true, paid_ready: true }));
else process.stdout.write(JSON.stringify({ file: process.argv[3] }));
`);
  chmodSync(fixture, 0o755);
  environment = { PATH: scratch, HOME: path.join(scratch, 'home'), NIKA_KEYCHAIN: 'off',
    NIKA_TEST_MARKER: path.join(scratch, 'calls'), NIKA_GAUNTLET_RESULTS_DIR: path.join(scratch, 'results') };
});

afterEach(() => { rmSync(scratch, { recursive: true }); });

describe.each(['verify-gauntlet-corpus.mjs', 'execute-gauntlet-corpus.mjs'])('%s engine selection', (script) => {
  it.each(['legacy-only', 'path-only', 'relative', 'empty'])('refuses %s before spawning any engine', (mode) => {
    if (mode !== 'path-only') environment.NIKA_GAUNTLET_BIN = fixture;
    if (mode === 'relative') environment.NIKA_BIN = 'nika';
    if (mode === 'empty') environment.NIKA_BIN = '';
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain('NIKA_BIN must name an absolute engine binary under test');
    expect(existsSync(environment.NIKA_TEST_MARKER)).toBe(false);
    if (script.startsWith('execute-')) {
      const report = JSON.parse(readFileSync(path.join(environment.NIKA_GAUNTLET_RESULTS_DIR, 'local-execution.json'), 'utf8'));
      expect(report.result).toBe('red');
    } else expect(existsSync(environment.NIKA_GAUNTLET_RESULTS_DIR)).toBe(false);
  });

  it('uses only the explicit binary for the complete corpus', () => {
    environment.NIKA_BIN = fixture;
    environment.NIKA_GAUNTLET_BIN = path.join(scratch, 'retired-must-not-run');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const expected = script.startsWith('verify-') ? 100 : 102;
    expect(readFileSync(environment.NIKA_TEST_MARKER, 'utf8').trim().split('\n')).toHaveLength(expected);
  }, 20000);
});
