# @supernovae-st/nika-client

TypeScript client for the [Nika](https://github.com/supernovae-st/nika) workflow engine HTTP API (`nika serve`).

- Zero runtime dependencies (uses native `fetch`)
- Full TypeScript types aligned with nika serve OpenAPI 3.1 spec
- Namespace pattern: `nika.jobs.*`, `nika.workflows.*`
- 6 typed error classes with full hierarchy
- Automatic retry on 429/5xx with exponential backoff
- Client-side concurrency limiter (semaphore, default: 24)
- SSE streaming via `AsyncIterable` with idle timeout + auto-reconnect
- Binary artifact download (`Uint8Array`) + streaming (`ReadableStream`)
- Auto-paginating workflow listing
- AbortSignal support on long-running operations
- Webhook HMAC-SHA256 verification (async, Web Crypto API)
- Dual CJS/ESM build
- Node.js 18+

> **Status:** this SDK targets the future `nika serve` HTTP API. The current
> engine release-candidate ships the CLI/LSP/MCP front door; keep this package
> pinned until the serve surface is released and versioned.

## Install

```bash
npm install @supernovae-st/nika-client
```

## Quick start

```typescript
import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({
  url: 'http://localhost:3000',
  token: process.env.NIKA_TOKEN!,
});

// Submit + poll until done
const job = await nika.jobs.run('translate.nika.yaml', {
  file: 'ui.json',
  locale: 'fr_FR',
});
console.log(job.status); // 'completed'
```

## Usage

### Run a workflow and wait for completion

```typescript
const job = await nika.jobs.run('pipeline.nika.yaml', { topic: 'AI' });
console.log(job.status);       // 'completed'
console.log(job.exit_code);    // 0
console.log(job.completed_at); // '2026-04-02T10:01:00Z'
```

### Stream events in real time (SSE)

```typescript
const { job_id } = await nika.jobs.submit('pipeline.nika.yaml', { topic: 'AI' });

for await (const event of nika.jobs.stream(job_id)) {
  console.log(event.type, event.task_id ?? '', event.duration_ms ?? '');
  // started
  // task_start research infer
  // task_complete research 1200
  // completed
}
```

### Run and collect all artifacts

```typescript
const artifacts = await nika.jobs.runAndCollect('research.nika.yaml', {
  topic: 'workflow engines',
});

console.log(artifacts['report.md']);   // markdown string
console.log(artifacts['data.json']);   // parsed JSON object
// binary artifacts (audio, images) are skipped
```

### Download binary artifacts

```typescript
const bytes = await nika.jobs.artifactBinary('job-id', 'audio.mp3');
// bytes is Uint8Array
```

### Stream large artifacts without loading into memory

```typescript
import * as fs from 'node:fs';

const stream = await nika.jobs.artifactStream('job-id', 'dataset.csv');
const writer = fs.createWriteStream('output.csv');
for await (const chunk of stream) {
  writer.write(chunk);
}
writer.end();
```

### Paginate workflow listing

```typescript
// Auto-pagination (default) — fetches all pages transparently
const all = await nika.workflows.list();

// Manual pagination for large lists
const page1 = await nika.workflows.listPage({ limit: 50 });
if (page1.has_more) {
  const last = page1.workflows[page1.workflows.length - 1].name;
  const page2 = await nika.workflows.listPage({ limit: 50, after: last });
}
```

### Cancel a running job with AbortSignal

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const job = await nika.jobs.run('slow.nika.yaml', {}, {
  signal: controller.signal,
});
```

### Custom fetch (logging middleware)

```typescript
const nika = new Nika({
  url: 'http://localhost:3000',
  token: process.env.NIKA_TOKEN!,
  fetch: async (url, init) => {
    console.log(`>> ${init?.method ?? 'GET'} ${url}`);
    const res = await fetch(url, init);
    console.log(`<< ${res.status}`);
    return res;
  },
});
```

### Webhook verification

```typescript
import { Nika } from '@supernovae-st/nika-client';

// Stripe-style HMAC-SHA256 verification (async — uses Web Crypto API)
// Works in Node.js 18+, Deno, Cloudflare Workers, and Bun.
const isValid = await Nika.verifyWebhook(
  rawBody,
  signatureHeader, // 't=1234567890,v1=abc123...'
  webhookSecret,
);
```

## Configuration

### `new Nika(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | (required) | nika serve URL (http/https) |
| `token` | `string` | (required) | Bearer token (`NIKA_SERVE_TOKEN`) |
| `timeout` | `number` | `30000` | HTTP request timeout in ms |
| `retries` | `number` | `2` | Retries on 429/5xx |
| `concurrency` | `number` | `24` | Max concurrent HTTP requests |
| `pollInterval` | `number` | `2000` | Initial poll interval in ms |
| `pollTimeout` | `number` | `300000` | Max poll duration in ms |
| `pollBackoff` | `number` | `1.5` | Poll backoff multiplier |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch function |
| `logger` | `NikaLogger` | (none) | Logger interface (`debug`, `info`, `warn`, `error`) |

## API reference

### Jobs — `nika.jobs.*`

| Method | Returns | Description |
|--------|---------|-------------|
| `submit(workflow, inputs?, opts?)` | `RunResponse` | Submit workflow, return `{ job_id, status }` |
| `status(jobId)` | `NikaJob` | Get job status |
| `cancel(jobId)` | `CancelResponse` | Cancel a running job |
| `run(workflow, inputs?, opts?)` | `NikaJob` | Submit + poll until terminal state |
| `stream(jobId, opts?)` | `AsyncIterable<NikaEvent>` | SSE event stream |
| `artifacts(jobId)` | `NikaArtifact[]` | List job artifacts |
| `artifact(jobId, name)` | `string` | Download artifact as text |
| `artifactJson<T>(jobId, name)` | `T` | Download artifact as parsed JSON |
| `artifactBinary(jobId, name)` | `Uint8Array` | Download artifact as raw bytes |
| `artifactStream(jobId, name)` | `ReadableStream<Uint8Array>` | Stream artifact (for large files) |
| `runAndCollect(workflow, inputs?, opts?)` | `Record<string, unknown>` | Run + collect all non-binary artifacts |

### Workflows — `nika.workflows.*`

| Method | Returns | Description |
|--------|---------|-------------|
| `list()` | `WorkflowInfo[]` | List all workflows (auto-paginates) |
| `listPage(opts?)` | `ListWorkflowsResponse` | List single page (manual pagination) |
| `reload()` | `WorkflowInfo[]` | Rescan workflows directory |
| `source(name)` | `string` | Get raw YAML source |

### System

| Method | Returns | Description |
|--------|---------|-------------|
| `nika.health()` | `HealthResponse` | Health check (no auth required) |
| `Nika.verifyWebhook(body, sig, secret)` | `boolean` | Static: verify webhook HMAC-SHA256 |

## Error classes

All SDK errors extend `NikaError`. Catch it to handle any SDK error:

```
NikaError (base)
├── NikaAPIError        — HTTP errors (status, body, requestId)
├── NikaConnectionError — Network errors (DNS, TCP, abort)
├── NikaTimeoutError    — Request or poll timeout
└── NikaJobError        — Job failed (exitCode, job object)
    └── NikaJobCancelledError — Job was cancelled
```

```typescript
import { NikaError, NikaAPIError, NikaJobError } from '@supernovae-st/nika-client';

try {
  await nika.jobs.run('pipeline.nika.yaml');
} catch (err) {
  if (err instanceof NikaJobError) {
    console.error('Job failed:', err.job.output, 'exit:', err.exitCode);
  } else if (err instanceof NikaAPIError) {
    console.error('HTTP error:', err.status, err.body);
  } else if (err instanceof NikaError) {
    console.error('SDK error:', err.message);
  }
}
```

## SSE event types

| Type | Fields | Terminal |
|------|--------|----------|
| `started` | `job_id` | No |
| `task_start` | `job_id, task_id, verb` | No |
| `task_complete` | `job_id, task_id, duration_ms` | No |
| `task_failed` | `job_id, task_id, error, duration_ms` | No |
| `artifact_written` | `job_id, task_id, path, size` | No |
| `completed` | `job_id, output?` | Yes |
| `failed` | `job_id, error?` | Yes |
| `cancelled` | `job_id` | Yes |

Terminal events close the SSE stream automatically.

The SDK auto-reconnects on stream drops (up to 3 attempts), using the `Last-Event-Id` header to resume without losing events. Configure via `StreamOptions`:

```typescript
for await (const event of nika.jobs.stream(jobId, {
  maxReconnects: 5,
  reconnectDelay: 2000,
  idleTimeout: 120_000,
})) {
  // events are guaranteed in order, even across reconnects
}
```

## Links

- Engine: [github.com/supernovae-st/nika](https://github.com/supernovae-st/nika) (Rust, AGPL-3.0-or-later)
- Language spec: [github.com/supernovae-st/nika-spec](https://github.com/supernovae-st/nika-spec) (Apache-2.0)
- Docs: [docs.nika.sh](https://docs.nika.sh)
- Website: [nika.sh](https://nika.sh)
- Studio: [supernovae.studio](https://supernovae.studio)

## License

[AGPL-3.0-or-later](LICENSE)
