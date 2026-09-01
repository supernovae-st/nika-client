<p align="center">
  <a href="https://nika.sh">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://nika.sh/brand/nika-logo-dark.svg">
      <img src="https://nika.sh/brand/nika-logo-light.svg" alt="Nika" width="220">
    </picture>
  </a>
</p>

<h1 align="center">@supernovae-st/nika-client</h1>

<p align="center"><strong>One TypeScript surface for local Nika processes and authenticated Nika servers.</strong></p>

`Nika` exposes one lifecycle vocabulary: `check`, `run`, `attachRun`, `status`, `events`,
`cancel`, `traceVerify`, `listWorkflows`, `workflow`, `schedule`, and
`scheduleStatus`.
The engine remains authoritative for parsing, admission, execution, receipts,
traces, permits, scheduling, and cost. The SDK transports those facts; it does
not parse YAML or reconstruct proof in TypeScript.

## Requirements

- Node.js 22 or newer
- a compatible `nika` engine, resolved from `config.bin`, then `NIKA_BIN`,
  then the exact optional platform package; implicit `PATH` lookup is refused
- a `.nika.yaml` workflow

## Documentation

- [Architecture](docs/architecture.md) — Modules, Interface, Seam, Adapters,
  lifecycle, and authority boundaries
- [HTTP contract](docs/http-api.md) — every live route, recovery, security,
  idempotency, and schedule CAS
- [Testing and release evidence](docs/testing.md) — layered gauntlets and the
  Socratic risk matrix
- [Migrating to 0.116](docs/migrating-to-0.116.md) — intentional breaking
  migration to the smaller durable client surface

## Install

```sh
npm view @supernovae-st/nika-client@0.116.2 version  # must report 0.116.2
npm install @supernovae-st/nika-client@0.116.2
```

If the registry reports any other version, the 0.116.2 release train is not
complete. Earlier packages expose the retired `LocalNika`/HTTP split and do
not implement the root facade documented below. The publication is complete
only when the four matching native payload packages and this root client are
all visible on npm.

Verify the package that the current project actually resolved:

```sh
node -p "require('@supernovae-st/nika-client/package.json').version"
```

This package metadata subpath is exported for CommonJS, ESM build tools and CI
pin checks. It reports the installed dependency, not a moving registry tag.

## First local run

The lowest-friction creation door is the engine-owned scaffold:

```sh
./node_modules/.bin/nika init --project-file
./node_modules/.bin/nika new 01-hello hello.nika.yaml
```

`nika.yaml` is the project control plane. `hello.nika.yaml` is executable
workflow intent and is the file passed to `check()` and `run()`. The generated
workflow has this public envelope:

```yaml
nika: sdk-hello
model: mock/echo
permits: {}
tasks:
  greeting:
    infer:
      prompt: "Say hello from the Nika SDK."
      max_tokens: 32
outputs:
  greeting: ${{ tasks.greeting.output }}
```

Then drive the installed engine:

```ts
import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({
  cwd: process.cwd(),
  // bin: '/absolute/path/to/nika', // or set NIKA_BIN
});

const report = await nika.check('hello.nika.yaml', {
  nativeStrict: true,
});
if (!report.clean) throw new Error('workflow did not pass nika check');

const run = await nika.run('hello.nika.yaml', { maxCostUsd: 0 });
const watching = (async () => {
  for await (const event of nika.events(run)) {
    console.log(event.kind, event.status);
  }
})();

const result = await run.done;
await watching;
console.log(result.status, result.outputs, result.receipt);
```

`run()` returns after stable admission. `run.done` is the sole terminal result.
An admitted workflow failure is result data with `status: "failed"`; transport,
protocol, configuration, and compatibility failures throw typed SDK errors.

## Verify a local trace

Local terminal results carry an engine-issued receipt when tracing is enabled.
Pass that receipt back unchanged:

```ts
if (!result.receipt) throw new Error('run did not issue a receipt');
const proof = await nika.traceVerify(result.receipt);
if (!proof.verified) throw new Error(proof.output ?? 'trace verification failed');
```

The SDK does not implement cryptography or inspect the trace itself. It asks the
engine to verify the receipt and its signed binding. The remote endpoint
currently returns `{ verified: false, verdict: "unavailable", reason:
"trace_journal_unavailable" }` because the server has no path-free journal
authority; the typed verdict is preserved instead of being hidden as a 404.
`/health.supportedCapabilities` names authorities that can currently complete
their operation. It therefore does not advertise remote trace verification
while this diagnostic route can only return the typed unavailable verdict.

