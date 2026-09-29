# Testing and release evidence

The release judge is the packed package consumed from an isolated Node
project, not a source import. Local development still starts with the fast
gates:

```sh
npm ci
npm test
npm run build
npm run check:coverage
npm run check:release-evidence
NIKA_BIN=/path/to/nika npm run gauntlet:check
NIKA_BIN=/path/to/nika npm run gauntlet:run
NIKA_BIN=/path/to/nika npm run gauntlet:projects
NIKA_BIN=/path/to/nika npm run gauntlet:depth
NIKA_BIN=/path/to/nika npm run gauntlet:hostile
NIKA_BIN=/path/to/nika npm run gauntlet:recovery
NIKA_BIN=/path/to/nika npm run gauntlet:one-door
npm audit
npm pack --dry-run
```

All engine-backed gauntlets use `NIKA_BIN` as the canonical explicit binary.
`NIKA_GAUNTLET_BIN` remains a compatibility fallback for the corpus-only
scripts. Evidence is invalid when the recorded engine identity does not match
the intended release candidate. `npm run check:release-evidence` binds every
current committed gauntlet result and packed tarball identity to the root
package version. Historical ledgers are limited to an explicit allowlist and
must remain labelled as non-gating evidence.

CI adds a behavioral provenance replay. It downloads the Linux x64 asset for
the exact root package version, verifies its GitHub attestation and published
`SHA256SUMS` entry, then reruns all 100 deterministic workflows, the hostile suite, all five mini-SaaS projects, all five depth projects,
the two-process recovery scenario, and five scenarios through six execution
doors from a freshly packed SDK. The runner
mints an ephemeral run-signing key. Its
cancellation fixtures retain the in-process `nika:wait` cases and add an
owned loopback rendezvous for controlled task-boundary cancellation. They
need no shell command, platform sandbox, or sandbox waiver. Cancellation
and sealed-trace claims are exercised against the public binary. The
cancellation fixtures cancel an execution that is observably inside its 10 s
`nika:wait` (the durable status reads `running`, no longer `queued`, and a
further delay has passed) and record both the cancel reply and the terminal it
leads to. On engine 0.118 the resident answers 202 `cancellation_requested`;
its execution owner then records `execution.interrupted` with
`status=interrupted` once the grace expires inside a task, or, when the request
lands at a task boundary, `execution.cancelled` (the `cancel_job` writer) or
`execution.settled` (the racing settlement writer) with `status=cancelled` and a
settlement whose cause is `operator`. A cancel that lands before the execution
starts is a 200 `cancelled` whose terminal is one of those two writer kinds,
only with `status=cancelled`. The verifiers bind each cancel reply to the
terminals it may lead to, demand the run status of that terminal, and refuse any
other pairing. The parsed deterministic and packed-project results must match
exactly except for the recovery job UUID. The hostile comparison excludes
`generated_at` and per-scenario duration and canonicalizes only the two ratified
writer kinds of a cancelled terminal after checking the exact pairing. This proves that the
attested public release currently reproduces the committed behavioral claims.
It does not claim cryptographic proof of when the committed JSON file itself
was originally written.

## Test layers

1. Unit tests cover configuration, local process framing, HTTP protocol
   validation, SSE recovery, independent observer backpressure, scheduling,
   receipts, and typed errors.
2. The generated corpus holds 100 distinct use cases and 100 valid workflows.
3. The deterministic runner executes every workflow with `mock/echo` and
   seals trace evidence without paid-provider dependence.
4. Project gauntlets install the tarball into fresh applications and exercise
   realistic multi-step use cases.
5. Hostile tests mutate transport frames, timing, status codes, identities,
   revisions, and replay order.
6. Public Personas use only the README, exported types, packed package, public
   binary/help, loopback HTTP, and public documentation. They are synthetic
   users, never substitutes for human usability evidence.

The latest public-only first-contact wave and its convergent debt are recorded
in [`gauntlet/personas/REPORT.md`](../gauntlet/personas/REPORT.md).

## Socratic risk matrix

Every release wave must ask and demonstrate an answer to these questions:

- Can a first-time Node user succeed from the README without repository
  knowledge?
- Do ESM and CommonJS load from the packed tarball on every supported Node
  major?
- What happens if the server dies after admission but before the first SSE
  frame?
- What happens if SSE reconnects after a duplicate, gap, conflicting replay,
  or terminal race?
- Can one slow observer overflow without damaging another observer or
  `run.result()`?
- Does one application read the same lifecycle words over the native process
  and over HTTP, with `event.raw` still the protocol frame, and without a
  per-task event the resident never streamed?
- Does a frame whose state word is absent, null, future, or still running
  stay an `engine.event` instead of being named settled?
