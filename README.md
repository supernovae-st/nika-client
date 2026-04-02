# @supernovae-st/nika-client

TypeScript client for the [Nika](https://github.com/SuperNovae-studio/nika) workflow engine HTTP API (`nika serve`).

- Zero runtime dependencies (uses native `fetch`)
- Full TypeScript types aligned with nika serve Rust source
- Automatic retry on 429/5xx with backoff
- Polling with exponential backoff for `run()`
- SSE streaming via `AsyncIterable`
- Node.js 18+

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
```

## Usage

### 1. Run a workflow and wait for completion

```typescript
const job = await nika.run('translate.nika.yaml', {
  file: 'ui.json',
  locale: 'fr_FR',
});

console.log(job.status);       // 'completed'
console.log(job.completed_at); // '2026-04-02T10:01:00Z'
```

### 2. Stream events in real time

```typescript
const { job_id } = await nika.submit('pipeline.nika.yaml', { topic: 'AI' });

for await (const event of nika.stream(job_id)) {
  console.log(event.type, event.task_id ?? '', event.duration_ms ?? '');
  // started
  // task_start step1 infer
  // task_complete step1 1200
  // completed
}
```

### 3. Run and collect all artifacts

```typescript
const artifacts = await nika.runAndCollect('research.nika.yaml', {
  topic: 'workflow engines',
});

console.log(artifacts['report.md']);   // markdown string
console.log(artifacts['data.json']);   // parsed JSON object
// binary artifacts (audio, images) are skipped
```

## API

### `new Nika(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | (required) | nika serve URL |
| `token` | `string` | (required) | Bearer token |
| `timeout` | `number` | `30000` | HTTP request timeout (ms) |
| `retries` | `number` | `2` | Retries on 429/5xx |
| `pollInterval` | `number` | `2000` | Initial poll interval (ms) |
| `pollTimeout` | `number` | `300000` | Max poll duration (ms) |
| `pollBackoff` | `number` | `1.5` | Poll backoff multiplier |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `health()` | `NikaHealth` | Health check (no auth) |
| `submit(workflow, inputs?, resumeFrom?)` | `RunResponse` | Submit workflow, return job ID |
| `status(jobId)` | `NikaJob` | Get job status |
| `cancel(jobId)` | `CancelResponse` | Cancel a running job |
| `run(workflow, inputs?, resumeFrom?)` | `NikaJob` | Submit + poll until done |
| `stream(jobId)` | `AsyncIterable<NikaEvent>` | SSE event stream |
| `artifacts(jobId)` | `NikaArtifact[]` | List job artifacts |
| `artifact(jobId, name)` | `string` | Download artifact as text |
| `artifactJson(jobId, name)` | `T` | Download artifact as JSON |
| `runAndCollect(workflow, inputs?)` | `Record<string, unknown>` | Run + collect all artifacts |

### Error classes

- `NikaError` — HTTP errors (status, code)
- `NikaJobError` — Job failed/cancelled (includes full job object)
- `NikaTimeoutError` — Polling timeout exceeded

### SSE event types

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

## License

MIT
