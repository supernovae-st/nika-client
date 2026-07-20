#!/usr/bin/env node
/**
 * SDK Coverage Checker
 *
 * Verifies that the TypeScript SDK covers all nika-serve endpoints.
 * Run from nika-client root: node scripts/check-sdk-coverage.js [path-to-nika]
 *
 * Exit 0 = all covered. Exit 1 = drift detected.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── Config ──────────────────────────────────────────────────

const NIKA_ROOT = process.argv[2] || resolve('..', 'nika');
const SDK_ROOT = resolve(import.meta.dirname, '..');

const SERVE_ROUTES = join(NIKA_ROOT, 'tools/nika-serve/src/routes/mod.rs');
const SERVE_EVENTS = join(NIKA_ROOT, 'tools/nika-serve/src/events.rs');
const SERVE_WORKFLOWS = join(NIKA_ROOT, 'tools/nika-serve/src/routes/workflows.rs');
const SERVE_ARTIFACTS = join(NIKA_ROOT, 'tools/nika-serve/src/routes/artifacts.rs');

// `nika serve` left the tree in the Diamond refonte and re-admits during
// the 0.9x arc (docs reference/cli) — on a modern checkout the serve tree
// is absent and coverage has NOTHING to judge. Skip honestly (exit 0,
// loud) instead of failing every release forever.
if (!existsSync(SERVE_ROUTES)) {
  console.log(`nika-serve not present at ${NIKA_ROOT} (re-admits in the 0.9x arc) — coverage SKIPPED`);
  process.exit(0);
}

const SDK_JOBS = join(SDK_ROOT, 'src/resources/jobs.ts');
const SDK_WORKFLOWS_FILE = join(SDK_ROOT, 'src/resources/workflows.ts');
const SDK_INDEX = join(SDK_ROOT, 'src/index.ts');
const SDK_TYPES = join(SDK_ROOT, 'src/types.ts');
const SDK_API_CLIENT = join(SDK_ROOT, 'src/lib/api-client.ts');
const SDK_STREAMING = join(SDK_ROOT, 'src/lib/streaming.ts');

// ── Extract routes from Rust ────────────────────────────────

function extractRustRoutes(routesFile) {
  const src = readFileSync(routesFile, 'utf-8');
  const routes = [];

  // Match both .route() and .api_route() with get/post/get_with/post_with
  const routeRegex = /\.(?:api_)?route\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)(?:_with)?\s*\(/g;
  let match;
  while ((match = routeRegex.exec(src)) !== null) {
    routes.push({ method: match[2].toUpperCase(), path: match[1] });
  }

  return routes;
}

// ── Extract SSE event types from Rust ───────────────────────

function extractRustEvents(eventsFile) {
  const src = readFileSync(eventsFile, 'utf-8');
  const events = [];

  // Match explicit serde renames: #[serde(rename = "event_name")]
  const renameRegex = /#\[serde\(rename\s*=\s*"(\w+)"\)\]/g;
  let match;
  while ((match = renameRegex.exec(src)) !== null) {
    events.push(match[1]);
  }

  return events;
}

// ── Extract response types from Rust ────────────────────────

function extractRustTypes(files) {
  const types = [];

  for (const file of files) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf-8');

    const structRegex = /pub\s+struct\s+(\w+)\s*\{/g;
    let match;
    while ((match = structRegex.exec(src)) !== null) {
      types.push(match[1]);
    }
  }

  return types;
}

// ── Extract SDK coverage ────────────────────────────────────

function extractSdkEndpoints(files) {
  const endpoints = [];

  for (const file of files) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf-8');

    // Match API calls with string/template literal paths:
    // this.api.json('/v1/run', ...) or client.connectSSE(`/v1/events/${jobId}`)
    const apiCallRegex = /(?:this\.api|client)\.\w+(?:<[^>]+>)?\(\s*[`'"]([^`'"]*)[`'"]/g;
    let match;
    while ((match = apiCallRegex.exec(src)) !== null) {
      // Clean template expressions: `/v1/events/${jobId}` → `/v1/events/:param`
      const cleaned = match[1].replace(/\$\{[^}]+\}/g, ':param');
      if (cleaned.startsWith('/')) {
        endpoints.push(cleaned);
      }
    }

    if (src.includes('fetchHealth')) {
      endpoints.push('/health');
    }
  }

  return endpoints;
}

function extractSdkEventTypes(typesFile) {
  const src = readFileSync(typesFile, 'utf-8');
  const events = [];

  const eventRegex = /type:\s*'(\w+)'/g;
  let match;
  while ((match = eventRegex.exec(src)) !== null) {
    events.push(match[1]);
  }

  return events;
}

function extractSdkTypes(typesFile) {
  const src = readFileSync(typesFile, 'utf-8');
  const types = [];

  const typeRegex = /export\s+(?:interface|type)\s+(\w+)/g;
  let match;
  while ((match = typeRegex.exec(src)) !== null) {
    types.push(match[1]);
  }

  return types;
}

// ── Normalize route path for comparison ─────────────────────

function normalizePath(path) {
  return path.replace(/\{[^}]+\}/g, ':param');
}

function routeKey(method, path) {
  return `${method} ${normalizePath(path)}`;
}

// ── Main ────────────────────────────────────────────────────

function main() {
  console.log('SDK Coverage Check');
  console.log('==================\n');

  if (!existsSync(SERVE_ROUTES)) {
    console.error(`ERROR: nika-serve not found at ${NIKA_ROOT}`);
    console.error(`Usage: node scripts/check-sdk-coverage.js [path-to-nika]`);
    process.exit(1);
  }

  let hasIssues = false;

  // ── 1. Route coverage ──────────────────────────────────

  console.log('1. Route Coverage\n');

  const rustRoutes = extractRustRoutes(SERVE_ROUTES);
  const sdkEndpoints = extractSdkEndpoints([SDK_JOBS, SDK_WORKFLOWS_FILE, SDK_INDEX, SDK_API_CLIENT, SDK_STREAMING]);

  const SKIP_ROUTES = new Set([
    'GET /metrics',
    'GET /v1/openapi.json',
  ]);

  for (const route of rustRoutes) {
    const key = routeKey(route.method, route.path);
    const normalized = normalizePath(route.path);

    if (SKIP_ROUTES.has(key)) {
      console.log(`  SKIP  ${key} (intentionally excluded)`);
      continue;
    }

    const covered = sdkEndpoints.some(ep => {
      const epNorm = ep.replace(/\$\{[^}]+\}/g, ':param');
      return normalizePath(epNorm) === normalized;
    });

    if (covered) {
      console.log(`  OK    ${key}`);
    } else {
      console.log(`  MISS  ${key} ← NOT in SDK!`);
      hasIssues = true;
    }
  }

  // ── 2. SSE Event coverage ──────────────────────────────

  console.log('\n2. SSE Event Types\n');

  const rustEvents = extractRustEvents(SERVE_EVENTS);
  const sdkEvents = new Set(extractSdkEventTypes(SDK_TYPES));

  for (const event of rustEvents) {
    if (sdkEvents.has(event)) {
      console.log(`  OK    ${event}`);
    } else {
      console.log(`  MISS  ${event} ← NOT in SDK types!`);
      hasIssues = true;
    }
  }

  for (const event of sdkEvents) {
    if (!rustEvents.includes(event)) {
      console.log(`  STALE ${event} ← in SDK but NOT in Rust`);
      hasIssues = true;
    }
  }

  // ── 3. Response type coverage ──────────────────────────

  console.log('\n3. Response Types\n');

  const rustTypes = extractRustTypes([SERVE_WORKFLOWS, SERVE_ARTIFACTS]);
  const sdkTypes = new Set(extractSdkTypes(SDK_TYPES));

  const TYPE_MAP = {
    'RunRequest': 'RunRequest',
    'RunResponse': 'RunResponse',
    'StatusResponse': 'NikaJob',
    'WorkflowInfo': 'WorkflowInfo',
    'ListWorkflowsResponse': 'ListWorkflowsResponse',
  };

  for (const rustType of rustTypes) {
    const sdkName = TYPE_MAP[rustType];
    if (!sdkName) {
      console.log(`  SKIP  ${rustType} (no SDK mapping defined)`);
      continue;
    }
    if (sdkTypes.has(sdkName)) {
      console.log(`  OK    ${rustType} → ${sdkName}`);
    } else {
      console.log(`  MISS  ${rustType} → ${sdkName} ← NOT in SDK types!`);
      hasIssues = true;
    }
  }

  // ── Summary ────────────────────────────────────────────

  console.log('\n==================');
  if (hasIssues) {
    console.log('FAIL: SDK drift detected. Update the SDK to match nika-serve.');
    process.exit(1);
  } else {
    console.log('PASS: SDK covers all nika-serve endpoints and types.');
    process.exit(0);
  }
}

main();
