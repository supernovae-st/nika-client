import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseReplay } from '../scripts/verify-release-replay.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const committedResults = path.join(ROOT, 'gauntlet', 'results');
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('public release evidence replay', () => {
  it('compares every deterministic field while excluding only hostile timing metadata', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.generated_at = '2099-01-01T00:00:00.000Z';
    for (const scenario of hostile.scenarios) scenario.duration_ms += 10_000;
    writeJson(replay, 'hostile.json', hostile);

    expect(verifyReleaseReplay(ROOT, replay)).toMatchObject({
      engine: 'nika 0.116.2 (c4cdbeafb)',
      workflows: 100,
      hostileScenarios: 14,
      realEngineRuns: 70,
    });
  });

  it('refuses a rewritten engine identity', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.engine = 'nika 0.116.0 (b38267751)';
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'hostile replay does not match committed stable behavioral evidence',
    );
  });

  it('refuses a stale or edited behavioral claim even when identity is current', () => {
    const replay = createReplay();
    const hostile = readJson(replay, 'hostile.json');
    hostile.scenarios[0].evidence.network_requests = 1;
    writeJson(replay, 'hostile.json', hostile);

    expect(() => verifyReleaseReplay(ROOT, replay)).toThrow(
      'hostile replay does not match committed stable behavioral evidence',
    );
  });
});

function createReplay(): string {
  const replay = mkdtempSync(path.join(tmpdir(), 'nika-release-replay-'));
  scratch.push(replay);
  for (const name of ['local-execution.json', 'hostile.json']) {
    writeFileSync(path.join(replay, name), readFileSync(path.join(committedResults, name)));
  }
  return replay;
}

function readJson(directory: string, name: string): any {
  return JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
}

function writeJson(directory: string, name: string, value: unknown): void {
  writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}
