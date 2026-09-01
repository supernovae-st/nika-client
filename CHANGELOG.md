# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A failed native run now settles `run.done` with the failure the engine
  named. The engine states a task failure as field rows on `task_failed`
  (`detail: "NIKA-EXEC-001 · command exited with status 1"`, `task`), and
  the later `workflow_failed` and `run_settled` frames carry no error, so
  `NikaRunResult.error` stayed undefined on every native failure. It now
  carries `{ code, message, task }`; `NikaMachineError` gains an optional
  `task`.

### Added

- Discriminated `NikaEvent` union over the known lifecycle kinds with an
  intentional `NikaUnknownEvent` fallback, typed `status`/`outputs`/`receipt`
  on the terminal `run_settled` and `workflow_completed` frames, and the
  `isNikaRunSettledEvent` / `isNikaRunSealedEvent` narrowing guards.
- Caller-owned `Outputs` type argument on `run`, `attachRun`, and `events`,
  flowing into `NikaRunResult` and the terminal frames; it defaults to the
  previous transport shape, so existing callers compile unchanged.
- Branded opaque `NikaRunId`, `NikaExecutionId`, and `NikaJobId` identity
  types on the run surfaces that already carried those identities.

## [0.116.2] - 2026-08-31

Lockstep recovery release for engine v0.116.2. The HTTP schema is unchanged
from 0.116.0 apart from its owning engine version; publication still requires
the exact public engine tag, assets, attestations, and prepared SDK commit.

### Changed

- Pin the checked-in OpenAPI identity and generated declarations to the
  0.116.2 release train.
- Align the root client, native payload manifests, optional dependencies, and
  lockfile through the canonical release synchronization script.

## [0.116.0] - 2026-08-31

The One SDK contract becomes the default package surface for native process
and authenticated HTTP execution. This candidate requires matching engine
v0.116.0 release assets before npm publication.

### Added

- One `Nika` facade for check, run, durable status, event observation,
  cancellation, trace verification, resident workflow discovery, and schedule
  compare-and-swap.
- HTTP-only `attachRun(id, { lastEventId })` recovery for durable jobs across
  Node process restarts.
- Immutable local snapshot capture before remote admission, engine identity
  compatibility checks, bounded independent event observers, and typed
  lifecycle settlement.
- Resident schedule apply/status, path-free workflow catalog methods, and
  remote trace verification's honest unavailable verdict.
- A generated 100-workflow corpus, deterministic trace gauntlet, packed Node
  project gauntlets, hostile transport suite, and public Persona evidence.
- Architecture, HTTP contract, testing, Socratic risk, and migration guides.
- Release tarballs embed one immutable prepared commit and version across the
  SDK and all four native packages; finalization verifies every published
  manifest before creating the SDK tag.

### Fixed

- The OpenAPI coverage gate now scans the live HTTP Adapter instead of deleted
  pre-One-SDK modules, fails hard, and rejects routes outside the pin.
- The pinned OpenAPI contract and generated declaration are reviewable source;
  the release gate starts the downloaded tagged engine binary, compares its
  live contract byte-for-byte after JSON normalization, regenerates the types,
  and refuses any diff.
- The SDK now deliberately covers the live resident workflow and durable
  status routes that the old coverage scanner could not see.

### Security

- Bearer tokens require 32–512 visible ASCII bytes; JSON content types, body
  bounds, body deadlines, admission statuses, and receipt identities are
  validated before trust crosses the HTTP boundary.
- Workflow metadata names reject absolute paths, backslashes, empty segments,
  `.` and `..` before network I/O.
- Development dependency advisories are reduced to zero without a forced
  major upgrade.

### Changed

- **Breaking:** the two 0.115 root/local clients are consolidated into one
  transport-selecting `Nika` facade. The `./local` export, `LocalNika`,
  `jobs`/`workflows` namespaces, `fromEnv`, `health`, webhook helpers, and
  preview-only artifact helpers are removed; Node 22 is now required. The
  migration guide contains the complete method mapping.

