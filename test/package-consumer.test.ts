import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/verify-packed-module-surfaces.mjs', import.meta.url);

describe('packed Node consumer surfaces', () => {
  it('exports ESM, CommonJS and installed package metadata', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(script)], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('exposes typed ESM, CommonJS and package metadata');
  }, 120_000);
});