Run-signing keys remain engine-owned. `nika key init`, `nika key trust`, and
`nika key rotate` manage their lifecycle. Nika prefers the OS keychain and uses
0600 files under `~/.nika/keys/` only as the local fallback; CI can inject an
explicit pair through `NIKA_RUN_KEY_FILE` and `NIKA_RUN_PUB_FILE`. Applications
should persist receipts and public trust material, never copy a private run key
into SDK configuration, source control, workflow inputs, or an HTTP request.

## Cancel a run

```ts
const run = await nika.run('slow.nika.yaml');
const cancellation = await nika.cancel(run);
const result = await run.done;

console.log(cancellation.accepted, result.status);
```

Cancellation is idempotent per `NikaRun`. An `AbortSignal` passed to `check`,
`events`, or `traceVerify` only stops that request or observer; it never stands
in for `cancel(run)`.

## Connect to `nika serve`

Remote admission is bytes-first: the local compatible engine captures an
immutable execution snapshot, then the SDK sends those exact bytes to the
authenticated server. Capturing those snapshots for `check` and `run`
therefore still needs a local `nika` binary through `bin`, `NIKA_BIN`, or the
exact optional platform package, resolved lazily at capture time.
Observation-only clients need no local engine: `attachRun`, `status`,
`events`, `cancel`, `schedule`, `scheduleStatus`, `listWorkflows`, `workflow`,
and `traceVerify` run against the advertised server identity alone.

The current persistent server requires a project file. A minimal `nika.yaml`
is enough:

```yaml
nika: my-project
```

Create a private bearer-token file and start the listener:

```sh
mkdir -p .nika
umask 077
openssl rand -hex 24 > .nika/serve.token
chmod 600 .nika/serve.token

nika serve \
  --bind 127.0.0.1:8787 \
  --workflows . \
  --token-file .nika/serve.token \
  --state-root .nika/serve
```

Connect from Node:

```ts
import { readFile } from 'node:fs/promises';
import { Nika } from '@supernovae-st/nika-client';

const token = (await readFile('.nika/serve.token', 'utf8')).trim();
const nika = new Nika({
  url: 'http://127.0.0.1:8787',
  token,
  allowInsecureHttp: true, // required for explicit loopback HTTP
  cwd: process.cwd(),
  // bin: '/absolute/path/to/nika',
});

const report = await nika.check('hello.nika.yaml');
const run = await nika.run('hello.nika.yaml', {
  idempotencyKey: 'hello-2026-08-30',
});
for await (const event of nika.events(run)) {
  console.log(event.sequence, event.kind, event.status);
}
console.log(await run.done);
```

If the Node process restarts after admission, recover the durable job without
submitting the workflow again:

```ts
const recovered = await nika.attachRun(saved.jobId, {
  lastEventId: saved.lastEventSequence,
});
for await (const event of nika.events(recovered)) {
  await saveApplicationCheckpoint(recovered.id, event.sequence);
}
console.log(await recovered.done);
```

Persist the job id and last committed sequence in application state. The
idempotency namespace spans the server's entire `state-root` and currently has
no TTL; use globally unique business keys and do not recycle them between
workflows.

When observation loses connectivity past its retry budget, the SDK performs
one final durable read before giving up: a terminal record settles `run.done`
from the workflow's truth, and a still-running record rejects with
`NikaObservationInterrupted`, whose `lastSequence` feeds
`attachRun(id, { lastEventId })` to resume.

Plain HTTP is refused unless `allowInsecureHttp: true` is explicit. Use HTTPS
for a non-loopback deployment. A URL may not contain credentials, a query, or a
fragment, and a 32–512 byte visible-ASCII token is mandatory.

Remote snapshots currently do not have request envelopes for per-call `vars`,
`model`, or `maxCostUsd`; declare those facts in the workflow. Likewise,
remote `check` does not accept `model` or `nativeStrict` overrides. Supplying
these options returns a typed compatibility refusal instead of silently
dropping them.

## Resident schedules

Scheduling belongs to the resident HTTP authority. A direct native-process
client refuses `schedule` and `scheduleStatus` because a short-lived process
cannot honestly own durable schedule state.

