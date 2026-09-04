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

- Node.js 22 or newer (the tested floor; an older major is unsupported, not
  refused, and `npm install` does not warn about it)
- a compatible `nika` engine, resolved from `config.bin`, then `NIKA_BIN`
  (absolute paths only), then the exact optional platform package; a bare
  name or a relative path is refused because the operating system would
  resolve it through `PATH` or the working directory, and a `nika` found on
  `PATH` is deliberately never used
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
workflow intent and is the file passed to `check()` and `run()`. The scaffold
writes the engine's own annotated `01-hello` example (its task is named
`greet` and its prompt asks for French); the contract this README relies on is
the `outputs.greeting` key and the `mock/echo` model, and the same file can be
written by hand with this public envelope:

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
    // Native progress frames carry no status; only the terminal frame does.
    console.log(event.kind, event.status ?? '');
  }
})();

const result = await run.done;
await watching;
console.log(result.status, result.outputs, result.receipt);
```

Expected output: `workflow_started`, `task_scheduled`, `task_started`,
`task_completed`, `workflow_completed`, then `run_settled succeeded`, then the
terminal `succeeded` line with the outputs and the receipt.

A red `check()` report carries the engine's `findings[]` on both transports, so
the check → teach → re-draft loop reads one shape whether the engine runs
locally or behind `nika serve`.

`run()` returns after stable admission. `run.done` is the sole terminal result.
An admitted workflow failure is result data with `status: "failed"` and, when
the engine named the failing task, `error: { code, message, task }`; transport,
protocol, configuration, and compatibility failures throw typed SDK errors.
A `try { await run.done } catch {}` alone therefore never catches a failed
workflow: a CI job or an application must read `result.status` and treat
anything but `succeeded` as its own failure, or a red run passes silently.

## Verify a local trace

Local terminal results carry an engine-issued receipt when tracing is enabled.
Pass that receipt back unchanged:

```ts
if (!result.receipt) throw new Error('run did not issue a receipt');
const proof = await nika.traceVerify(result.receipt);
if (!proof.verified) throw new Error(proof.output ?? 'trace verification failed');
```

The SDK does not implement cryptography or inspect the trace itself. It asks the
engine to verify the receipt and its signed binding. A receipt from a native
run carries the proof-bearing fields (`chain_head`, `chain_len`, `sealed`,
`trace_path`) and verifies locally. A receipt from a `nika serve` job carries
identity only (`job_id`, `execution_id`, `trace_id`, `snapshot_digest`,
`origin`): the resident writes no trace journal yet, so that receipt verifies
through no door today, and the same `NikaReceipt` type covers both shapes.
Persist it as the job's identity, not as evidence. The remote endpoint
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

Remote admission has two forms and one door (engine 0.118+, ADR-131). A
contained name the resident lists (`GET /v1/workflows`, e.g.
`daily-brief.nika.yaml`) is submitted by name: the resident captures the
execution world itself and the SDK never hashes, so a client built from `url`
and `token` alone can `check` and `run` it with no local engine. A local path
(`./flow.nika.yaml`, an absolute path) is still captured through the local
engine, which prints the immutable execution snapshot the SDK then sends as
exact bytes; that capture is the one step that needs a local `nika` binary
through `bin`, `NIKA_BIN`, or the exact optional platform package, resolved
lazily at capture time. Observation-only clients need no local engine:
`attachRun`, `status`, `events`, `cancel`, `schedule`, `scheduleStatus`,
`listWorkflows`, `workflow`, and `traceVerify` run against the advertised
server identity alone.

The current persistent server requires a project file. If you ran
`nika init --project-file` above you already have one (it carries a default
cost ceiling); do not overwrite it. Otherwise a minimal `nika.yaml` is enough:

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
  // A local path needs the local engine; a served name needs neither of these.
  // cwd: process.cwd(),
  // bin: '/absolute/path/to/nika',
});

// A served name: the resident judges and captures it. `report` is its
// acknowledgement ({ clean: true, status, snapshot_digest, root, units }), or
// { clean: false, error: { code, message } } when it refuses the workflow.
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

Plain HTTP is accepted only for a loopback host (`localhost`, `127.0.0.0/8`,
`[::1]`), and only when `allowInsecureHttp: true` is explicit. Every other host
must use HTTPS: the opt-in widens the scheme, never the destination, so the
bearer token never leaves the machine in plaintext. A URL may not contain
credentials, a query, or a fragment, and a 32–512 byte visible-ASCII token is
mandatory.

Remote snapshots currently do not have request envelopes for per-call `vars`
or `model`; declare those facts in the workflow. There is no per-run spend
bound over HTTP at all today: `maxCostUsd` is refused, the workflow language
has no budget field, and the resident applies its own server-wide default
ceiling. Bound a remote run by its model and `max_tokens` until the request
envelope carries a ceiling. Likewise, remote `check` does not accept `model`
or `nativeStrict` overrides. Supplying these options returns a typed
compatibility refusal instead of silently dropping them.

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
`m/k`; `afterSkip` requires `overlap: "skip"` (the engine's default, so an
omitted `overlap` satisfies it); and `active: false` requires a `pauseReason`
together with a `pauseUntil` ISO calendar date (`YYYY-MM-DD`). Schedules refuse
`maxCostUsd: 0` ("must be positive and finite") where a native `run()` accepts
it; a scheduled budget is always a real number.

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

`NikaEvent` is a discriminated union over the known lifecycle kinds of both
transports. A native engine process emits `workflow_started`,
`task_scheduled`, `task_started`, `task_completed`, `workflow_completed`,
`workflow_failed`, `workflow_interrupted`, `run_settled`, and `run_sealed`. A
`nika serve` job streams `execution.started`, `execution.settled`,
`execution.cancelled`, `execution.refused`, and `execution.interrupted` (a
resident that restarts marks an orphaned running job `interrupted`). Kinds
this SDK version does not know yet stay representable through the
`NikaUnknownEvent` fallback, so the union is intentionally non-exhaustive and
every variant keeps its future fields open.

`run`, `attachRun`, and `events` accept one `Outputs` type argument. It types
the terminal settlement — `run.done` and the `run_settled` /
`execution.settled` / `workflow_completed` frames — without any runtime
validation, and defaults to `Record<string, unknown>` so untyped callers see
no change:

```ts
const run = await nika.run<{ answer: number }>('flow.nika.yaml');
const result = await run.done;          // result.outputs?: { answer: number }

