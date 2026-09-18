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
for await (const event of run.events()) {
  // The same lifecycle words on both transports; the engine's own frame,
  // in its protocol vocabulary, stays on event.raw.
  console.log([event.kind, event.task, event.status].filter(Boolean).join(' '));
}

const result = await run.result();
console.log(result.status, result.outputs, result.receipt);
```

Expected output: `run.started`, `task.scheduled greeting`,
`task.started greeting`, `task.completed greeting`, `engine.event`, then
`run.settled succeeded`, then the terminal `succeeded` line with the outputs
and the receipt. The `engine.event` is the native journal's own
`workflow_completed` frame: the SDK gives it no lifecycle name and no state,
drops nothing, and shows it on `event.raw.kind`.

That is six frames for one task; the same shape with 90 tasks was measured at
273 (`3N + 3`). A session retains the most recent 4096 frames by default, so
`run.events()` opened after `run.result()` replays them all, and is refused,
never shortened, past that bound; see
[Observing a run after the fact](#observing-a-run-after-the-fact).

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
A workflow the engine refuses before admission never yields a run: `run()`
itself rejects with a `NikaOperationError` that names the engine's code and,
for a red check, carries its `findings[]` (see [Errors](#errors)). The engine
checks on every run, so no `check()` is needed first to be protected or taught.

### Workflow inputs

`inputs` binds the workflow's declared `inputs:` by name, and means the same
thing on both transports:

```ts
const run = await nika.run('support-triage.nika.yaml', {
  inputs: { ticketId: '42' },
  // idempotencyKey: `triage-${ticket.id}`, // HTTP only
});
```

Values are strict JSON and stay literal. `'42'` stays a string and `42` a
number; `'@env:HOME'` and `'${{ tasks.x.output }}'` are text, never read from
the environment or evaluated; nothing is coerced to the declared type. The
engine owns the verdict and refuses before any run exists: an undeclared key
(`unknown_input`), a value that does not fit its declared type
(`input_type_mismatch`), a required input left out (`NIKA-1708`). Each rejects
`run()` as a `NikaOperationError` with that code, native (`status: 3`) or HTTP
(`status: 422`). Supplied values are recorded with `api-caller` provenance;
declared defaults keep `file`.

The SDK refuses, before it spawns or sends anything, a value JSON would
silently lose: `undefined`, a function, a symbol, a bigint, `NaN` or
`Infinity`, a cycle, a class instance (a `Date`, a `Map`), an array hole, an
accessor. That is a `NikaConfigurationError` naming the path
(`inputs.ticket.tags[1] is undefined`), never the value. The serialized map is
bounded at 1 MiB on both transports. Do not put a secret in `inputs`.

The engine must advertise the channel, and the SDK checks before admission:

- Native: `inputsLiteral` in `nika --sdk-identity`. The map rides the engine's
  stdin (`nika run --inputs-json -`), so a value never appears in a process
  listing.
- HTTP: `jobInputs` in `GET /health`, for a workflow run by its served name.
  An execution snapshot froze its inputs and takes no overlay, so an HTTP run
  of a local path (`./flow.nika.yaml`) refuses `inputs`, an empty map included.

An engine without the capability rejects with `NikaCompatibilityError`
(`capability: 'inputsLiteral'` or `'jobInputs'`) and nothing runs. The SDK
never falls back to `--var`, and a resident that merely answers 202 has
negotiated nothing: one from before the envelope accepts the field and ignores
its values. The engine payload pinned by this package version advertises
neither capability yet, so `inputs` is refused on it until the pin moves.

`vars` is deprecated. It remains the native `--var KEY=VALUE` operator channel,
unchanged: the engine reads `@env:NAME` from its environment and coerces text
to the declared type, so it cannot carry literal values and has no HTTP form.
`inputs` and `vars` together reject `run()`; they are never merged.
An admitted workflow failure is result data with `status: "failed"` and, when
the engine named the failing task, `error: { code, message, task }`; transport,
protocol, configuration, and compatibility failures throw typed SDK errors.
A `try { await run.result() } catch {}` alone therefore never catches a failed
workflow: a CI job or an application must read `result.status` and treat
anything but `succeeded` as its own failure, or a red run passes silently.

On the development branch, `isNikaRunSucceeded` provides that TypeScript
narrowing. It is **unreleased** and is not exported by the published
`0.118.7` package; that package uses `result.status === 'succeeded'` directly.
For CI built from this branch:

```ts
import { Nika, isNikaRunSucceeded } from '@supernovae-st/nika';

