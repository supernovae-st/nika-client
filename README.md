<p align="center">
  <a href="https://nika.sh">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://nika.sh/brand/nika-logo-dark.svg">
      <img src="https://nika.sh/brand/nika-logo-light.svg" alt="Nika" width="220">
    </picture>
  </a>
</p>

<h1 align="center">@supernovae-st/nika-client</h1>

<p align="center"><strong>The TypeScript client for <a href="https://github.com/supernovae-st/nika">Nika</a>, the workflow language for AI.<br>
One file, 4 verbs, one binary. Typed, zero-dependency, honest about what ships today.</strong></p>

> **Status:** two modules. **`@supernovae-st/nika-client/local` works TODAY**:
> a typed, zero-dependency driver for the shipped binary (`check --json` ·
> `run --json` event stream · the dry-run plan object · `test` ·
> `trace verify`). The root module talks to **live `nika serve` HTTP**
> (`--bind` + `--workflows` + `--token-file`): `POST /v1/jobs`,
> `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/events`. Bare `nika serve` remains
> the resident cadence firer. Cancel and artifacts are **not** on this
> surface — those helpers throw rather than claim a 404.

Zero keys first — the shipped binary rehearses a canonical workflow
offline, nothing written, nothing owned (bare `nika try` lists them all):

```sh
nika try 01-hello
```

The same engine, driven typed from TypeScript:

```ts
import { LocalNika } from '@supernovae-st/nika-client/local';

const nika = new LocalNika();                       // PATH · or NIKA_BIN · or { bin }
const report = await nika.check('flow.nika.yaml');  // typed · report_version-guarded
if (report.clean && !report.cost?.has_unbounded) {
  const run = await nika.runToEnd('flow.nika.yaml', { maxCostUsd: 0.25 });
  console.log(run.ok, run.events.length);
}
```

![Eight lines of TypeScript: LocalNika checks the workflow, prints the typed clean verdict, then runs it to the end budget-capped over the released binary · recorded live, mock provider, zero keys](media/local-driver.gif)

Honesty is typed in: `cost.min_path_total_usd` is a FLOOR and
`has_unbounded` lives beside it; an unpriced model's `usd` stays `null`
(never coerced to 0); an unknown `report_version` degrades to warnings,
never throws; a parse-fatal file returns a typed PARSE finding on both
engine voices (the plain-text voice of pre-0.100 binaries and the JSON
form since). Where a method needs a newer engine than the binary
answering (`dryRunPlan()` → the machine dry-run, shipped in 0.100.0),
an older binary's refusal is translated into an error that names the
floor and the probed version · never a raw clap message.

**Nika workflows are contract-carrying, and this client is a thin, honest
window onto that contract, never its enforcer.** A `permits:` block in
the workflow declares a default-deny boundary over filesystem paths,
`net.http` hosts, `exec` programs and tool ids; an absent block means
zero extra authority beyond the engine's own hardened floor. The engine
enforces that boundary at runtime, not just at parse time, and this
SDK types the result: `LocalCheckReport.permits` and `LocalPlan.permits`
carry the declared/needed boundary before a run starts, `cost` carries
the honest floor above, and `runToEnd(..., { maxCostUsd })` refuses to
start past it. Every run can leave a hash-chained trace; `TraceVerdict`
types `nika trace verify`'s intact/broken/unchained result, never a raw
exit code. This repo's own CI pins every action by commit SHA and
checks against the latest released engine tag, never a floating `main`.

- Zero runtime dependencies (uses native `fetch`)
- Full TypeScript types pinned to live OpenAPI 3.1 (`openapi.json`)
- Namespace pattern: `nika.jobs.*`, `nika.workflows.*`
- 6 typed error classes with full hierarchy
- Automatic retry on 429/5xx with exponential backoff
- Client-side concurrency limiter (semaphore, default: 24)
- SSE streaming via `AsyncIterable` with idle timeout + auto-reconnect
- Honest refusals for cancel/artifacts (not on the live HTTP surface)
- Workflow list + metadata (no source bytes over HTTP)
- AbortSignal support on long-running operations
- Webhook HMAC-SHA256 verification (async, Web Crypto API)
- Dual CJS/ESM build
- Node.js 18+

## Install

```bash
npm install @supernovae-st/nika-client
```

## Quick start

```typescript
import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({
  url: 'http://127.0.0.1:8787',
  token: process.env.NIKA_TOKEN!,
});

// Submit + poll until succeeded. Body is { workflow } only.
const job = await nika.jobs.run('translate.nika.yaml');
console.log(job.status); // 'succeeded'
```

## Usage

### Run a workflow and wait for completion

```typescript
const job = await nika.jobs.run('pipeline.nika.yaml');
console.log(job.id, job.status); // uuid, 'succeeded'
```

### Stream events in real time (SSE)