for await (const event of nika.events(run)) {
  if (isNikaRunSettledEvent(event)) {
    // The settlement frame of either transport (`run_settled` natively,
    // `execution.settled` over HTTP): status, outputs, and receipt typed
    // together on the one frame that carries all three.
    console.log(event.status, event.outputs?.answer, event.receipt);
  }
}
```

A run can also end without settling outputs — cancelled, refused, or
interrupted. `isNikaTerminalEvent(event)` narrows those too: it reads the
engine-reported `status` (`succeeded`, `failed`, `interrupted`, `cancelled`)
rather than the kind, so it holds on either transport and on kinds this SDK
version does not know yet:

```ts
for await (const event of nika.events(run)) {
  if (isNikaTerminalEvent(event)) {
    console.log('no further frames for this run:', event.status);
  }
}
```

Run, execution, and job identities are branded opaque strings (`NikaRunId`,
`NikaExecutionId`, `NikaJobId`). They remain assignable to `string`, but a
plain `string` no longer stands in for one. Four words name three things:
a **workflow** is the file (or resident name) you pass in; a **run** is this
client's handle on one admission (`run.id`), and over HTTP that same string
is the server's **job** id (`/v1/jobs/{id}`, `attachRun(jobId)`); an
**execution** is the engine's own identity for what actually ran
(`execution_id`, the `execution.*` event kinds), distinct from the run id and
carried by the receipt together with the `trace_id`.

## Errors

Every error the SDK raises for an engine, transport, configuration, or
compatibility condition extends `NikaError`. Misuse of the API itself (an empty
workflow name, a negative event cursor, a receipt that is not an object, a
workflow name that escapes the catalog) throws a plain `TypeError` or
`RangeError` before any engine or network work starts:

```text
NikaError
├── NikaConfigurationError
├── NikaEngineUnavailable
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

A refusal that `nika serve` types as `{ error: { code, message } }` surfaces as
`NikaOperationError` with the HTTP `status`, the server `code` (for example
`unauthorized`, `job_not_found`, `idempotency_conflict`, `malformed_snapshot`,
or a stamped `NIKA-…` admission code) and the `operation` that was refused.
Server messages are engine-owned and path-free; a reflected bearer token is
redacted before it reaches an error message. A non-2xx answer without that
typed body stays a `NikaTransportError` whose body is redacted entirely.

An engine refusal printed before a run starts — a `NIKA-…` code line such as a
cost-floor refusal — settles `run.done` with a `NikaOperationError` carrying
`operation: 'run'`, the engine's code, and its full refusal line.

## Security boundaries

- Token files stay out of argv and must be private (`0600`, 32–512 visible
  ASCII bytes).
- The constructor refuses plaintext HTTP off loopback, and requires the
  explicit `allowInsecureHttp: true` opt-in on loopback.
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
