import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NikaCompatibilityError } from '../src/errors.js';
import { verifyNikaEngine } from '../src/lib/binary/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function script(body: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-probe-'));
  roots.push(root);
  const file = path.join(root, 'not-nika');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('engine identity probe refusals teach', () => {
  it('names the path and the hand probe when the executable is not an engine', async () => {
    const bin = script('echo hello');
    let caught: unknown;
    try {
      await verifyNikaEngine({ bin });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NikaCompatibilityError);
    const message = String((caught as Error).message);
    expect(message).toContain(bin);
    expect(message).toContain(`is ${bin} a nika engine?`);
    expect(message).toContain(`"${bin} --sdk-identity"`);
  });

  it('names the path and the exit code when the probe fails', async () => {
    const bin = script('exit 7');
    let caught: unknown;
    try {
      await verifyNikaEngine({ bin });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NikaCompatibilityError);
    expect(String((caught as Error).message)).toContain(`probe of ${bin} exited with code 7`);
  });

  it('names the path when nothing can be spawned there', async () => {
    const bin = path.join(mkdtempSync(path.join(tmpdir(), 'nika-probe-')), 'missing');
    roots.push(path.dirname(bin));
    let caught: unknown;
    try {
      await verifyNikaEngine({ bin });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NikaCompatibilityError);
    expect(String((caught as Error).message)).toContain(`probe of ${bin} failed`);
  });
});