const run = await new Nika().run<{ answer: number }>('flow.nika.yaml');
const result = await run.result();
if (isNikaRunSucceeded(result)) {
  console.log(result.outputs?.answer); // outputs stay typed and optional
} else {
  console.error(result.status, result.error?.code, result.error?.message);
  process.exitCode = 1;
}
```

A paused result is a human gate, not a successful completion and not a
failure. It arrives as a `run.waiting` event, never as `run.settled`, and
`result.status` keeps the engine's word, `paused`. Applications can render
that state separately; a CI job awaiting completion must not pass it as
success. The guard reads the engine's status and never turns absent outputs
into a fabricated output map.

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
  authenticated `nika serve`; only the constructor changes. Run events carry
  the same lifecycle words on both (`run.started`, `run.waiting`,
  `run.settled`), with the engine's own frame kept on `event.raw`.

## One vocabulary

`Nika` exposes `check`, `run`, `attachRun`, `traceVerify`, `listWorkflows`,
`workflow`, `schedule`, and `scheduleStatus`. The `NikaRun` it returns owns the
run's lifecycle:

```
NikaRun
├── id
├── events()   one lifecycle vocabulary · event.raw keeps the protocol frame
├── result()   the one settlement · admitted failure is data, never a throw
├── status()   durable over HTTP · a typed refusal on a native process
└── cancel()   idempotent
```

`nika.events(run)`, `nika.cancel(run)` and `nika.status(run)` remain as
deprecated wrappers for one release train, counted from the first published
train that carries this API; see
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
name: up to 0.115.0 it was published as `@supernovae-st/nika-client`. That
name receives no further releases from this repository and stays installable
for the versions it already holds. It is **not** marked deprecated on the npm
registry: its published versions carry no `deprecated` field, so `npm install
@supernovae-st/nika-client` still succeeds without a warning and installs the
retired 0.115.0 API. The move to the new name says nothing about the
registry; check it yourself with `npm view @supernovae-st/nika-client
deprecated`. The repository keeps its name (`supernovae-st/nika-client`).

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
`origin`): the resident writes no trace journal yet, so that receipt verifies
through no door today, and the same `NikaReceipt` type covers both shapes.
Persist it as the job's identity, not as evidence. The remote endpoint
currently returns `{ verified: false, verdict: "unavailable", reason:
"trace_journal_unavailable" }` because the server has no path-free journal
authority; the typed verdict is preserved instead of being hidden as a 404.
`/health.supportedCapabilities` names authorities that can currently complete
their operation. It therefore does not advertise remote trace verification
while this diagnostic route can only return the typed unavailable verdict.
A resident with journal authority will answer the CLI's tiers (`OK`, `SEALED`,
`ANCHORED`, `REPLAYED` hold; `INCOMPLETE`, `TAMPERED` do not), with no
`reason` on a verdict that holds; `verified` reads them the same way.

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
request. An `AbortSignal` passed to `check`, `events`, or `traceVerify` only
stops that request or observer; it never stands in for `run.cancel()`.

Over HTTP a running job answers the request with 202: `cancellation` reads
`{ accepted: true, status: 'cancellation_requested' }` and `run.result()`
settles on the terminal the resident records, `cancelled`, `succeeded`,
`failed`, or `interrupted` once its grace expired. A job that already ended
replays its result with `accepted: false` and `status: 'already_settled'`. The
native transport signals its process the same way; the result is whatever the
engine then wrote, `cancelled` when it settled the request (the released
0.118.7 engine does), or `interrupted` when the process ended with no
settlement frame.

## Connect to `nika serve`

A contained workflow name such as `hello.nika.yaml` or
`daily/report.nika.yaml` is resolved by the resident registry. `check()` and
`run()` send that name without a local engine or a local workflow file.
Use `listWorkflows()` to discover the served names.

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
  idempotencyKey: 'hello-2026-08-30', // persist before admission; reuse on retry
});
for await (const event of run.events()) {
  console.log(event.sequence, event.kind, event.status);
}
console.log(await run.result());
```

The application code after `new Nika(...)` is the same as the local one: the
events read `run.started` then `run.settled`, in the same words. The resident
streams no per-task frame today, so an HTTP run yields no `task.*` event; the
SDK never invents one. `event.sequence` is the resident's replay cursor and
exists only over HTTP.

HTTP `run()` requires a caller-owned `idempotencyKey` before it sends a request.
Persist a unique key for each business operation. If the response is lost or times
out, retry the same request with that key; a new key can admit a second job.
Direct native runs omit the key and reject one if supplied.

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

`attachRun` is the one recovery door, and it returns a full `NikaRun`. A run
handle is process-bound and is not serialized: persist the **job id** and the
last committed `event.sequence` in application state. That id is durable only
over HTTP, where `run.id` is the resident's job id. A native `run.id` is an
ephemeral correlation id of the SDK process: it appears in no journal, cannot
be recovered after the process ends, and `attachRun` refuses it. The
idempotency namespace spans the server's entire `state-root` and currently has
no TTL; use globally unique business keys and do not recycle them between
workflows.