- Failed terminal job responses may carry redacted
  `{ error: { code, message } }`; SSE carries the same pair as top-level
  `code` and `message`. The One SDK returns either as `NikaRunResult.error`;
  the removed 0.115 `NikaJobError` class is not retained.
- **Type-drift CI mints `--token-file`.** `nika serve --bind` no
  longer starts without it. The job waits on `GET /health` and
  generates from the OpenAPI pin.

## [0.114.0] - 2026-08-23

Lockstep with engine **v0.114.0**. GET job identity may include
`execution_id` and `trace_id` after snapshot readmit. Cancel, artifacts
and `/v1/run` stay unclaimed.

### Changed

- **HTTP client retargets the live `nika serve` door (W09).** Paths are
  `POST /v1/jobs` (Idempotency-Key required), `GET /v1/jobs/{id}`,
  `GET /v1/jobs/{id}/status`, `GET /v1/jobs/{id}/events`. Job identity is
  `{ id, status }` with statuses `queued|running|interrupted|paused|succeeded|failed`.
  SSE payloads are `{ sequence, kind, status }`. The OpenAPI pin lives at
  `openapi.json`. Cancel, artifacts, `/v1/run`, workflow source and reload
  are not claimed — those helpers throw `NikaUnavailableError`. Inputs are
  refused at submit because the live body is `{ workflow }` only.
- Leftover teaching: the live-e2e negative fixture no longer writes
  `nika: v1` or a `tasks:` list. It is a nine-key file (`nika: sdk-bad`)
  with an unknown `name:` field, still parse-fatal as NIKA-PARSE-005
  on 0.109.2. Mock serve-source YAML in the HTTP tests, and the dormant
  type-drift fixture, carry a non-empty `tasks:` map plus `permits:`
  and `outputs:`. Live comments name `nika: <id>`.
- The live leg speaks the nine keys: the e2e workflow, the demo tape's
  staged workflow and the dormant type-drift fixture carry the
  nine-key envelope of the released 0.109.2 (`nika: <id>` names the
  file) · every one proven clean by `nika check` on 0.109.2. Package
  version follows the published engine to 0.109.2.
- README: the engine hero GIF and the lockstep sentence pin to the
  published v0.109.2 tag (was v0.107.0 · #38 left them until a nine-key
  engine release existed).
- Voice correction for the 0.107.0 note below: read it as **the SDK
  publishes verified** — the fact stands (npm provenance proves the
  workflow that built the package); the printed section stays as released.
- README: the zero-key rehearsal (`nika try 01-hello`) now leads the
  hero · the engine hero GIF pins to the release tag it demonstrates
  (was floating `main`) · a lockstep section names `nika doctor` as the
  freshness probe.
- CI: the dormant type-drift fixture speaks the shipped envelope
  (proven clean by `nika check` on the released v0.107.0 when written ·
  re-proven on 0.109.2 in nine-key form, see above) · the day serve
  lands, the gate wakes on a file the engine accepts.
- Coverage: the serve probe learns the Diamond address — it checks
  `crates/nika-serve` before the pre-refonte `tools/nika-serve`, so the
  gate wakes without a maintainer flip when serve re-admits.

## [0.107.0] — 2026-08-01

Lockstep on the engine's trust wave (v0.107.0). SDK-side since 0.106.1:

- **The SDK publishes attested** — npm provenance joins the release
  lane (the package on the registry proves the workflow that built it).
- **The city island README** — the building names its place in the
  13-building city, links every neighbor, and states it holds no
  authoritative root.
- The driver's demo recording lands (eight lines, two verdicts).

## [0.106.1] — 2026-07-28

Lockstep on the engine's v0.106.1 (the browser release — the engine's check
half now ships as a wasm artifact on every release, headed for npm as
`@supernovae-st/nika-check-wasm`: a different seat from this SDK — the
client talks to a serve daemon, the wasm package is the checker in-page).
No SDK-side changes: a pure same-day version alignment.

## [0.106.0] — 2026-07-28

Lockstep on the engine's 0.106 line (the authority release).

### Changed

- E2E: the live workflow grants the exec it spends.
- Deps: TypeScript majors held for a deliberate migration ·
  actions/checkout group bumped.

