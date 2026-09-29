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
import { Nika, isNikaRunSucceeded } from '@supernovae-st/nika';

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
  for await (const event of run.events()) {
    // Lifecycle words; the protocol frame stays on event.raw. Only a named
    // state fact carries a status.
    console.log(event.kind, event.status ?? '');
  }
})();

const result = await run.result();
await watching;
if (!isNikaRunSucceeded(result)) throw new Error(`run ended ${result.status}`);
console.log(result.status, result.outputs, result.receipt);
```

Expected output: `run.started`, `task.scheduled`, `task.started`,
`task.completed`, `engine.event` (`workflow_completed` on `event.raw.kind`),
then `run.settled succeeded`, then the terminal `succeeded` line with the
outputs and the receipt.

<p align="center">
  <img src="https://raw.githubusercontent.com/supernovae-st/nika-client/main/media/local-driver.gif" alt="The typed driver over the released binary: check the workflow, gate on the report, run it to the end under a cost ceiling, count the events" width="960">
</p>

*Recorded by `scripts/media/render.sh` against this package and the released
engine; every line on screen is the SDK's own output. The recorded driver
predates the Run-owned lifecycle: it still calls `nika.events(run)`, a
deprecated wrapper that keeps working through the
[compatibility window](#migrating-to-the-run-owned-lifecycle), and the
`run.done` alias, which is not deprecated.*

Native checks and explicit local snapshot checks preserve the engine's
`findings[]` and `exitCode`. A check by served name returns the resident's
compact acknowledgement with `clean: true`, or its typed workflow refusal
with `clean: false`; it does not invent local findings or an exit code.

`run()` returns after stable admission, and the `NikaRun` it returns owns its
lifecycle: `run.events()`, `run.result()`, `run.status()` and `run.cancel()`.
`run.result()` is the sole terminal result (`run.done` is its compatibility
alias, the same promise).
An admitted workflow failure is result data with `status: "failed"` and, when
the engine named the failing task, `error: { code, message, task }`; transport,
protocol, configuration, and compatibility failures throw typed SDK errors.
A `try { await run.result() } catch {}` alone therefore never catches a failed
workflow: a CI job or an application must read `result.status`, or narrow it
with `isNikaRunSucceeded(result)`, and treat anything but `succeeded` as its
own failure, or a red run passes silently.

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

`Nika` exposes `compile`, `check`, `run`, `attachRun`, `traceVerify`,
`listWorkflows`, `workflow`, `schedule`, and `scheduleStatus`. Optional HTTP
cost review adds `prepareCostReview`, `costReview`, and `decideCostReview`.
`serverIdentity()` exposes the HTTP connection's validated protocol and
capability snapshot. The `NikaRun` that `run()` and `attachRun()` return owns
the run's lifecycle:

```
NikaRun
├── id
├── events()   one lifecycle vocabulary · event.raw keeps the protocol frame
├── result()   the one settlement · admitted failure is data, never a throw
├── status()   durable over HTTP · a typed refusal on a native process
└── cancel()   idempotent
```

`nika.events(run)`, `nika.cancel(run)` and `nika.status(run)` remain as
deprecated wrappers over the same session; see
[Migrating to the Run-owned lifecycle](#migrating-to-the-run-owned-lifecycle).
The handle owns observation, settlement, `status` and cancellation and nothing
else: checking, proof, catalogs and authoring stay on `Nika`.
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
const cancellation = await run.cancel();
const result = await run.result();

console.log(cancellation.accepted, result.status);
```

Cancellation is idempotent per `NikaRun`: every `run.cancel()` returns the one
request, and the deprecated `nika.cancel(run)` returns that same request. An
`AbortSignal` passed to `check`, `events`, or `traceVerify` only stops that
request or observer; it never stands in for `run.cancel()`.

