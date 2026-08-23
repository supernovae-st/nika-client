#!/usr/bin/env node
/**
 * SDK Coverage Checker
 *
 * The live contract is the pinned OpenAPI at repo-root openapi.json
 * (W09.B). SDK helpers must call every live path and must not call
 * absent ones (cancel, artifacts, /v1/run).
 *
 * Exit 0 = covered. Exit 1 = drift.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SDK_ROOT = resolve(import.meta.dirname, '..');
const SPEC = join(SDK_ROOT, 'openapi.json');
const SDK_FILES = [
  join(SDK_ROOT, 'src/resources/jobs.ts'),
  join(SDK_ROOT, 'src/resources/workflows.ts'),
  join(SDK_ROOT, 'src/index.ts'),
  join(SDK_ROOT, 'src/lib/api-client.ts'),
  join(SDK_ROOT, 'src/lib/streaming.ts'),
];

const ABSENT = [
  '/v1/run',
  '/v1/status',
  '/v1/cancel',
  '/v1/events',
  '/v1/reload',
  '/v1/jobs/:param/cancel',
  '/v1/jobs/:param/artifacts',
];

function livePaths() {
  const spec = JSON.parse(readFileSync(SPEC, 'utf-8'));
  return Object.keys(spec.paths || {});
}

function extractSdkEndpoints() {
  const endpoints = [];
  for (const file of SDK_FILES) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf-8');
    const apiCallRegex = /(?:this\.api|client)\.\w+(?:<[^>]+>)?\(\s*[`'"]([^`'"]*)[`'"]/g;
    let match;
    while ((match = apiCallRegex.exec(src)) !== null) {
      const cleaned = match[1].replace(/\$\{[^}]+\}/g, ':param');
      if (cleaned.startsWith('/')) endpoints.push(cleaned.split('?')[0]);
    }
    if (src.includes('fetchHealth')) endpoints.push('/health');
  }
  return [...new Set(endpoints)];
}

function normalize(path) {
  return path
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/:param/g, ':param');
}

if (!existsSync(SPEC)) {
  console.error(`missing pin: ${SPEC}`);
  process.exit(1);
}

const live = livePaths().map(normalize);
const sdk = extractSdkEndpoints();
const sdkNorm = sdk.map(normalize);

let failed = false;

console.log('Live OpenAPI paths:');
for (const path of live) {
  const covered = sdkNorm.some(
    (s) => s === path || s.startsWith(`${path}/`) || path.startsWith(`${s}/`),
  );
  // /v1/jobs/{id}/status is extra to /v1/jobs/{id}
  const hit = sdkNorm.includes(path)
    || (path === '/v1/jobs/:param' && sdkNorm.includes('/v1/jobs/:param'))
    || (path === '/v1/jobs/:param/status' && sdkNorm.includes('/v1/jobs/:param/status'))
    || (path === '/v1/jobs/:param/events' && sdkNorm.includes('/v1/jobs/:param/events'))
    || (path === '/v1/workflows/:param' && sdkNorm.includes('/v1/workflows/:param'))
    || (path === '/v1/openapi.json' && sdkNorm.includes('/v1/openapi.json'))
    || (path === '/v1/jobs' && sdkNorm.includes('/v1/jobs'))
    || (path === '/v1/workflows' && sdkNorm.includes('/v1/workflows'))
    || (path === '/health' && sdkNorm.includes('/health'));
  if (!hit) {
    // openapi.json is fetched by generate-types, not the runtime client
    if (path === '/v1/openapi.json') {
      console.log(`  skip runtime  ${path} (pin/generate only)`);
      continue;
    }
    console.log(`  MISSING  ${path}`);
    failed = true;
  } else {
    console.log(`  ok       ${path}`);
  }
}

console.log('\nSDK must not claim absent routes:');
for (const path of ABSENT) {
  const claimed = sdkNorm.some((s) => s === path || s.startsWith(`${path}/`));
  if (claimed) {
    console.log(`  CLAIMED  ${path}`);
    failed = true;
  } else {
    console.log(`  absent   ${path}`);
  }
}

console.log('\nSDK endpoints:', sdkNorm.join(', ') || '(none)');

if (failed) {
  console.error('\ncoverage DRIFT');
  process.exit(1);
}
console.log('\ncoverage OK');