```ts
const applied = await nika.schedule('hello.nika.yaml', {
  id: 'weekday-hello',
  when: { kind: 'cadence', expression: 'TZ=Europe/Paris 0 9 * * 1-5' },
  maxCostUsd: 0.01,
  missed: 'catch-up-once',
  overlap: 'skip',
  afterSkip: 'next_slot',
});

const status = await nika.scheduleStatus('weekday-hello');
console.log(applied.changed, status.next, status.lastDecision);

await nika.schedule('hello.nika.yaml', {
  id: 'weekday-hello',
  when: { kind: 'cadence', expression: 'TZ=Europe/Paris 0 9 * * 1-5' },
  maxCostUsd: 0.01,
  missed: 'catch-up-once',
  overlap: 'skip',
  afterSkip: 'next_slot',
  revision: status.revision,
  active: false,
  pauseReason: 'maintenance',
  pauseUntil: '2026-09-01',
});
```

Creates use `If-None-Match: *`; updates use the exact prior revision through
`If-Match`. Revisions are the opaque `sha256:<64 lowercase hex>` values returned
by the engine; callers must not invent placeholders. Stale well-formed writers
receive a typed operation error with the current revision. Returned planning
facts are engine-owned and additive.

Treat any `status.finding` recovered from older state as non-runnable. New active
declarations the current engine cannot plan are refused before durable mutation.
Timed hash jitter is currently unsupported and returns a typed refusal.
Cron expressions carry their zone as `TZ=<IANA zone> ...`; `tolerance` uses
`m/k`; `afterSkip` requires `overlap: "skip"`; and `active: false` requires a
`pauseUntil` ISO calendar date (`YYYY-MM-DD`).

## Transport matrix

| Operation | Native process | HTTP |
|---|---|---|
| `check` | yes; `model` and `nativeStrict` allowed | yes; those two overrides refused |
| `run` | yes; `vars`, `model`, `maxCostUsd` allowed | yes; `idempotencyKey` allowed |
| `attachRun` | typed refusal | reattach to a durable job with an optional SSE cursor |
| `status` | typed refusal; await `run.done` | durable status projection |
| `events` | raw engine lifecycle frames | sequenced SSE frames with bounded replay |
| `cancel` | signal-backed, idempotent | durable server cancellation |
| `traceVerify` | engine verification + signed receipt binding | typed unavailable verdict until remote journal authority exists |
| `schedule` / `scheduleStatus` | typed refusal | resident schedule authority |
| `listWorkflows` / `workflow` | typed refusal | contained path-free workflow catalog |

Event vocabulary is deliberately open. Native execution exposes detailed task
lifecycle frames; HTTP exposes durable sequenced execution frames. Consumers
must not assume identical cardinality across transports.

## API

### `new Nika(config?)`

Shared options:

- `cwd`: engine working directory and snapshot root
- `bin`: explicit engine path
- `eventBufferSize`: per-client observer ceiling, default 256
- `machineBufferBytes`: machine frame/diagnostic ceiling, default 64 KiB

Remote-only options:

- `url`, `token`
- `allowInsecureHttp`
- `requestTimeout`, default 30 seconds
- `fetch`, for a custom standards-compatible implementation

### Methods

| Method | Result |
|---|---|
| `check(workflow, options?)` | engine check report, including `clean` and `exitCode` |
| `run(workflow, options?)` | admitted `NikaRun` |
| `attachRun(id, options?)` | reattached durable HTTP `NikaRun` |
| `status(run)` | current durable HTTP status |
| `events(run, options?)` | bounded `AsyncIterable<NikaEvent>` |
| `cancel(run)` | `NikaCancelResult` |
| `traceVerify(receipt, options?)` | `NikaTraceVerifyResult` |
| `schedule(workflow, options)` | durable apply acknowledgement |
| `scheduleStatus(id)` | fresh engine schedule projection |
| `listWorkflows()` | contained resident workflow names |
| `workflow(name)` | path-free resident workflow metadata |

### Typed events, outputs, and identities

`NikaEvent` is a discriminated union over the known lifecycle kinds
(`workflow_started`, `task_scheduled`, `task_started`, `task_completed`,
`workflow_completed`, `workflow_failed`, `workflow_interrupted`,
`run_settled`, `run_sealed`). Kinds this SDK version does not know yet stay
representable through the `NikaUnknownEvent` fallback, so the union is
intentionally non-exhaustive and every variant keeps its future fields open.

