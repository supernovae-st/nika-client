import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseEvidence } from '../scripts/verify-release-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENGINE = 'nika 0.116.2 (c4cdbeafb)';
const PACKAGE = 'supernovae-st-nika-client-0.116.2.tgz';
const currentEvidence = [
  'gauntlet/projects-depth/results.json',
  'gauntlet/results/hostile.json',
  'gauntlet/results/local-execution.json',
  'gauntlet/results/mini-saas.json',
  'gauntlet/results/recovery-e2e.json',
];
const packedEvidence = new Set([
  'gauntlet/projects-depth/results.json',
  'gauntlet/results/mini-saas.json',
  'gauntlet/results/recovery-e2e.json',
]);
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release evidence identity', () => {
  it('binds every committed release gate to the package version and one engine', () => {
    expect(verifyReleaseEvidence(ROOT)).toEqual({
      version: '0.116.2',
      engine: ENGINE,
      package: PACKAGE,
      currentFiles: 5,
      historicalFiles: 2,
    });
  });

  it('refuses stale engine evidence', () => {
    const fixture = createFixture();
    writeJson(fixture, 'gauntlet/results/local-execution.json', {
      schema_version: 1,
      engine: 'nika 0.116.0 (b38267751)',
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      'records engine 0.116.0, expected package version 0.116.2',
    );
  });

  it('refuses a stale packed-package identity', () => {
    const fixture = createFixture();
    writeJson(fixture, 'gauntlet/results/mini-saas.json', {
      schema_version: 1,
      engine: ENGINE,
      package: 'supernovae-st-nika-client-0.116.0.tgz',
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      `records package supernovae-st-nika-client-0.116.0.tgz, expected ${PACKAGE}`,
    );
  });
});

function createFixture(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), 'nika-release-evidence-'));
  scratch.push(fixture);
  writeJson(fixture, 'package.json', { version: '0.116.2' });
  for (const relativePath of currentEvidence) {
    writeJson(fixture, relativePath, {
      schema_version: 1,
      engine: ENGINE,
      ...(packedEvidence.has(relativePath) ? { package: PACKAGE } : {}),
    });
  }
  const reportPath = path.join(fixture, 'gauntlet/projects-depth/REPORT.md');
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `engine \`${ENGINE}\` with \`${PACKAGE}\`\n`);
  return fixture;
}

function writeJson(root: string, relativePath: string, value: object): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}