When observation loses connectivity past its retry budget, the SDK performs
one final durable read before giving up: a terminal record settles
`run.result()` from the workflow's truth, and a still-running record rejects
with `NikaObservationInterrupted`, whose `lastSequence` feeds
`attachRun(id, { lastEventId })` to resume. That error is about this client's
view, not about the run, which may still be running. It is not the engine's
own `interrupted` state: a resident that lost an execution says so with a
`run.interrupted` event and `result.status === 'interrupted'`, as data.

Plain HTTP is accepted only for a loopback host (`localhost`, `127.0.0.0/8`,
`[::1]`), and only when `allowInsecureHttp: true` is explicit. Every other host
must use HTTPS: the opt-in widens the scheme, never the destination, so the
bearer token never leaves the machine in plaintext. A URL may not contain
credentials, a query, or a fragment, and a 32–512 byte visible-ASCII token is
mandatory.

A remote run by served name carries per-call `inputs` once the resident
advertises `jobInputs` (see [Workflow inputs](#workflow-inputs)); a snapshot
takes none. There is no request envelope for `model`, and none for the
deprecated `vars`: declare a model in the workflow. There is no per-run spend
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
| `run` | yes; `model`, `maxCostUsd` allowed | yes; `idempotencyKey` required; `model`, `maxCostUsd` refused |
| `run` `inputs` | literal JSON over stdin; engine must advertise `inputsLiteral` | literal JSON by served name; resident must advertise `jobInputs`; a snapshot refuses them |
| `run` `vars` (deprecated) | the `--var` operator channel, unchanged | typed refusal |
| `attachRun` | typed refusal: a native run is process-bound | reattach to a durable job with an optional SSE cursor |
| `run.status()` | typed refusal; await `run.result()` | durable status projection |
| `run.events()` | lifecycle words over the engine's task and run frames | the same lifecycle words over sequenced SSE frames with bounded replay; no per-task frame |
| `run.cancel()` | signal-backed, idempotent | 200 settles the job; 202 accepts the request and `run.result()` settles on the resident's terminal |
| `run.id` | ephemeral correlation id; never durable | the resident's durable job id; the one to persist |
| `traceVerify` | engine verification + signed receipt binding | typed verdict: `unavailable` until remote journal authority exists, then the CLI's tiers |
| `schedule` / `scheduleStatus` | typed refusal | resident schedule authority |
| `listWorkflows` / `workflow` | typed refusal | contained path-free workflow catalog |

The lifecycle vocabulary is one; the cardinality is not. Native execution
exposes detailed task frames, HTTP exposes durable sequenced execution frames,
and the SDK names only the facts a transport actually emitted. Consumers must
not assume identical cardinality across transports. The protocol vocabulary
under `event.raw` stays deliberately open.

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
- `requestTimeout`, default 30 seconds
- `fetch`, for a custom standards-compatible implementation

### Methods

| Method | Result |
|---|---|
| `check(workflow, options?)` | `clean` plus the native check report or resident acknowledgement/refusal |
| `run(workflow, options?)` | admitted `NikaRun`; rejects without one when the engine refuses |
| `attachRun(id, options?)` | reattached durable HTTP `NikaRun`: the one recovery door |
| `traceVerify(receipt, options?)` | `NikaTraceVerifyResult` |
| `schedule(workflow, options)` | durable apply acknowledgement |
| `scheduleStatus(id)` | fresh engine schedule projection |
| `listWorkflows()` | contained resident workflow names |
| `workflow(name)` | path-free resident workflow metadata |

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
`list`, `search`, proof, catalog or authoring door.

### Observing a run after the fact

```ts
const run = await nika.run('wide.nika.yaml');
const result = await run.result();          // first the result,
for await (const event of run.events()) {}  // then every frame the session saw
```

A view opened late is seeded with every frame the session observed, or it is
refused. It is never handed a shortened replay. How many frames a session
retains is `eventBufferSize`, **4096 by default**.

**The measured frame count: `3N + 3`, for one shape.** On the released 0.118.7
engine, a clean run of N independent `mock/echo` `infer` tasks wrote
`workflow_started`, then `task_scheduled`, `task_started` and `task_completed`
per task, then `workflow_completed` and `run_settled`. Two points were
measured: 1 task is 6 frames, 90 tasks are 273. That is this fixture, not a
law of N-task workflows. Other shapes write more: a `nika:wait` task and a
`nika:assert` task each showed one extra `permit_checked` frame, a failed task
writes `task_failed`, and retries, agents and `for_each` were not measured.
Count your own run rather than deriving it: `error.observed` below is the
number. A `nika serve` job was measured at two frames, so the bound matters on
a native process.

| `eventBufferSize` | frames retained | in the measured shape only |
|---|---|---|
| 256, the default up to 0.118.7 | 256 | below the 273 frames of the 90-task run |
| 4096, the default | 4096 | 15 times those 273 frames |

**What the bound costs.** It is finite on purpose and is never `Infinity`.
Every frame is bounded by `machineBufferBytes` (64 KiB), so the retained
**history** holds at most `eventBufferSize × machineBufferBytes` of frame text:
4096 × 64 KiB = 256 MiB per run at both defaults, where 256 frames gave
16 MiB. That is arithmetic, not a measurement: the 273 measured frames total
0.15 MiB (mean 571 bytes, largest 1501). It bounds the history only, not the
session or the process: a frame already handed to your code lives as long as
you keep it, and every open view and every concurrent run adds its own. Nothing
here is a claim about heap or process memory. If that ceiling matters to you,
set `eventBufferSize` yourself: an explicit value is kept exactly as given, so
`eventBufferSize: 256` behaves as it always did.

**Past the bound.** A run that writes more frames than the bound still runs and
still succeeds: `run.result()` resolves as usual and is never affected. Only a
view is refused, with `NikaEventBufferOverflowError`, and its `reason` says
which of two different bounds was exceeded:

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
on the wrong dedicated kind: `execution.refused` carrying `succeeded` or
`cancelled`, or `execution.cancelled` carrying `succeeded` or `failed`,
contradicts itself and is never called settled. `event.raw` still holds that
frame, and `run.result()` still reads the state word the engine wrote. The
projection keeps no state between frames, deduplicates nothing, and never
synthesizes an event, so transports differ in cardinality but never in names.

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
over HTTP.
An `engine.event` is given no lifecycle meaning: it carries its cursor and
`raw`, never a `status`.

`run.waiting` is not `run.settled`: a human gate holds a resumable run, which
has neither failed nor completed. `run.interrupted` is the engine's report
that it lost an execution, whose settlement is unknown; it is unrelated to
the thrown `NikaObservationInterrupted`, which means this client lost its view
of a run that may still be running.

### Migrating to the Run-owned lifecycle

The client-level lifecycle methods are deprecated and stay for one release
train. They keep the ownership check: a run this client did not create still
throws `NikaRunOwnershipError`, because there is no global run registry.

**The compatibility window.** A release train is one published
SDK-and-engine version, the meaning this repository already uses (see
[Keeping it fresh](#keeping-it-fresh)). The window is counted from
publication, never from a merge:

1. It opens with the first train **published to npm** whose package carries
   the Run-owned lifecycle. That train ships the wrappers, unchanged, next to
   the new API.
2. The earliest train that may remove them is the one **after** it. Removal
   is not automatic: it is decided by the One SDK baseline owner
   ([#114](https://github.com/supernovae-st/nika-client/issues/114)) and is
   announced in the release notes of the train that performs it.
3. No version and no date are fixed here. Until a train carrying this API is
   published, nothing has started counting and the wrappers stay.

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

### Typed protocol events, outputs, and identities

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

`run` and `attachRun` accept one `Outputs` type argument. It types the
terminal settlement — `run.result()` and, on the protocol frame, the
`run_settled` / `execution.settled` / `workflow_completed` frames — without
any runtime validation, and defaults to `Record<string, unknown>` so untyped
callers see no change:

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
  const run = await nika.run('./workflow.nika.yaml');
  const result = await run.result(); // admitted: a failure here is result data
} catch (error) {
  if (error instanceof NikaOperationError && error.operation === 'run') {
    console.error(error.code); // 'NIKA-SEC-004'
    for (const finding of error.findings ?? []) console.error(finding.message);
  } else throw error;
}
```

- `code` is the engine's own code: the first check finding that names one
  (`NIKA-SEC-004`, `NIKA-PARSE-005`, `NIKA-AUTH-006`, …) or the refusal's code
  (`NIKA-1709`, `NIKA-1708`). `machineCode` repeats it. When the engine named
  none, as for an unreadable file, `code` is the SDK's `run_refused` and
  `machineCode` is absent; the SDK never supplies an engine code.
- `findings` holds the engine's check findings untouched, as
  `NikaCheckFinding` (`code?`, `message`, `severity`, `gate`, `kind`, `task`,
  `docs_url`). A budget or launch refusal has no findings.
- Nothing was admitted, so nothing else exists: no run id, no events, no
  trace, no receipt.

Output that proves neither an admission nor a refusal (a line that is not
machine output, a truncated or oversized report, an engine that exits without
a frame) rejects `run()` with `NikaProtocolError` instead.

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