- Is a human gate (`paused`) kept apart from both failure and completion, and
  the engine's `interrupted` evidence apart from a broken observation?
- Does a program written against the published run handle run unchanged, and
  does every compatibility door stay a view of the one session instead of a
  second run, dispatch or stream?
- Can two clients race the same idempotency key with equal and unequal
  snapshots?
- Does cancellation win or replay honestly when settlement races it?
- Does a stale schedule writer receive the current revision without mutating
  durable state?
- Do process and server restarts preserve the facts the API claims are
  durable?
- Can a replacement client reattach with its last committed SSE cursor without
  replaying an application side effect?
- Are auth failures, token rotation, malformed content types, compressed
  bodies, oversized frames, invalid UTF-8, and timeouts typed and redacted?
- Are receipt job, execution, and trace identities consistent across SSE,
  durable state, and verification?
- Is the run-signing private key still confined to engine custody, with only
  public trust material entering application infrastructure?
- Does every live OpenAPI route have a deliberate SDK treatment?
- Does every documented example compile and run from the tarball?
- Does the version agree across package metadata, lockfile, optional native
  packages, OpenAPI identity, engine release, npm, and GitHub?
- Can a claimed capability be deleted without a gate becoming red? If yes,
  the capability is not yet wired.

## Release evidence

Record exact commands, versions, commit SHAs, platform, run counts, cost, and
the path to machine-readable results. A green unit suite alone is never release
evidence. A failed or skipped lane stays named; it is not rounded into a pass.

The release ceremony is deliberately two-step. `release.yml` validates the
tagged engine assets, starts the released Linux binary, proves the live
OpenAPI/types pin, embeds the exact prepared commit and release version in all
five package manifests before packing, and publishes four payloads plus the SDK
through npm trusted publishing with GitHub OIDC and Sigstore provenance bound
to the workflow identity. Every package registers organization `supernovae-st`,
repository `nika-client`, workflow filename `release.yml`, and environment
`npm-publish`, with direct `npm publish` enabled. The GitHub-hosted publish job
uses Node 24, npm 11.19.1 and `id-token: write`; it receives no npm write token.
`release-heal.yml` dispatches that same file on `main`; it does not publish or
exchange an OIDC token itself. All five package manifests identify the SDK
repository; native `SOURCE.json` still identifies the separate engine source.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
An occupied version is accepted only after its exact
prepared tarball integrity and fetched registry bytes match; errors other than
an explicit registry 404 refuse publication. `release-finalize.yml` refuses to create the SDK tag and GitHub
Release until all five exact versions are publicly observable on npm and every
published manifest carries the same prepared commit and version.

## One-door parity and process supervision

`gauntlet:one-door` compares CLI, raw HTTP by name and snapshot, and packed SDK
native, by-name and snapshot execution. It checks success, failure, recovery,
paused observation and controlled cancellation. `NIKA_ONE_DOOR_REPORT` names
its output file; CI retains it alongside the replay results. Development mode
uses an offline installation of the freshly packed SDK with the explicit
`NIKA_BIN`. Public npm parity requires `NIKA_PUBLIC_SDK_VERSION` and an outer
artifact-provenance gate; runtime agreement alone is not an attestation.

All harnesses own their child processes, impose finite deadlines and await
cleanup before emitting green evidence. The corpus runs in a fresh project and
HOME. Changed fixtures require new measured results: old committed ledgers
remain historical observations until a successful exact-version replay replaces
them. Never relabel an old binary or weaken the replay comparison.

## Published run-handle compatibility

The run handle published as `@supernovae-st/nika` 0.120.3 is carried here as
views of the one `RunSession` that owns each admitted run: `run.events()`
projects the same bounded history into lifecycle words, `run.result()` is the
settlement promise that `run.done` also is, and `run.status()` and
`run.cancel()` delegate to the same transport run, whose accepted cancellation
is memoized once. `nika.events(run)`, `nika.cancel(run)` and `nika.status(run)`
stay as deprecated views of that same session. No view admits, dispatches,
pumps or settles anything of its own.

Covered by `npm test`:

- `test/run-handle-compatibility.test.ts`: the handle's frozen member set;
  `result()` and `done` as one promise; extracted methods; the native status
  refusal and the resident's durable status; idempotent cancellation natively
  and over HTTP, with one cancel request; the deprecated doors sharing the
  handle's frames by identity, its memoized cancellation and its status; one
  admission and one event stream over HTTP whatever mix of views and doors
  reads the run; one transport pump for every view of both vocabularies; an
  aborted observer ending only its own view; ownership refusals; an admitted
  failure as result data; a broken observation rejecting `result()` and `done`
  with the same error and recovering through `attachRun`; replay after the
  result past the old 256 bound; the default 4096 bound to the frame;
  `replay_truncated` with `observed` and `retained`, and `live_backpressure`
  without them; the lifecycle projection and the success guard. The cases
  are ported from the published line's tests. Its measured native wire files
  and synthetic frame-count engine modes are not fixtures of this line, so
  those laws run here over the resident's stream and over a synthetic
  transport run.
