<p align="center">
  <a href="https://nika.sh">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://nika.sh/brand/nika-logo-dark.svg">
      <img src="https://nika.sh/brand/nika-logo-light.svg" alt="Nika" width="220">
    </picture>
  </a>
</p>

<h1 align="center">@supernovae-st/nika</h1>

<p align="center">
  <strong>The TypeScript door to Nika: audit a workflow, run it, watch it, prove it.</strong><br>
  Locally through the released engine, or against an authenticated <code>nika serve</code>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@supernovae-st/nika"><img src="https://img.shields.io/npm/v/@supernovae-st/nika?label=npm" alt="npm version"></a>
  <a href="https://github.com/supernovae-st/nika-client/actions/workflows/ci.yml"><img src="https://github.com/supernovae-st/nika-client/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://github.com/supernovae-st/nika/releases/latest"><img src="https://img.shields.io/github/v/release/supernovae-st/nika?label=engine" alt="Engine release"></a>
  <a href="https://docs.nika.sh"><img src="https://img.shields.io/badge/docs-docs.nika.sh-8b8cf8.svg" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0"></a>
</p>

<p align="center">
  <a href="https://scorecard.dev/viewer/?uri=github.com/supernovae-st/nika-client"><img src="https://api.scorecard.dev/projects/github.com/supernovae-st/nika-client/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.npmjs.com/package/@supernovae-st/nika"><img src="https://img.shields.io/badge/npm-provenance-2ea44f.svg" alt="Published with provenance through GitHub Actions trusted publishing"></a>
  <a href="https://www.npmjs.com/package/@supernovae-st/nika"><img src="https://img.shields.io/npm/dm/@supernovae-st/nika?label=downloads" alt="npm downloads"></a>
  <a href="https://archive.softwareheritage.org/browse/origin/?origin_url=https://github.com/supernovae-st/nika-client"><img src="https://archive.softwareheritage.org/badge/origin/https://github.com/supernovae-st/nika-client/" alt="Archived by Software Heritage"></a>
</p>

## Thirty seconds, no API key

One package installs the client, the `nika` command and the engine payload for
your platform (macOS and Linux, arm64 and x64):

```sh
npm install @supernovae-st/nika@0.118.7
./node_modules/.bin/nika --version
```

```
nika 0.118.7 (f3a31a6ee)
```

Write `hello.nika.yaml`. The `mock/echo` model rehearses with no key and no
network:

```yaml
nika: hello
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

Audit it before anything runs:

```sh
./node_modules/.bin/nika check hello.nika.yaml
```

```
 ✔ ORDER    no exec: sits downstream of a net-effecting task · unauthored content never reaches a shell
 ✔ PERMITS  literal + const: args fit the boundary · computed paths + symlinks are the RUN's verdict
 ✔ TRIFECTA no lethal trifecta over the declared permits: without a human gate
 ✔ JOURNEY internal · 0 sources · 0 destinations · 1 model endpoint · no secret reaches an external destination
 ✔ audited · 1 task · 1 wave · permits {} · est out ≤$0.0000 · 0 hints · risk low
 layers · valid ✔ · access ready ✔ · capacity fit ✔ · run ready ✔
```

Now drive the same engine from TypeScript:

```ts
import { Nika } from '@supernovae-st/nika';

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

<p align="center">
  <img src="https://raw.githubusercontent.com/supernovae-st/nika-client/main/media/local-driver.gif" alt="The typed driver over the released binary: check the workflow, gate on the report, run it to the end under a cost ceiling, count the events" width="960">
</p>

*Recorded by `scripts/media/render.sh` against this package and the released
engine; every line on screen is the SDK's own output.*

Native checks and explicit local snapshot checks preserve the engine's
`findings[]` and `exitCode`. A check by served name returns the resident's
compact acknowledgement with `clean: true`, or its typed workflow refusal
with `clean: false`; it does not invent local findings or an exit code.

`run()` returns after stable admission. `run.done` is the sole terminal result.
An admitted workflow failure is result data with `status: "failed"` and, when
the engine named the failing task, `error: { code, message, task }`; transport,
protocol, configuration, and compatibility failures throw typed SDK errors.
A `try { await run.done } catch {}` alone therefore never catches a failed
workflow: a CI job or an application must read `result.status` and treat
anything but `succeeded` as its own failure, or a red run passes silently.

## Why this door

- **Audited before it runs.** `check()` returns the engine's verdict on the
  order of effects, the permits, the lethal trifecta, the journey of every
  secret and the cost floor. A red check never becomes a run.
- **Sovereign by default.** The same file runs on local models (Ollama,
  llama.cpp, vLLM), on Mistral, Hugging Face, OpenAI, xAI, Anthropic and the
  rest of the engine's catalog; `mock/echo` rehearses with no key and no
  network.
- **Traced after.** Every native run leaves a hash-chained journal and hands
  back a receipt; `traceVerify()` asks the engine to verify it. The SDK never
  re-implements the proof.
