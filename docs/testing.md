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
`SHA256SUMS` entry, then reruns all 100 deterministic workflows, the hostile suite, all five mini-SaaS projects, all six depth projects,
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
exactly except for the recovery job UUID and the depth `package_sha256`.
That digest is provenance of the tarball this replay packed (README lives
inside the npm pack): the verifier requires `depth-package.json` beside the
ledger, hashes the artifact, checks filename/size/sha512 integrity, refuses
a missing or substituted pack, then compares behavior without requiring the
committed baseline digest (that digest is a labelled historical ledger
identity, not a re-hash of this run). A documentation-only
README change retargets the digest and must still reproduce every behavioral
verdict. The hostile comparison excludes
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
- Does a workflow the engine refuses reject native `run()` with the engine's
  code and findings, on every refusal dialect a supported engine writes, with
  no run handle, no second spawn and no preflight check? Does output that
  proves neither admission nor refusal stay a protocol fault? The answer is
  `test/native-run-admission.test.ts`. Its `wire-*` cases replay stdout and
  stderr captured byte-for-byte from real engines
  (`test/fixtures/run-wire/README.md` records which, and how); its
  `SYNTHETIC` cases are invented hostile shapes. A replay proves the SDK
  decodes those bytes, never that an engine still writes them: a new engine
  release needs a new capture.
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

## Compile foundation parity

Hermetic compile cases run with `npm test`, including strict request literals,
capability/version refusal, native exit and signal laws, temporary-file failure
cleanup, authenticated HTTP responses and cancellation. `npm run check:package-surface`
checks both packed module faces and their public TypeScript contracts.

For a frozen engine that advertises `compile` on both native and Serve doors:

```sh
NIKA_BIN=/absolute/path/to/frozen/nika \
NIKA_COMPILE_PARITY_REPORT=/absolute/path/to/compile-parity.json \
node scripts/run-compile-parity-e2e.mjs
```

This installs the SDK tarball into an isolated consumer and compares the full
common authoring outcomes across native/HTTP and ESM/CommonJS. It checks literal
round trips, incomplete questions, refused expression islands, invalid bases,
authentication, no project-file changes and no created jobs. HTTP is given a
nonexistent local engine path, proving that it cannot use a fallback. The report
records binary and package hashes and is green only after owned-process cleanup.
A source binary containing engine commit
`4334e58bddf539a6253f448eb05d562b6919f2b7` is required for both doors.
Released engine 0.120.3 supports native compile and its Serve advertises HTTP
compile; 0.120.2 and older predate the route. This is a foundation test, not general intent authoring
or execution admission qualification.

The live `/v1/openapi.json` must equal the package's `openapi.json`. A
candidate engine ahead of that pin is compared with the document named by
`NIKA_COMPILE_PARITY_OPENAPI` instead (its own live export, never a hand-edited
copy), and the report's `openapi_pin` says which document held.

The revision evidence of a real provider round runs only when you name a seat
and the one variable holding its key; the key reaches the engine processes and
is never printed:

```sh
NIKA_COMPILE_PROVIDER_MODEL=deepseek/deepseek-flash \
NIKA_COMPILE_PROVIDER_ENV=DEEPSEEK_API_KEY \
NIKA_BIN=… NIKA_COMPILE_PARITY_REPORT=… node scripts/run-compile-parity-e2e.mjs
```

`NIKA_COMPILE_NATIVE_MODEL` and `NIKA_COMPILE_SERVE_MODEL` give each door its
own seat (a native seat may be an ACP harness such as `claude-code/…` or
`codex/…`; Serve seats a direct provider), `NIKA_COMPILE_DECISION_MODEL` seats
a decision model beside both doors' authors (a local revision takes it from
engine `ae6845939` on), and `NIKA_COMPILE_PROVIDER_ENV` takes several variable names,
comma-separated (`HOME` included when a harness must find its own login).