- `test/package-consumer.test.ts`: the same handle driven on the packed ESM
  and CommonJS faces (native runs against the fixture engine, resident runs
  against an in-process `fetch`), and strict `.mts` and `.cts` type checks of
  the handle, the lifecycle event, the overflow reason, the success guard and
  `NikaCheckFinding`, whose shape the compiler holds exactly equal to the
  published one.
- `test/one-sdk.test.ts`: the handle's exact member set over HTTP, and check
  report findings read through `NikaCheckFinding` untouched.
- `test/native-run-admission.test.ts`: the native admission boundary. `run()`
  resolves only once the engine admitted the run, with the admitting frame as
  its first event, and rejects before any handle exists on a refusal, with the
  engine's code, findings and exit status: a red check report, an error
  envelope, an uncoded finding (`run_refused`), a refusal line, a refusal on
  stderr alone. An empty, malformed, partial or oversized stream, a kindless
  object that is no refusal, malformed findings, output after a refusal and a
  refusal that exits 0 stay protocol faults, and an engine that proves nothing
  is stopped (SIGTERM, then SIGKILL after its grace), never left running.
  One case replays a real engine capture of a required-input refusal byte for
  byte (`test/fixtures/run-wire/README.md`); the others are SYNTHETIC fixture
  cases, not engine captures.
- `test/published-compile-compatibility.test.ts`: the published compile
  shapes on the resident contract. An intent string, `{ intent, answers }` and
  `{ workflow, change }` reach the exact `compile_version: 1` wire, with
  `false`, `0`, `""` and `null` answers kept exactly, and resolve the outcome
  itself with `ready` derived from `status` and never a replay token; the
  typed V9 request keeps its outcome and token; malformed or hybrid requests
  and invalid deadlines refuse before any request; a `timeoutMs` deadline
  aborts the wait and its timer is released; a caller's abort stays the
  transport's error; a native process still refuses. The packed `.mts` and
  `.cts` consumers hold each door's type.

`NikaCheckFinding` was a type-only gap: a strict TypeScript consumer written
against published 0.120.3 could not compile here, while the same program
already ran unchanged, because the engine's report carries the findings and
types never reach the runtime. It types the entries of a check report's
`findings` and, as published, the findings a refused native `run()` carries
(`NikaOperationFinding` is schedule or check findings).

The native pre-run refusal was a runtime gap, measured on a real engine: for
the one-line refusal a current engine writes (`{"error":{"code":"NIKA-1708",…}}`
for a required input left unset), this line used to resolve `run()` and then
settle `result()` as `failed`, like an admitted failure, with the check
findings dropped. It now keeps the published admission boundary on both
transports.

Compile was a runtime and type gap, measured on a real resident: the
published program's `compile('hello', { timeoutMs })` was refused with 422
(`malformed_compile_request`) because the request went out unchanged, while
the resident's outcome underneath was the same (an identical candidate). The
published shapes now reach the same wire and resolve the published
projection; the typed V9 request is unchanged.

Open, and not changed by this compatibility work: a program written against
published 0.120.3 must not assume these surfaces on this line.

- Native compile: published 0.120.3 compiles through the local engine; this
  line refuses with `NikaCompatibilityError` and compiles only through a
  resident.
- Compile type names: `NikaCompileRequest` and `NikaCompileOutcome` keep the
  typed V9 shapes here, so a strict consumer that annotated published shapes
  with them names `NikaPublishedCompileRequest` and
  `NikaPublishedCompileOutcome` instead. Without `timeoutMs` no client deadline
  applies here, where the published package used its 30-second request timeout.
- Run options: `inputs`, `access` and `costReview` by HTTP served name only,
  with a generated HTTP `idempotencyKey`, here; literal `inputs` on both
  transports and a required HTTP key there.
- The multi-line check report older engines wrote before a refusal is not
  read as a refusal here; it stays a protocol fault.
- One HTTP transport comment still names `run.done`, which stays a valid
  alias.

A source manifest version is not a publication claim. When this section was
written (2026-09-29) this line's manifest read 0.118.7 while the latest npm
release was 0.120.3, so a package built from this line is not a publishable
upgrade over the published one. Versioning and publication stay with the
release gates above; the committed gauntlet ledgers of earlier packages remain
historical until an exact-version replay replaces them.