- **One vocabulary, two transports.** `check`, `run`, `events`, `cancel`,
  `traceVerify` and `schedule` read the same against a local process and an
  authenticated `nika serve`; only the constructor changes.

## One vocabulary

`Nika` exposes one lifecycle vocabulary: `compile`, `check`, `run`, `attachRun`,
`status`, `events`, `cancel`, `traceVerify`, `listWorkflows`, `workflow`, `schedule`,
and `scheduleStatus`. Optional HTTP cost review adds `prepareCostReview`,
`costReview`, and `decideCostReview`. `serverIdentity()` exposes the HTTP
connection's validated protocol and capability snapshot.
The engine remains authoritative for parsing, admission, execution, receipts,
traces, permits, scheduling, and cost. The SDK transports those facts; it does
not parse YAML or reconstruct proof in TypeScript.

## Requirements

- Node.js 22 or newer (the tested floor; an older major is unsupported, not
  refused, and `npm install` does not warn about it)
- for native execution or local snapshot capture, a compatible `nika` engine, resolved from `config.bin`, then `NIKA_BIN`
  (absolute paths only), then the exact optional platform package; a bare
  name or a relative path is refused because the operating system would
  resolve it through `PATH` or the working directory, and a `nika` found on
  `PATH` is deliberately never used
- a `.nika.yaml` workflow

## Documentation

- [Architecture](docs/architecture.md) · Modules, Interface, Seam, Adapters,
  lifecycle, and authority boundaries
- [HTTP contract](docs/http-api.md) · every live route, recovery, security,
  idempotency, and schedule CAS
- [Testing and release evidence](docs/testing.md) · layered gauntlets and the
  Socratic risk matrix
- [Migrating to 0.116](docs/migrating-to-0.116.md) · the intentional breaking
  migration to the smaller durable client surface
- [docs.nika.sh](https://docs.nika.sh) · the language, the engine and the
  other doors

## Install

Pin the version you tested, then verify the package the project actually
resolved:

```sh
npm install @supernovae-st/nika@0.118.7
node -p "require('@supernovae-st/nika/package.json').version"
```

This package metadata subpath is exported for CommonJS, ESM build tools and CI
pin checks. It reports the installed dependency, not a moving registry tag.
The native payloads `@supernovae-st/nika-<os>-<arch>` are optional
dependencies; npm installs the one that matches your platform.

Earlier packages expose the retired `LocalNika`/HTTP split and do not
implement the root facade documented here. This package carries the product's
name: up to 0.115.0 it was published as `@supernovae-st/nika-client`, a name
that is deprecated on npm, stays installable for the versions it already holds
and receives no further releases. The repository keeps its name
(`supernovae-st/nika-client`).

## Scaffold with the engine

The lowest-friction creation door is the engine-owned scaffold:

```sh
./node_modules/.bin/nika init --project-file
./node_modules/.bin/nika new 01-hello hello.nika.yaml
```

`nika.yaml` is the project control plane. `hello.nika.yaml` is executable
workflow intent and is the file passed to `check()` and `run()`. The scaffold
writes the engine's own annotated `01-hello` example (its task is named
`greet` and its prompt asks for French); the contract this README relies on is
the `outputs.greeting` key and the `mock/echo` model, which the hand-written
file above satisfies too.

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
`origin`). The same `NikaReceipt` type covers both shapes, but their verification
claims differ. A resident with journal authority returns its CLI verdict and
the separate chain, seal, anchor and replay facts. HTTP `verified` is true for
a positive verdict bound to the receipt's `trace_id`, including `ok` with
`reason: "unsealed"`. It does not require a signature or prove the receipt's
other identity fields. Inspect the returned engine facts when your application
requires signing, anchoring, complete execution or replay; the boolean alone
establishes none of those stronger claims or business correctness.

Older residents, or jobs without an available journal, can return
`{ verified: false, verdict: "unavailable", reason: "trace_journal_unavailable" }`.
The SDK preserves this diagnostic rather than inventing proof. The server's
`/health.supportedCapabilities` describes its available authorities. Positive
HTTP tiers (`OK`, `SEALED`, `ANCHORED`, `REPLAYED`) are recognized without regard
to case; `INCOMPLETE` and `TAMPERED` do not hold. A positive tier may carry a
`reason`, and the original verdict and reason remain available.

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

Over HTTP a running job answers the request with 202: `cancellation` reads
`{ accepted: true, status: 'cancellation_requested' }` and `run.done` settles
on the terminal the resident records, `cancelled`, `succeeded`, `failed`, or
`interrupted` once its grace expired. A job that already ended replays its
result with `accepted: false` and `status: 'already_settled'`. The native
transport signals its process the same way and settles `interrupted`.

## Connect to `nika serve`

