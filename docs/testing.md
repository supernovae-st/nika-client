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
  `run.done`?
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
