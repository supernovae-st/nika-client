import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compatibleEngineIdentity } from '../src/lib/engine-identity.js';
import {
  SESSION_HOST_CAPABILITY,
  SESSION_INTELLIGENCE_CAPABILITY,
  SESSION_STEERING_CAPABILITY,
} from '../src/lib/session-host.js';

// The same identity on both doors, on exact bytes: for every binary whose doors were recorded
// (test/fixtures/session-host/<pin>/identities.json, written by the binary itself in a fresh project
// and HOME), the native identity and a Sessions resident's `/health` pass the SDK's own identity
// check, name the same engine, build and Spec, keep the same wire clocks, and advertise the same
// Session words; a resident started without `--sessions` advertises none of them.

type Recorded = Record<string, Record<string, Record<string, unknown>>>;
const ROOT = fileURLToPath(new URL('./fixtures/session-host/', import.meta.url));
const SESSION_WORDS = [SESSION_HOST_CAPABILITY, SESSION_INTELLIGENCE_CAPABILITY, SESSION_STEERING_CAPABILITY];
const recordings = readdirSync(ROOT)
  .filter((dir) => existsSync(`${ROOT}${dir}/identities.json`))
  .flatMap((dir) => Object.entries(JSON.parse(readFileSync(`${ROOT}${dir}/identities.json`, 'utf8')) as Recorded)
    .map(([binary, doors]) => [`${dir}: ${binary}`, doors] as const));
const words = (identity: { supportedCapabilities: string[] }) =>
  SESSION_WORDS.filter((word) => identity.supportedCapabilities.includes(word));

describe('both doors of a recorded binary name the same engine', () => {
  it('has recordings to read', () => {
    expect(recordings.length).toBeGreaterThan(0);
  });

  it.each(recordings)('%s', (_name, doors) => {
    const native = compatibleEngineIdentity(doors.native, 'native-process');
    const http = compatibleEngineIdentity(doors.http, 'http', native);
    for (const key of ['engineVersion', 'buildSha', 'specSha'] as const) expect(http[key]).toBe(native[key]);
    expect(words(native)).toContain(SESSION_HOST_CAPABILITY);
    expect(words(http)).toEqual(words(native));
    if (doors.http_without_sessions) {
      const plain = compatibleEngineIdentity(doors.http_without_sessions, 'http', native);
      expect(plain.buildSha).toBe(native.buildSha);
      expect(words(plain)).toEqual([]);
    }
  });
});