```typescript
const { id } = await nika.jobs.submit('pipeline.nika.yaml');

for await (const event of nika.jobs.stream(id)) {
  console.log(event.sequence, event.kind, event.status);
}
```

### List workflows

```typescript
const names = await nika.workflows.list();
const meta = await nika.workflows.metadata('pipeline.nika.yaml');
```

### What is not on the wire yet

Cancel and artifacts stay 404 on the server. Those helpers throw
`NikaUnavailableError` instead of claiming the route. `POST /v1/jobs`
accepts `{ workflow }` only — inputs live in the workflow file or
go through `LocalNika`.

### Cancel a running job with AbortSignal

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const job = await nika.jobs.run('slow.nika.yaml', undefined, {
  signal: controller.signal,
});
```

### Custom fetch (logging middleware)

```typescript
const nika = new Nika({
  url: 'http://127.0.0.1:8787',
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

// Stripe-style HMAC-SHA256 verification (async, uses Web Crypto API)
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
| `url` | `string` | (required) | `nika serve --bind` URL (http/https) |
| `token` | `string` | (required) | Bearer token (`NIKA_TOKEN`) |
| `timeout` | `number` | `30000` | HTTP request timeout in ms |
| `retries` | `number` | `2` | Retries on 429/5xx |
| `concurrency` | `number` | `24` | Max concurrent HTTP requests |
| `pollInterval` | `number` | `2000` | Initial poll interval in ms |
| `pollTimeout` | `number` | `300000` | Max poll duration in ms |
| `pollBackoff` | `number` | `1.5` | Poll backoff multiplier |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch function |
| `logger` | `NikaLogger` | (none) | Logger interface (`debug`, `info`, `warn`, `error`) |

## API reference

### Jobs: `nika.jobs.*`

| Method | Returns | Description |
|--------|---------|-------------|
| `submit(workflow, inputs?, opts?)` | `NikaJob` | `POST /v1/jobs` `{ workflow }` + Idempotency-Key. `inputs` throws. |
| `status(jobId)` | `NikaJob` | `GET /v1/jobs/{id}` |
| `statusOnly(jobId)` | `JobStatusOnly` | `GET /v1/jobs/{id}/status` |
| `cancel(jobId)` | never | throws `NikaUnavailableError` (no live route) |
| `run(workflow, inputs?, opts?)` | `NikaJob` | submit + poll until succeeded/failed/interrupted |
| `stream(jobId, opts?)` | `AsyncIterable<NikaEvent>` | `GET /v1/jobs/{id}/events` |
| `artifacts` / `artifact*` / `runAndCollect` | never | throws `NikaUnavailableError` (no live route) |

### Workflows: `nika.workflows.*`

| Method | Returns | Description |
|--------|---------|-------------|
| `list()` | `string[]` | Contained `.nika.yaml` names |
| `listPage()` | `ListWorkflowsResponse` | Same payload (no pagination on the live server) |
| `metadata(name)` | `WorkflowMetadata` | Name only, no source bytes |
| `reload()` / `source(name)` | never | throws `NikaUnavailableError` |

### System

| Method | Returns | Description |
|--------|---------|-------------|
| `nika.health()` | `HealthResponse` | Health check (no auth required) |
| `Nika.verifyWebhook(body, sig, secret)` | `boolean` | Static: verify webhook HMAC-SHA256 |

## Error classes

All SDK errors extend `NikaError`. Catch it to handle any SDK error:

```
NikaError (base)
├── NikaAPIError          : HTTP errors (status, body, requestId)
├── NikaConnectionError   : Network errors (DNS, TCP, abort)
├── NikaTimeoutError      : Request or poll timeout
├── NikaUnavailableError  : helper for a route the live server keeps 404
└── NikaJobError          : Job failed or interrupted
    └── NikaJobCancelledError : exported; live HTTP never throws it
```

```typescript
import { NikaError, NikaAPIError, NikaJobError } from '@supernovae-st/nika-client';

try {
  await nika.jobs.run('pipeline.nika.yaml');
} catch (err) {
  if (err instanceof NikaJobError) {
    console.error('Job failed:', err.job.id, err.job.status, err.job.error);
  } else if (err instanceof NikaAPIError) {
    console.error('HTTP error:', err.status, err.body);
  } else if (err instanceof NikaError) {
    console.error('SDK error:', err.message);
  }
}
```

## SSE events

Each frame is `{ sequence, kind, status }`. A failed settled frame may
also carry redacted `{ code, message }` (NIKA diagnosis, no paths).
Terminal when `status` is `succeeded`, `failed`, or `interrupted`.
`paused` keeps the stream open.

The SDK auto-reconnects on stream drops (up to 3 attempts), using the
`Last-Event-ID` header to resume. Configure via `StreamOptions`:

```typescript
for await (const event of nika.jobs.stream(jobId, {
  maxReconnects: 5,
  reconnectDelay: 2000,
  idleTimeout: 120_000,
})) {
  // events are guaranteed in order, even across reconnects
}
```

<!-- engine hero pinned to the release tag it demonstrates · re-pin on lockstep bumps -->
![nika check audits the workflow (plan, permits, cost, secrets, types, the lethal-trifecta gate), then nika run executes it locally and seals the hash-chained trace — the audit-then-run story](https://raw.githubusercontent.com/supernovae-st/nika/v0.114.0/media/nika-hero.gif)

## Keeping it fresh · the lockstep

This package versions in lockstep with the engine's release train. CI warns
when the package and binary leave the same release line. When the binary
moves and a seat stays behind, one command names it:

```sh
nika doctor    # reads what this machine actually runs · names any kit
               # lagging the binary's train · prints the exact fix
```

Update gestures: `brew upgrade nika` for the binary ·
`npm update @supernovae-st/nika-client` for this package. Drift is
advisory (`nika doctor` warns · exit 0) and every fix line it prints
is copy-paste ready.

<!-- city:map -->
## The city · where this repo sits

```
📜 nika-spec ──── the civil code · the law tables, the corpus, the exam
    │ sync-pack: byte-gated mirror        │ projectors: drift-gated
    ▼                                     ▼
⚙️ nika ───────── the engine + the catalog (the yellow pages)
    │ the release train                  🖥️ nika.sh · 📖 nika-docs
    ▼                                     the showroom · the manual
📦 homebrew-tap · npm · Docker ── the docks
🔌 nika-client · 🎨 nika-vscode · 🤖 nika-plugins · ⚡ gh-nika ── the doors   ◀── you are here
🏭 nika-action · 🧪 nika-actions-starter ── the CI district
🏪 nika-registry ── the market · 🏛 nika-estate ── the land registry
```

**This building** · THE CODE DOOR · the TypeScript SDK; your program talks to the engine over HTTP/SSE.

**Root** · neither · this building speaks to the ENGINE's surface. Language facts come from nika-spec, engine behaviour from nika · nothing authoritative is typed here.

**Consumes** · the engine's serve API.

**Serves** · TS/JS applications (npm, published with provenance).

**Truth lives** · Apache-2.0, the adoption side of the license split · no copyleft crosses this door.

All the buildings: [nika-spec](https://github.com/supernovae-st/nika-spec) · [nika](https://github.com/supernovae-st/nika) · [nika.sh](https://github.com/supernovae-st/nika.sh) · [nika-docs](https://github.com/supernovae-st/nika-docs) · [nika-client](https://github.com/supernovae-st/nika-client) · [nika-vscode](https://github.com/supernovae-st/nika-vscode) · [nika-plugins](https://github.com/supernovae-st/nika-plugins) · [gh-nika](https://github.com/supernovae-st/gh-nika) · [homebrew-tap](https://github.com/supernovae-st/homebrew-tap) · [nika-action](https://github.com/supernovae-st/nika-action) · [nika-actions-starter](https://github.com/supernovae-st/nika-actions-starter) · [nika-registry](https://github.com/supernovae-st/nika-registry) · [nika-estate](https://github.com/supernovae-st/nika-estate)

Every fact has one home · everything else is a gated projection.
The living map: [nika.sh/map](https://nika.sh/map).
<!-- /city:map -->

## Links

- **Every door in one page**: install paths, IDEs, agents, skills, MCP, CI, SDKs: [docs.nika.sh/integrations/everywhere](https://docs.nika.sh/integrations/everywhere)
- Engine: [github.com/supernovae-st/nika](https://github.com/supernovae-st/nika) (Rust, AGPL-3.0-or-later)
- Language spec: [github.com/supernovae-st/nika-spec](https://github.com/supernovae-st/nika-spec) (Apache-2.0)
- Docs: [docs.nika.sh](https://docs.nika.sh)
- Website: [nika.sh](https://nika.sh)
- Timeline: [nika.sh/timeline](https://nika.sh/timeline) (the verifiable record — eras, releases, claims re-proven in CI)
- Studio: [supernovae.studio](https://supernovae.studio)

## License

[Apache-2.0](LICENSE): the adoption side of the Nika license split, same as
the [spec](https://github.com/supernovae-st/nika-spec). The engine stays
AGPL-3.0-or-later; this SDK talks to it over HTTP, and importing this package
carries no copyleft obligation for your code.

---

<p align="center">
  <sub>Docs: <a href="https://docs.nika.sh">docs.nika.sh</a> · Spec (Apache-2.0): <a href="https://github.com/supernovae-st/nika-spec">nika-spec</a> · Engine (AGPL-3.0): <a href="https://github.com/supernovae-st/nika">nika</a> · Template: <a href="https://github.com/supernovae-st/nika-actions-starter">nika-actions-starter</a></sub>
</p>