Over HTTP a running job answers the request with 202: `cancellation` reads
`{ accepted: true, status: 'cancellation_requested' }` and `run.result()` settles
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
for await (const event of run.events()) {
  console.log(event.sequence, event.kind, event.status);
}
console.log(await run.result());
```

If the Node process restarts after admission, recover the durable job without
submitting the workflow again:

```ts
const recovered = await nika.attachRun(saved.jobId, {
  lastEventId: saved.lastEventSequence,
});
for await (const event of recovered.events()) {
  await saveApplicationCheckpoint(recovered.id, event.sequence);
}
console.log(await recovered.result());
```

Persist the job id and last committed sequence in application state. The
idempotency namespace spans the server's entire `state-root` and currently has
no TTL; use globally unique business keys and do not recycle them between
workflows.

When observation loses connectivity past its retry budget, the SDK performs
one final durable read before giving up: a terminal record settles
`run.result()` from the workflow's truth, and a still-running record rejects with
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
| `run.status()` | typed refusal; await `run.result()` | durable status projection |
| `run.events()` | lifecycle words over the engine's task and run frames | the same lifecycle words over sequenced SSE frames with bounded replay; no per-task frame |
| `run.cancel()` | signal-backed, idempotent | 200 settles the job; 202 accepts the request and `run.result()` settles on the resident's terminal |
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
- `eventBufferSize`: how many of a run's most recent frames a session retains
  for a view opened after the fact, and the largest `bufferSize` a view may
  ask for; default 4096. See [Observing a run after the fact](#observing-a-run-after-the-fact)
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
| `attachRun(id, options?)` | reattached durable HTTP `NikaRun`: the one recovery door |
| `status(run)` | deprecated: `run.status()` |
| `events(run, options?)` | deprecated: protocol frames; `run.events()` yields them on `event.raw` |
| `cancel(run)` | deprecated: `run.cancel()`, the same memoized request |
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

### `NikaRun`

| Member | Result |
|---|---|
| `run.id` | `NikaRunId`: the durable job id over HTTP, an ephemeral correlation id natively |
| `run.events(options?)` | bounded `AsyncIterable<NikaRunEvent>` in the lifecycle vocabulary |
| `run.result()` | `Promise<NikaRunResult>`, settled once; an admitted failure resolves |
| `run.status()` | current durable HTTP status; a typed refusal natively |
| `run.cancel()` | `NikaCancelResult`; idempotent |
| `run.done` | compatibility alias of `run.result()`: the same promise |

Every member is bound to its run, so it can be extracted:
`const { events, result } = run`. The handle is process-bound; it carries no
`list`, `search`, proof, catalog or authoring door. Every member is a view of
the one session that admitted the run: none of them admits, dispatches or
streams anything again.

### Observing a run after the fact

```ts
const run = await nika.run('wide.nika.yaml');
const result = await run.result();          // first the result,
for await (const event of run.events()) {}  // then every frame the session saw
```

A view opened late is seeded with every frame the session observed, or it is
refused. It is never handed a shortened replay. How many frames a session
retains is `eventBufferSize`, **4096 by default**.

On the released 0.118.7 engine, a clean run of N independent `mock/echo`
`infer` tasks wrote `workflow_started`, then `task_scheduled`, `task_started`
and `task_completed` per task, then `workflow_completed` and `run_settled`:
1 task is 6 frames, 90 tasks are 273. That is one measured shape, not a law of
N-task workflows; tools, retries, agents and failures write more. Count your
own run rather than deriving it: `error.observed` below is the number.

| `eventBufferSize` | frames retained | in the measured shape only |
|---|---|---|
| 256, the default up to 0.118.7 | 256 | below the 273 frames of the 90-task run |
| 4096, the default | 4096 | 15 times those 273 frames |

The bound is finite on purpose and is never `Infinity`. Every frame is bounded
by `machineBufferBytes` (64 KiB), so the retained history holds at most
`eventBufferSize × machineBufferBytes` of frame text: 4096 × 64 KiB = 256 MiB
per run at both defaults. That is arithmetic, not a measurement, and it bounds
the history only, never the session or the process. An explicit
`eventBufferSize` is kept exactly as given, so `eventBufferSize: 256` behaves
as it always did.

A run that writes more frames than the bound still runs and still succeeds:
`run.result()` resolves as usual and is never affected. Only a view is refused,
with `NikaEventBufferOverflowError`, and its `reason` says which of two
different bounds was exceeded:

| `error.reason` | What happened | What to do |
|---|---|---|
| `replay_truncated` | the view was opened after the run had produced more frames (`error.observed`) than it can be given (`error.limit`); `error.retained` is how many the session still holds | when `retained === observed` nothing is lost: open the view with `bufferSize >= observed`. Otherwise the earlier frames are gone from this process: set `eventBufferSize >= observed` for the next run, or observe it live |
| `live_backpressure` | a view that was observing live fell more than `error.limit` frames behind the stream | read faster, or raise that view's `bufferSize`. Other views and the result are unaffected |

```ts
try {
  for await (const event of run.events()) render(event);
} catch (error) {
  if (error instanceof NikaEventBufferOverflowError && error.reason === 'replay_truncated') {
    // The run is fine. Its history is longer than this view can replay.
    console.warn(`${error.observed} frames, ${error.retained} retained; run ${result.status}`);
  } else throw error;
}
```

Neither refusal skips a frame, and neither is about the run. `error.observed`
is a count taken when the view was opened. The engine's journal stays the
source of truth for a native trace (`receipt.trace_path`, `traceVerify`): a
late `run.events()` is a convenience over what this process already saw, and
the SDK reads no journal to extend it. Over HTTP the resident holds the job,
so recover there with `attachRun(id, { lastEventId })`.

### The lifecycle vocabulary

`run.events()` yields `NikaRunEvent`: a lifecycle `kind` that is the same on
both transports, plus the exact protocol frame on `raw`.

| `event.kind` | Native frame (`event.raw.kind`) | HTTP frame (`event.raw.kind`) |
|---|---|---|
| `run.started` | `workflow_started` | `execution.started` |
| `task.scheduled` · `task.started` · `task.completed` · `task.failed` | `task_scheduled` · `task_started` · `task_completed` · `task_failed` | none: the resident streams no per-task frame |
| `run.waiting` | `run_settled` carrying `paused` | `execution.settled` carrying `paused` |
| `run.settled` | `run_settled` carrying `succeeded` · `failed` · `cancelled` | `execution.settled` carrying `succeeded` · `failed` · `cancelled`; `execution.cancelled` carrying `cancelled` only; `execution.refused` carrying `failed` only |
| `run.interrupted` | `workflow_interrupted` carrying `interrupted` | `execution.interrupted` · `interrupted` carrying `interrupted` |
| `run.sealed` | `run_sealed` | none |
| `engine.event` | every other frame (`workflow_completed`, `workflow_paused`, `permit_checked`, …) | every other frame, a `null` or future kind included |

The SDK names a fact only when the engine wrote it. A frame that speaks of the
run's state earns its name only for a (kind, status) pair a producer defines;
the pairs are the ones listed above and nothing is computed from them. The
engine's state word decides and is never defaulted, so an absent, null, future
or still-running status stays an `engine.event`, and so does a terminal word
on the wrong dedicated kind. `event.raw` still holds that frame, and
`run.result()` still reads the state word the engine wrote. The projection
keeps no state between frames, deduplicates nothing, and never synthesizes an
event, so transports differ in cardinality but never in names.

```ts
for await (const event of run.events()) {
  switch (event.kind) {
    case 'run.started': break;
    case 'task.completed': console.log('done:', event.task); break;
    case 'task.failed': console.error(event.task, event.error?.code); break;
    case 'run.waiting': console.log('a human gate holds the run'); break;
    case 'run.settled': console.log('ended:', event.status); break;
    case 'run.interrupted': console.warn('the engine lost this execution'); break;
    default: break; // additive vocabulary: event.raw.kind names the frame
  }
}
```

`event.status` is always the engine's own word (a waiting run reads `paused`);
`event.task` is the task a `task.*` frame named; `event.error` is the failure
a `task.failed` frame or a `failed` settlement named, and no other state
carries one; `event.sequence` is the resident's replay cursor and exists only
over HTTP. An `engine.event` is given no lifecycle meaning: it carries its
cursor and `raw`, never a `status`.

`run.waiting` is not `run.settled`: a human gate holds a resumable run, which
has neither failed nor completed. `run.interrupted` is the engine's report
that it lost an execution, whose settlement is unknown; it is unrelated to
the thrown `NikaObservationInterrupted`, which means this client lost its view
of a run that may still be running.

### Migrating to the Run-owned lifecycle

The published 0.120 line of this package introduced the Run-owned lifecycle.
The client-level lifecycle methods are deprecated there and here, and stay:
they keep the ownership check, so a run this client did not create still
throws `NikaRunOwnershipError`, because there is no global run registry. Each
one is a view of the same session as the handle: no second run, stream or
request.

| Deprecated | Use | What changes |
|---|---|---|
| `nika.events(run, options?)` | `run.events(options?)` | lifecycle `kind`; the protocol frame the wrapper yields is `event.raw` |
| `nika.cancel(run)` | `run.cancel()` | nothing: the same memoized request |
| `nika.status(run)` | `run.status()` | nothing |
| `await run.done` | `await run.result()` | nothing: `done` stays as an alias of the same promise |

`nika.events(run)` still yields the protocol vocabulary exactly as before, so
existing consumers keep working unchanged while they migrate:

```ts
// before                                     // after
for await (const e of nika.events(run)) {     for await (const e of run.events()) {
  if (e.kind === 'workflow_started' ||          if (e.kind === 'run.started') start();
      e.kind === 'execution.started') start();
}                                             }
```

A program written against published 0.120.3 reads the same run handle,
lifecycle events, overflow reasons, default bound and `isNikaRunSucceeded`
here, the same `NikaCheckFinding` shape, and the same admission boundary: a
workflow the native engine refuses rejects `run()` itself, with no handle,
as it does over HTTP (see [Errors](#errors)). Its compile calls in the
published shape reach a resident the same way (see
[Authoring through the resident](#authoring-through-the-resident)). Where this
line still differs, such a program must not assume the published surface:

- `compile()` over a native process: published 0.120.3 compiles through the
  local engine; this line refuses with `NikaCompatibilityError` and compiles
  only through a resident.
- A request annotated with the type `NikaCompileRequest` names the typed V9
  request here; the published shapes are typed `NikaPublishedCompileRequest`.
- `run()` options: here `inputs`, `access` and `costReview` ride the HTTP
  by-name admission only, and an omitted HTTP `idempotencyKey` is generated;
  published 0.120.3 binds literal `inputs` on both transports and requires the
  HTTP key.

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
`{ timeoutMs: 600_000 }`, or your own `signal`, to set a waiting deadline: it
really aborts the wait and releases its timer when the compile ends.
Stopping that wait does not cancel an already dispatched provider call.
A lost answer may still be billed and may leave a kept round whose token
you never received; the SDK does not retry it. JSON body reads remain bounded.

The published 0.120 request shapes reach the same resident contract:

```ts
const outcome = await nika.compile('hello', { timeoutMs: 60_000 });
if (outcome.ready) await writeFile('hello.nika', outcome.candidate ?? '');