A contained workflow name such as `hello.nika.yaml` or
`daily/report.nika.yaml` is resolved by the resident registry. `check()` and
`run()` send that name without a local engine or a local workflow file.
Use `listWorkflows()` to discover the served names.

Use `serverIdentity()` to inspect the server's advertised capabilities before
offering an optional operation. It returns a detached copy of the client's
cached handshake without resolving a local engine. This is not a fresh health,
readiness, or authorization check; an operation can still be refused. Create a
new client to negotiate a new identity after changing the server.

To capture your local file instead, pass an explicit path such as
`./hello.nika.yaml`. The compatible local engine captures an immutable
snapshot, and the SDK sends its exact bytes and verifies the acknowledgement.
Only this path needs `bin`, `NIKA_BIN`, or the exact optional native package.
Observation and scheduling also use the server identity alone.

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
import { Nika } from '@supernovae-st/nika';

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
| `serverIdentity` | typed capability refusal | detached validated identity and advertised capabilities; cached per client |
| `compile` | typed capability refusal | engine-owned authoring request and outcome, optional kept-round token |
| `check` | yes; `model` and `nativeStrict` allowed | yes; those two overrides refused |
| `run` | yes; `vars`, `model`, `maxCostUsd` allowed | `idempotencyKey`; by-name admission also accepts typed `inputs`, `access`, and an explicit `costReview` reference |
| cost review | typed capability refusal | explicit preparation, observation, and decision with explicit V1 or V2 capability admission |
| `attachRun` | typed refusal | reattach to a durable job with an optional SSE cursor |
| `status` | typed refusal; await `run.done` | durable status projection |
| `events` | raw engine lifecycle frames | sequenced SSE frames with bounded replay |
| `cancel` | signal-backed, idempotent | 200 settles the job; 202 accepts the request and `run.done` settles on the resident's terminal |
| `traceVerify` | engine verification + signed receipt binding | journal verdict bound to `trace_id`; integrity and sealing remain separate; typed `unavailable` when no journal exists |
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
- `requestTimeout`, default 30 seconds; compile waits for the server response
  under the server's compile deadline instead. Use an explicit `AbortSignal` to
  stop waiting sooner. The ordinary timeout still bounds the response body.
- `fetch`, for a custom standards-compatible implementation

### Methods

| Method | Result |
|---|---|
| `serverIdentity()` | `NikaEngineIdentity`; cached HTTP protocol and capability snapshot |
| `compile(request, options?)` | `{ outcome, replayToken? }`; ready, incomplete and refused are data |
| `prepareCostReview(request, options?)` | review or `review_required: false`; never starts a job |
| `costReview(id, options?)` | current review; never renews it |
| `decideCostReview(id, decision, options?)` | explicit `approve_once` or `decline`; never starts a job |
| `check(workflow, options?)` | `clean` plus the native check report or resident acknowledgement/refusal |
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

Cost review can hold the project's cost lease and create or reconcile its cost
journal. Approval lasts within the original 300-second review lifetime and
requires a separate `run()` with the same workflow, inputs, access and witness.
The default review protocol stays V1. Pass `{ version: 2 }` to all three
review methods for finite fan-out and authored-retry bounds; the resident must
advertise `costReviewV2`. There is no version fallback.
The SDK never approves or retries automatically. See the
[cost review contract](docs/cost-review-contract.md) for capability and recovery rules.

### Authoring through the resident

```ts
const authored = await nika.compile({
  compile_version: 1,
  mode: 'create',
  intent: 'Read ./orders.csv and keep the paid rows in ./paid.csv',
});
console.log(authored.outcome.status, authored.outcome.questions);
```

Generation 1 is deterministic. Generation 2 requires the server's
`compileNativeV2` capability and the caller's explicit `cognition` choice.
The operator seats the model and its request grant; `limits.max_calls` can
only narrow that grant. The SDK returns the engine's outcome and keeps
requested and observed model identities in its authoring receipt. It does
not save, execute, answer questions or retry a lost authoring response.
`ready` describes a program for review, not permission to run it or a bound
schedule. See [the HTTP authoring contract](docs/http-api.md#authoring).

Compilation waits for the resident's authoring deadline; the ordinary
30-second HTTP admission timer does not cut a model round short. Pass
`{ signal: AbortSignal.timeout(600_000) }` to set your own waiting deadline.
Stopping that wait does not cancel an already dispatched provider call.
A lost answer may still be billed and may leave a kept round whose token
you never received; the SDK does not retry it. JSON body reads remain bounded.

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
![nika check audits the workflow, then runs and seals its trace](https://raw.githubusercontent.com/supernovae-st/nika/v0.118.7/media/nika-hero.gif)

## Keeping it fresh

The client and engine follow one release train. `nika doctor` reports installed
drift without treating it as a workflow failure.

```sh
nika doctor
brew upgrade nika
npm update @supernovae-st/nika
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
🔌 nika-client ── this door, published as @supernovae-st/nika: native process or authenticated HTTP
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
