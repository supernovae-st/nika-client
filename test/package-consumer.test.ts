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
    // Issue #116: the packed package, not the source tree, carries literal inputs.
    expect(output).toContain('binds literal inputs from ESM over native stdin and HTTP');
    expect(output).toContain('binds literal inputs from CommonJS over native stdin and HTTP');
  }, 120_000);
});