const edited = await nika.compile({
  workflow: acceptedSource,
  change: { set_constant: { name: 'limit', value: 10 } },
});
```

An intent string, `{ intent, answers? }` or `{ workflow, change, answers? }`
carries no `compile_version`, which is how `compile()` tells it from the
typed request. It is validated as published (an unknown field, a mixed create
and edit, or an answer that is not strict JSON refuses before any request),
sent once as the `compile_version: 1` wire (`mode` create, or edit with the
workflow as `source`), and resolves the outcome itself
(`NikaPublishedCompileOutcome`) with `ready` exactly `status === 'ready'`.
Fields the V9 contract adds, such as `requested_trigger` or a `choice`
question, stay on the outcome. The kept-round replay token is never handed
out on this door, as the published one never offered it: replay stays with
the typed request. A request that mixes the two shapes (a `compile_version`
beside a published `workflow` or a text `change`) is refused, never
reinterpreted. Without `timeoutMs` no client deadline applies; the published
package defaulted to its 30-second request timeout.

### Typed events, outputs, and identities

`NikaEvent` is the protocol frame under `event.raw` (and what the deprecated
`nika.events(run)` yields): a discriminated union over the known protocol
kinds of both transports. A native engine process emits `workflow_started`,
`task_scheduled`, `task_started`, `task_completed`, `workflow_completed`,
`workflow_failed`, `workflow_interrupted`, `run_settled`, and `run_sealed`. A
`nika serve` job streams `execution.started`, `execution.settled`,
`execution.cancelled`, `execution.refused`, and `execution.interrupted` (a
resident that restarts marks an orphaned running job `interrupted`). Kinds
this SDK version does not know yet stay representable through the
`NikaUnknownEvent` fallback, so the union is intentionally non-exhaustive and
every variant keeps its future fields open.

`run` and `attachRun` (and the deprecated `events(run)`) accept one `Outputs`
type argument. It types the terminal settlement — `run.result()` and, on the
protocol frame, the `run_settled` / `execution.settled` / `workflow_completed`
frames — without any runtime validation, and defaults to
`Record<string, unknown>` so untyped callers see no change:

```ts
const run = await nika.run<{ answer: number }>('flow.nika.yaml');
const result = await run.result();      // result.outputs?: { answer: number }

