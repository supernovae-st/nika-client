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
`SHA256SUMS` entry, then reruns all 100 deterministic workflows and the full
14-scenario hostile suite. The Linux runner installs `bubblewrap` for declared
`exec` permits and mints an ephemeral run-signing key so cancellation and
sealed-trace claims are tested under their stated preconditions. The parsed
deterministic result must match exactly; the hostile comparison excludes only
`generated_at` and per-scenario duration. This proves that the attested public
release currently reproduces the committed behavioral claims. It does not
claim cryptographic proof of when the committed JSON file itself was originally
written.

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
five package manifests before packing, and stages four payloads plus the SDK
through npm OIDC. A maintainer then inspects and approves the staged packages
with 2FA. `release-finalize.yml` refuses to create the SDK tag and GitHub
Release until all five exact versions are publicly observable on npm and every
published manifest carries the same prepared commit and version.
