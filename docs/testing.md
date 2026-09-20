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

The [2026-09-19 source-build receipt](../evidence/compile-4334e58b-20260919.json)
records 14 cases across both doors and both module systems at that producer,
with exact outcome parity and no resident-state or project-file mutation. Its
engine is a clean source build predating the published v0.120.3 binary; its SDK
tarball is the unreleased PR candidate. The hashes identify those tested bytes.

Compile source-build receipts live outside the published package, so recording
a tarball hash does not change the bytes it identifies. They do not participate
in the released-engine behavioral ledgers.