for await (const event of run.events()) {
  if (isNikaRunSettledEvent(event.raw)) {
    // The settlement frame of either transport (`run_settled` natively,
    // `execution.settled` over HTTP): status, outputs, and receipt typed
    // together on the one frame that carries all three.
    console.log(event.raw.status, event.raw.outputs?.answer, event.raw.receipt);
  }
}
```

The protocol guards read `event.raw`. A run can also end without settling
outputs — cancelled, refused, or interrupted. `isNikaTerminalEvent(event.raw)`
narrows those too: it reads the engine-reported `status` (`succeeded`,
`failed`, `interrupted`, `cancelled`) rather than the kind, so it holds on
either transport and on kinds this SDK version does not know yet:

```ts
for await (const event of run.events()) {
  if (isNikaTerminalEvent(event.raw)) {
    console.log('no further frames for this run:', event.raw.status);
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

`NikaEventBufferOverflowError` is never about the run: `run.result()` is
unaffected by it. Its `reason` tells a live view that fell behind
(`live_backpressure`) from a view opened after more frames than it can replay
(`replay_truncated`, with `observed` and `retained`); see
[Observing a run after the fact](#observing-a-run-after-the-fact).

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

A native engine refuses a workflow before admitting it: a red check, a cost
floor above `maxCostUsd`, a required input left unset, a file it cannot read.
`run()` then rejects, before any `NikaRun` exists, with a `NikaOperationError`
carrying `operation: 'run'` and the engine's exit status in `status`:

```ts
try {
  const run = await nika.run('./workflow.nika');
  const result = await run.result(); // admitted: a failure here is result data
} catch (error) {
  if (error instanceof NikaOperationError && error.operation === 'run') {
    console.error(error.code); // 'NIKA-AUTH-006'
    for (const finding of error.findings ?? []) console.error(finding.message);
  } else throw error;
}
```

- `code` is the engine's own code: the first check finding that names one, or
  the refusal's code (`NIKA-1709`, `NIKA-1708`). `machineCode` repeats it. When
  the engine named none, as for an unreadable file, `code` is the SDK's
  `run_refused` and `machineCode` is absent; the SDK never supplies an engine
  code.
- `findings` holds the engine's check findings untouched, as
  `NikaCheckFinding`. A budget or launch refusal has no findings.
- Nothing was admitted, so nothing else exists: no run id, no events, no
  trace, no receipt.

The engine's first machine frame decides, and the SDK judges nothing itself:
a run event is admission; an object without a `kind` is the refusal (a check
report with `clean: false`, or `{ "error": { code, message } }`); a line that
opens with a `NIKA-` code, or a refusal taught on stderr alone under exit 2 or
3, reads the same way. Output that proves neither (no frame, a line that is
not machine output, a truncated or oversized frame, more output after the
refusal, or a refusal that exits 0) rejects `run()` with `NikaProtocolError`,
and the engine process is stopped rather than left running.

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