## [0.105.0] — 2026-07-20

Lockstep on the engine's 0.105 line. What rode the 0.100 → 0.105 alignments
(each a same-day version alignment with the engine release):

### Added

- E2E: the local harness binds through the w2 door (#16) · test fixtures
  speak the key-is-identity grammar (#15).
- Docs: the engine CLI exit-code contract gains exit 4 (paused — the
  ADR-099 human gate) (#17) · the engine voices date themselves in the
  README (pre-0.100 plain text · JSON since) · the contract surfaces
  typed, not just the wire.

### Changed

- README: SOTA pass — hero, the nika-drawn DAG, plain punctuation, the
  family footer (#11) · em dashes out, house middots in (#14).

### Fixed

- `LocalNika.dryRunPlan` teaches the engine floor instead of relaying
  clap noise (#13).
- Release line: the version bump rides a PR and coverage skips honestly
  (#24) · the coverage judge reads the released engine, never HEAD (#23) ·
  an auto-merge refusal never kills the release (#26).
- CI: actions SHA-pinned + grouped weekly dependabot (npm + actions)
  (#18 · #21) · release-heal drives this cascade leg itself.

## [0.99.0] — 2026-07-10

Version alignment with the Nika engine (0.99.0) — same real-semver-to-1.0
ladder as the 0.90.0 alignment below. What rode this alignment:

### Added

- `LocalNika` — the typed driver for the shipped binary: run workflows
  against the local `nika` CLI today, no `nika serve` required (#9).

### Changed

- License: AGPL-3.0-or-later → **Apache-2.0**. The SDK moves to the adoption
  side of the Nika license split (spec = Apache-2.0 · engine =
  AGPL-3.0-or-later): an in-process client library must be freely importable
  by any codebase. Sole-author relicense — no external code contributors at
  change time.

### Fixed

- Streaming: multiple `data:` lines inside one SSE event join per the SSE
  spec instead of dropping (#2).
- Client: `Retry-After` honoring is capped; the serve-dependent CI gates
  un-broke (#1).

### Removed

- Release: the `repository_dispatch: nika-release` trigger — the engine's
  release workflow never emitted it (dead wiring, 2026-07-09 audit).
  Releases stay manual (`workflow_dispatch`, with `dry_run`) until the
  SDK rides the engine release train.


The SDK tracks the `nika serve` HTTP surface as target-facing (the
`LocalNika` driver runs workflows against the shipped binary today);
`nika serve` re-admits on the engine's own schedule — pin to a tagged
release meanwhile. Granular `[0.64.0]` → `[0.74.0]` entries predate
public changelog discipline and are collapsed here.

## [0.90.0] — 2026-06-21

- Version alignment with the Nika engine (0.90.0) under the real-semver-to-1.0
  decision (D-2026-06-20-N1). No functional SDK change — the SDK number now
  tracks the engine/extension and converges to 1.0 at the public launch.

## [0.74.0] — 2026-04-14

- v2 hardening exports: explicit concurrency limiter, pagination helper,
  SSE reconnect with `Last-Event-Id` resume. See `fff73d8`.

## [0.63.0] — 2026-04-03

Initial public release. Full rewrite from v0.1.0.

### Added
- Namespace pattern: `nika.jobs.*`, `nika.workflows.*`
- 6 typed error classes (all extend `NikaError`)
- Custom fetch injection for testing/middleware
- Logger interface (`debug`, `info`, `warn`, `error`)
- SSE streaming with 60s idle timeout
- Binary artifact download (`Uint8Array`)
- Parallel artifact collection in `runAndCollect`
- AbortSignal on `run()`, `runAndCollect()`, `stream()`
- Webhook HMAC-SHA256 verification (Stripe-style)
- Dual CJS/ESM build
- SDK coverage check script (`npm run check:coverage`)
- OpenAPI type generation script (`npm run generate:types`)

### Breaking Changes
- API changed from flat to namespace pattern
- Error hierarchy completely redesigned
- License changed from MIT to AGPL-3.0-or-later
