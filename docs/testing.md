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

Engine-backed gauntlets use an absolute `NIKA_BIN` as the explicit binary.
The corpus scripts refuse missing, empty or relative selections before any
engine spawn; they never fall back to a retired variable or `PATH` binary.
The corpus check/execution, mini-SaaS and recovery runners share one supervisor.
Execution runners invalidate old recorded results before work,
bound build/pack/install and application processes, and own descendant cleanup.
They write green only after every child has exited and scratch cleanup succeeds.
Corpus checks and execution share the unchanged workflow bytes, validated
inventory and owned project/home staging, without inherited provider credentials.
Only declared regular workflow files and the inventory are copied; an explicit
project manifest stops ancestor configuration discovery. This isolates the known
fixtures, not arbitrary hostile workflows. Each engine call has a deadline of
at most 30 seconds within a five-minute overall deadline;
execution alone initializes its disposable signing key. Journals and retention
effects never target the repository. Static checks produce no execution ledger
and cannot substitute for actual runs. Failed engine
selection, identity probes, malformed output and interrupted execution replace
an earlier green report with a failed result; no partial prefix is successful.
Recovery readiness and graceful server shutdown each have a 3-second deadline;
forced cleanup preserves a failed verdict. Hostile and recovery readiness and
shutdown use the same supervisor helpers, with deadline/output/interrupt tests.
Evidence is invalid when the recorded engine identity does not match
the intended release candidate. `npm run check:release-evidence` binds every
current committed gauntlet result and packed tarball identity to the root
package version. Historical ledgers are limited to an explicit allowlist and
must remain labelled as non-gating evidence.

CI adds a behavioral provenance replay. It downloads the Linux x64 asset for
the exact root package version, verifies its GitHub attestation and published
`SHA256SUMS` entry, then reruns all 100 deterministic workflows, the full
14-scenario hostile suite, all five mini-SaaS projects, all five depth projects,
and the two-process recovery scenario from a freshly packed SDK. The runner
mints an ephemeral run-signing key. Cancellation fixtures use a controlled
loopback HTTP rendezvous: hold the first fetch, request cancellation, then
release it while a dependent fetch remains unstarted. No sleep chooses the
result and no shell command or sandbox waiver is required. Cancellation
and sealed-trace claims are exercised against the public binary. The attached
cancellation replay records both event kind and status. A cancel request is
not a settlement: an active runtime may finish successfully, fail, or cancel
at its boundary; lost ownership is `interrupted`. The controlled fixture
must observe `status=cancelled` with the engine's actual task tally.
The parsed deterministic and packed-project results must match exactly except
for the recovery job UUID. The hostile comparison excludes `generated_at` and
per-scenario duration and canonicalizes only those two ratified cancellation
writer kinds after checking the exact cancelled status. This proves that the
attested public release currently reproduces the committed behavioral claims.
It does not claim cryptographic proof of when the committed JSON file itself
was originally written.

The One Door comparison separately asserts success, failure, recovery, cancellation and
pause through six execution paths: CLI, raw HTTP by name and by snapshot,
and the installed SDK over native, by-name and snapshot transports. It also
checks trace projection, terminal-cursor reattachment, and replay before a
changed registry is read. A pause resolves the current observation leg; it
does not make the durable job impossible to resume. Ordinary `check --json`
must omit snapshot bytes, which appear only with `--sdk-snapshot`.

Independent executions compare stable facts while allowing elapsed time and
redacted diagnostic prose to differ. Within one job, the SDK result, original
terminal event, terminal-cursor attachment and idempotent replay must preserve
the full settlement and error exactly, including elapsed time and additive
HTTP fields. Native flat events project the known settlement fields with their
original optional-field presence.

One Door's cancellation fixture uses a controlled loopback rendezvous. Its
first `nika:fetch` reaches a listener owned by the harness, which withholds the
response. Each door requests cancellation at that same point, then releases
the response after the CLI signal was accepted, HTTP returned 202, or the SDK
returned `cancellation_requested`. A second fetch depends on the first task's
success. A green requires the engine's own `cancelled/operator` settlement,
exactly one completed task, exactly one cancelled and never-started task, and
zero requests to the dependent endpoint. A 10-second rendezvous deadline fails
the proof; it never releases the task on a timer. No sleep chooses the outcome.
An accepted request still does not guarantee cancellation in general: the
engine may settle successfully when completion races the request. This fixture
proves cancellation with a held task and unstarted dependent; it does not claim
preemption of in-flight work or coverage of every possible race interleaving.

The artifact retains full original settlements and states exactly which
boundaries were compared. CLI event/trace settlement equality covers all five
scenarios. SDK event/result equality and HTTP terminal-cursor attachment remain
exact, and every raw HTTP or SDK HTTP job additionally compares GET against its
terminal event, including output presence and receipt. GET's authoritative
error is the full nested settlement error; its separate legacy code/message
summary is not compared as a full diagnostic. For cancellation, the supervisor
also reads the journal belonging to each of the six executions and compares its
full settlement against the original terminal event or SDK result. Journal
lookup uses the full execution identity in the recorded event. This is a read
of the supervisor's own scratch project, not a remote SDK trace capability;
the by-name consumer still has neither workflow source nor a usable binary.
Trace output maps are per-task data, so no workflow-output equivalence is claimed
for that projection. Mutation tests reject fabricated cancellation, lost actual
settlements, and changed elapsed time, diagnostics, or additive settlement fields.

Development installation uses `npm install --offline` on the local tarball.
Child processes receive a fresh HOME, disabled Keychain, and no inherited
provider credentials or proxy environment. The fixture declares only loopback
HTTP access. Public npm mode additionally needs registry access to install the
published package; the cancellation fixture itself remains local.

After publication, run the same comparison with
`NIKA_PUBLIC_SDK_VERSION=0.118.2` and the verified public `NIKA_BIN` artifact.
That mode installs the exact public npm package and exercises its optional
native payload without an explicit binary override. A local pack or a dirty
development binary is useful regression evidence, never public-install proof.

## Test layers

1. Unit tests cover configuration, local process framing, HTTP protocol
   validation, SSE recovery, independent observer backpressure, scheduling,
   receipts, and typed errors.
2. The generated corpus holds 100 distinct use cases and 100 valid workflows.
3. The deterministic runner executes every workflow with `mock/echo` without
   paid-provider dependence. Its output comparison is not a trace-integrity
   verification; the engine remains the journal and signing authority.
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
with the repository's npm token and a Sigstore provenance attestation bound to
the workflow identity. Both registry absence and partial-publish recovery use
`scripts/npm-publication.mjs`: only an explicit HTTP 404 establishes absence;
network errors and other responses refuse. An occupied version is never
re-published or accepted by name alone: its SHA-512 SRI and independently
downloaded tarball must equal the prepared artifact. The same byte proof runs
after each publication, with bounded requests and no redirects. This proves
byte convergence, not cross-package atomicity or replayed npm provenance.
`release-finalize.yml` refuses to create the SDK tag and GitHub
Release until all five exact versions are publicly observable on npm and every
published manifest carries the same prepared commit and version.
