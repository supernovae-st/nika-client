import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The lines of a pin file that are not comments. */
function pinned(name: string): string[] {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
}

describe('the engine qualification pins', () => {
  // Candidate CI builds ENGINE_QUAL_PIN (or ENGINE_CANDIDATE) from source and
  // checks every engine-backed gate against it. A release moves both to the
  // commit its engine tag names, in one change: two files that disagree would
  // qualify one engine and name another.
  it('name one exact supernovae-st/nika commit, the same in both files', () => {
    const qualification = pinned('ENGINE_QUAL_PIN');
    expect(qualification).toHaveLength(1);
    expect(qualification[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(pinned('ENGINE_CANDIDATE')).toEqual(qualification);
  });
});