`run`, `attachRun`, and `events` accept one `Outputs` type argument. It types
the terminal settlement — `run.done` and the `run_settled` /
`workflow_completed` frames — without any runtime validation, and defaults to
`Record<string, unknown>` so untyped callers see no change:

```ts
const run = await nika.run<{ answer: number }>('flow.nika.yaml');
const result = await run.done;          // result.outputs?: { answer: number }

for await (const event of nika.events(run)) {
  if (isNikaRunSettledEvent(event)) {
    // event is NikaRunSettledEvent<{ answer: number }> here:
    // status, outputs, and receipt typed together on the terminal frame.
    console.log(event.status, event.outputs?.answer, event.receipt);
  }
}
```

Run, execution, and job identities are branded opaque strings (`NikaRunId`,
`NikaExecutionId`, `NikaJobId`). They remain assignable to `string`, but a
plain `string` no longer stands in for one.

## Errors

Every SDK error extends `NikaError`:

```text
NikaError
├── NikaConfigurationError
├── NikaTransportError
│   ├── NikaProtocolError
│   └── NikaObservationInterrupted
├── NikaCompatibilityError
├── NikaOperationError
├── NikaEventBufferOverflowError
└── NikaRunOwnershipError
```

Native engine event vocabulary stays open. HTTP events instead enforce the
closed, redacted `JobEvent` projection advertised by the pinned OpenAPI contract;
unknown HTTP fields are rejected at the trust boundary. The SDK never turns an
unpriced model into `$0`.

## Security boundaries

- Token files stay out of argv and must be private (`0600`, 32–512 visible
  ASCII bytes).
- The constructor refuses accidental plaintext HTTP.
- `permits` remain default-deny engine policy; SDK types do not grant authority.
- Machine frames, diagnostics, SSE lines, and observer queues are bounded.
- Receipts and traces are engine-issued proof. The SDK never synthesizes them.
- This package does not export a webhook-signature verifier. Verify webhook raw
  bodies with the sender's official library before admitting a Nika workflow.

## Development proof

```sh
npm test
npx tsc --noEmit
npm run build

# Five clean installations from an npm tarball
NIKA_BIN=/absolute/path/to/nika npm run gauntlet:projects

# Concurrency, cancellation, corrupt streams/traces, redaction, and soak
NIKA_BIN=/absolute/path/to/nika npm run gauntlet:hostile
```

The repository also carries 100 distinct use-case workflows and provider proof
under `gauntlet/`.

<!-- engine hero pinned to the release tag it demonstrates · re-pin on lockstep bumps -->
![nika check audits the workflow, then runs and seals its trace](https://raw.githubusercontent.com/supernovae-st/nika/v0.116.2/media/nika-hero.gif)

## Keeping it fresh

The client and engine follow one release train. `nika doctor` reports installed
drift without treating it as a workflow failure.

```sh
nika doctor
brew upgrade nika
npm update @supernovae-st/nika-client
```

<!-- city:map -->
## The city · where this repo sits

```text
📜 nika-spec ──── language law and conformance
    │
    ▼
⚙️ nika ───────── engine, admission, execution, receipts and schedules
    │
    ▼
🔌 nika-client ── this TypeScript door: native process or authenticated HTTP
    │
    ▼
🧩 Node.js applications
```

This repository consumes engine behavior and serves TypeScript/JavaScript
applications. It is not authoritative for the workflow language.

All the buildings: [nika-spec](https://github.com/supernovae-st/nika-spec) ·
[nika](https://github.com/supernovae-st/nika) ·
[nika.sh](https://github.com/supernovae-st/nika.sh) ·
[nika-docs](https://github.com/supernovae-st/nika-docs) ·
[nika-client](https://github.com/supernovae-st/nika-client) ·
[nika-vscode](https://github.com/supernovae-st/nika-vscode) ·
[nika-plugins](https://github.com/supernovae-st/nika-plugins) ·
[gh-nika](https://github.com/supernovae-st/gh-nika) ·
[homebrew-tap](https://github.com/supernovae-st/homebrew-tap) ·
[nika-action](https://github.com/supernovae-st/nika-action) ·
[nika-actions-starter](https://github.com/supernovae-st/nika-actions-starter) ·
[nika-registry](https://github.com/supernovae-st/nika-registry) ·
[nika-estate](https://github.com/supernovae-st/nika-estate).
<!-- /city:map -->

## License

[Apache-2.0](LICENSE). The engine remains AGPL-3.0-or-later; importing this SDK
does not impose the engine's copyleft license on your application.