Each packed module system then runs two separate legs once per door, through a
native seat and a seated resident. The EDIT leg revises one rich base
(comments, Unicode, every envelope section); the CREATE leg writes a new
document from words alone. These are separate generations, never compared byte
for byte. Each must satisfy the evidence law: every revision stated binds the
exact base sent and the exact candidate received by sha256, a kept plan states
the decision's revision, a ready round keeps its plan and states the revision
there, an `operations` revision keeps the base's untouched lines, a ready
creation settles `plan.document` (version 1, no program base) on the exact
candidate received, and the backend's model identities stay apart. A revision
round that stated no revision, or a creation that settled no record (a
mandatory question still open, a held or refused round, or words the engine
settled without its author), did not exercise what the phase targets: its row says `exercised: false`, the report's `result` is
`not_exercised` and the runner exits 1. A held round whose revision only the
decision keeps is valid EDIT evidence. The report records each round's status,
digests, calls, tokens, component receipts, backend members and the verifier's
own diagnostics and records.

`NIKA_COMPILE_PROVIDER_LEGS` picks the legs (`edit`, `create`; both by default)
and `NIKA_COMPILE_CREATE_INTENT_FILE` replaces the CREATE leg's words with a
file's, such as a language owner's pinned intent; the report names the words'
source and sha256.

The [2026-09-19 source-build receipt](../evidence/compile-4334e58b-20260919.json)
records 14 cases across both doors and both module systems at that producer,
with exact outcome parity and no resident-state or project-file mutation. Its
engine is a clean source build predating the published v0.120.3 binary; its SDK
tarball is the unreleased PR candidate. The hashes identify those tested bytes.

Compile source-build receipts live outside the published package, so recording
a tarball hash does not change the bytes it identifies. They do not participate
in the released-engine behavioral ledgers.

## Authoring Session parity

`scripts/run-session-parity-e2e.mjs` walks the authoring Session through both
real doors of one frozen binary, from the packed package's CommonJS and ESM
faces: `nika session --json` in a project, and a served project's
`/v1/sessions` (the resident started with `NIKA_SESSION_SERVE_FLAGS`,
`--sessions` by default). No Cargo, no provider: each walk gets a fresh
project world (one `notes/brief.md`), its own `HOME` and a minimal environment,
so the engine's deterministic compiler answers and every walk must say the
same thing.

```sh
NIKA_BIN=/absolute/path/to/nika NIKA_SESSION_PARITY_REPORT=… node scripts/run-session-parity-e2e.mjs
```

Each walk (`scripts/packed-consumers/session-scenario.cjs`) opens a Session,
proposes a copy, answers the opening snapshot late (`stale_snapshot`, line
kept, nothing saved), repeats a command with the same bytes (the recorded
result, `replayed: true`, same event) and with other bytes (refused, nothing
changed: the local handle refuses before sending, a resident answers
`command_conflict`), reads details, shows that another Session's snapshot
answers nothing (natively a second project's Session; a resident refuses a
second live Session with `session_live`), consents (the saved bytes are exactly
the previewed file's `content`, and nothing ran; an engine that projects only
the BLAKE3 witness leaves the bytes unverified), stops with nothing under way,
requests the Run and requires the Session's own observation of it (the saved
workflow, run on its exact bytes by the trace's `workflow_sha256`, ended
`succeeded`) before reading the same project world for its output: a missing,
failed, paused or foreign Run, or a polling deadline, fails whatever the files
show, and `run_not_started` or `run_unobserved` leave the Run unclaimed. It
then sends a request with a Stop right behind it, closes, compares the full
event view with one resumed after the proposal, and after a restart answers
the old snapshot (`unknown_snapshot`; a closed served Session cannot be
attached).

The report judges every walk check by check (`passed`, `failed`, or
`not_exercised` with the engine's reason: a door this binary does not host, a
Run the Session did not start or observe, a turn that settled before its
Stop), compares the two doors up to the Save and the two module systems on
each door, and names the engine binary's sha256, the SDK commit (and whether
the tree was dirty), the package's sha256 and the scenario's own sha256. Its
`result` is `green` only when every walk and comparison passed.
