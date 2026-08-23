#!/usr/bin/env node
/**
 * Generate TypeScript types from nika serve OpenAPI spec.
 *
 * Usage:
 *   node scripts/generate-types.js                          # from ./openapi.json
 *   node scripts/generate-types.js http://127.0.0.1:8787    # from a live server
 *   node scripts/generate-types.js ./openapi.json           # from local file
 *
 * Requires NIKA_TOKEN env var when fetching from a server.
 * Output: src/generated/openapi.d.ts
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SDK_ROOT = resolve(import.meta.dirname, '..');
const OUTPUT_DIR = join(SDK_ROOT, 'src', 'generated');
const OUTPUT_FILE = join(OUTPUT_DIR, 'openapi.d.ts');

const source = process.argv[2] || join(SDK_ROOT, 'openapi.json');

async function main() {
  let specPath;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    // Fetch spec from server
    const token = process.env.NIKA_TOKEN;
    if (!token) {
      console.error('ERROR: NIKA_TOKEN env var required when fetching from server');
      process.exit(1);
    }

    const url = `${source.replace(/\/$/, '')}/v1/openapi.json`;
    console.log(`Fetching spec from ${url}...`);

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`ERROR: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const spec = await res.json();
    specPath = join(SDK_ROOT, '.openapi-cache.json');
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    console.log(`Spec cached at ${specPath} (${Object.keys(spec.paths || {}).length} paths)`);
  } else {
    // Local file
    specPath = resolve(source);
    if (!existsSync(specPath)) {
      console.error(`ERROR: File not found: ${specPath}`);
      process.exit(1);
    }
    console.log(`Using local spec: ${specPath}`);
  }

  // Generate types
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Generating TypeScript types...');
  execFileSync(
    'npx',
    ['openapi-typescript', specPath, '-o', OUTPUT_FILE],
    { cwd: SDK_ROOT, stdio: 'inherit' },
  );

  console.log(`Types generated: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
