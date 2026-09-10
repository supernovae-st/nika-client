# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add six-door runtime parity and bounded, owned process supervision for the
  corpus and packed application harnesses.

### Changed

- The package is published as `@supernovae-st/nika`, the product's name: one
  namespace for the owner, one artifact name per registry. The native payloads
  were already `@supernovae-st/nika-<os>-<arch>`; the repository keeps its
  name. Release evidence, packed-install checks and the publication gates
  follow the new tarball name `supernovae-st-nika-<version>.tgz`.

### Deprecated

- `@supernovae-st/nika-client` receives no further versions. The name stays
  installable for the versions it already holds and is marked deprecated on
  npm after the first `@supernovae-st/nika` publication.

### Fixed

- The release preparation and the CI type-drift probes create the resident's
  `server.log` before launching it; the discovery loop no longer races a
  background subshell that has not opened its redirection yet, the failure
  that stopped the 2026-09-10 release preparation.
- Resolve HTTP workflow names at the resident without a local engine; explicit
  local paths retain snapshot capture and digest verification.
- Preserve pending cancellation, paused observation and recovered native
  settlement facts across transports.
- Verify exact engine release provenance and prepared npm tarball integrity
  before release operations; type drift fails when its promised engine is absent.
- `cancel(run)` accepts an HTTP 200 response carrying a `paused` job and
  returns `already_settled` with `accepted: false`, preserving the existing
  observation's result and evidence. This closes the pause-response gap
  recorded in 0.118.7. HTTP 202 remains a pending cancellation, and attaching
  to a paused job after an event cursor still waits for the next observation.

## [0.118.7] - 2026-09-07

Lockstep release for engine v0.118.7: the SDK accepts the 0.118 `nika serve`
wire, pins its contract, and its release evidence is regenerated on the public
v0.118.7 asset. Publication still requires the exact public engine tag, assets,
attestations, and prepared SDK commit.

### Fixed

- The HTTP transport accepts the `nika serve` wire of engine 0.118, measured
  against a 0.118.7 `nika serve --bind`. The SSE frame allow-list and the
  durable job allow-list learn `settlement`, the object the resident nests
  whole on `execution.settled` and on `GET /v1/jobs/{id}`; before, a 0.118
  door was refused at its first terminal frame (`SSE data contained fields
  outside the public projection`) and at every durable read (`Durable job
  response contained unknown fields`). The nested settlement is validated
  (typed known facts, additive fields kept, a `status` that contradicts its
  record refused) and rides `run.done` as `settlement`, its `status` and
  named `error` included, on the SSE path and on the attach and cancel paths
  that settle from the durable job; a failed run's `error` names its task
  from the settlement.
- `cancel(run)` accepts the resident's 202 (`Cancellation requested;
  execution has not yet settled`) with the still-running job and returns
  `{ accepted: true, status: 'cancellation_requested' }` without settling:
  the open observation then settles `run.done` on the terminal the execution
  owner records (`interrupted` once the resident's grace expires, as
  measured; `cancelled`, `succeeded` or `failed` otherwise). Before, the 202
  was `non-contract status 202`. A 202 that carries a terminal job is a
  protocol fault; 200 keeps its meaning, a settled job (`cancelled` or
  `already_settled`). Known gap: a 200 reply carrying a `paused` job, which
  the contract allows (a paused observation returns its result unchanged),
  is still refused as `Cancellation did not return a terminal job`; a
  follow-up will read it.
- `traceVerify(receipt)` over HTTP no longer demands `reason`: a verdict that
  holds carries none. `verified` is true on `verified` and on the CLI's
  positive tiers (`OK`, `SEALED`, `ANCHORED`, `REPLAYED`, case-insensitive)
  only when the door binds the verdict to the receipt's trace (`trace_id`
  present and equal); `unavailable`, `INCOMPLETE`, `TAMPERED` and `invalid`
  stay false. The 0.118 door still answers only the typed `unavailable`
  refusal, which is kept as is.


- Engine identity probe refusals name the executable path and, when it did
  not answer like an engine, the one command that settles it
  (`<bin> --sdk-identity`) instead of `Engine identity probe failed`.
- HTTP refusals that `nika serve` types as `{ error: { code, message } }`
  (401 `unauthorized`, 404 `job_not_found`, 409 `idempotency_conflict`, 422
  `malformed_snapshot` or a stamped `NIKA-…` admission code) now surface as
  `NikaOperationError` with `status`, `code`, and the refused `operation`
  instead of an opaque `HTTP <status> for <path>: [REDACTED]`; untyped bodies
  keep the redacted transport error, and a reflected bearer token is redacted
  from any server message. `NikaOperation` widens accordingly.
- A failed native run now settles `run.done` with the failure the engine
  named. The engine states a task failure as field rows on `task_failed`
  (`detail: "NIKA-EXEC-001 · command exited with status 1"`, `task`), and
  the later `workflow_failed` and `run_settled` frames carry no error, so
  `NikaRunResult.error` stayed undefined on every native failure. It now
  carries `{ code, message, task }`; `NikaMachineError` gains an optional
  `task`.
- A remote run admitted by `POST /v1/jobs` and settled from its SSE frame
  now carries `execution_id` and `trace_id` on `run.done`, read from the
  receipt on that frame after it passed the identity checks; before, only a
  run settled from a durable read (cancel, attach) named them, so the same
  script saw them on a cancelled run and not on a succeeded one.
- Native `traceVerify` returns `verdict` (`verified` or `invalid`, with
  `reason: receipt_mismatch` when the evidence does not bind the receipt),
  the vocabulary the HTTP verdict already speaks.


- `isNikaRunSettledEvent` now narrows the HTTP settlement frame
  (`execution.settled`) as well as the native `run_settled` one. It
  previously never returned true on a `nika serve` stream, so the documented
  way to read status, outputs, and receipt together was dead on that
  transport.


- HTTP `check()` of a red workflow now returns the engine's plain teaching
  report with `findings[]`; the snapshot capture refuses such a workflow with
  one error line, which is preserved as `snapshot_error`. No workflow bytes
  are sent on that path.
- Native `check()` now reads the check report the engine routes to stderr
  behind its `nika: ` prefix instead of reporting an engine incompatibility;
  when neither stream carries a report, the typed error appends a bounded
  single-line excerpt of stderr.
- A pre-run engine refusal printed as a plain `NIKA-…` line under `--json`
  now settles `run.done` with `NikaOperationError` (`operation: 'run'`, the
  engine code, the full refusal line) instead of a protocol error; any other
  unreadable machine line keeps `NikaProtocolError` and now quotes a bounded
  excerpt of the offending line. `NikaOperation` gains `'run'`, additively.
- Engine spawn failures name the engine path and the underlying errno, so a
  wrong `bin`/`NIKA_BIN` reads as `spawn /path/to/nika ENOENT`.

### Changed

- `openapi.json` and `src/generated/openapi.d.ts` are pinned to the engine
  0.118.7 contract: `RunSettlement`, `settlement` on `JobEvent` and `Job`,
  the 202 on cancel, and the by-name `JobByName` admission form this SDK
  does not use yet. `JobEvent` stays closed. `NikaSettlement` gains `status`
  and `error`, `NikaSpend` gains `by_source`, `NikaExecutionSettledEvent` and
  `NikaExecutionCancelledEvent` gain `settlement`, `NikaCancelResult.status`
  documents its three words, and `NikaTraceVerifyResult.verdict` lists the
  CLI tiers.
- The root client, the four native payload manifests, the optional
  dependencies and the lockfile move to 0.118.7 through the canonical release
  synchronization script.
- The release gauntlet and its verifiers read the 0.118 cancellation
  semantics, measured on the public asset. The hostile and depth cancellation
  fixtures cancel an execution that is observably inside its 10 s `nika:wait`
  (the durable status reads `running`, no longer `queued`, and a further
  250 ms or 1 s has passed) and record the resident's 202
  `cancellation_requested` together with the `execution.interrupted` terminal
  its execution owner records once the grace expires; the native race records
  the `cancelled` settlement with `cause: operator` and exit 130 once the
  in-flight wait runs out. `verify-release-evidence` and
  `verify-release-replay` bind each cancel reply to the terminals it may lead
  to and refuse any other pairing: a 200 `cancelled` to
  `execution.cancelled|execution.settled` with status `cancelled`; a 202
  `cancellation_requested` to `execution.interrupted` with status
  `interrupted` (the grace expired inside a task, no settlement) or to one of
  the two writer kinds with status `cancelled` only when the terminal's
  settlement cause is `operator` (the request landed at a task boundary); the
  run status equals the terminal status. Only the two ratified writer kinds
  of a cancelled terminal are still canonicalized for the replay comparison.
  The five current evidence files are regenerated on the public asset
  `nika 0.118.7 (f3a31a6ee)`.

### Added

- `NikaRunSettledEvent.error`: engine 0.117+ repeats the first failed task's
  code, message and task id on the terminal `run_settled` frame; `eventError`
  already read an `error` object first, so `run.done` carries it on both
  engines without a code change (the frame is typed and the reader is pinned).


- Discriminated `NikaEvent` union over the known lifecycle kinds with an
  intentional `NikaUnknownEvent` fallback, typed `status`/`outputs`/`receipt`
  on the terminal `run_settled` and `workflow_completed` frames, and the
  `isNikaRunSettledEvent` / `isNikaRunSealedEvent` narrowing guards.
- Caller-owned `Outputs` type argument on `run`, `attachRun`, and `events`,
  flowing into `NikaRunResult` and the terminal frames; it defaults to the
  previous transport shape, so existing callers compile unchanged.
- Branded opaque `NikaRunId`, `NikaExecutionId`, and `NikaJobId` identity
  types on the run surfaces that already carried those identities.
- Typed HTTP transport event kinds on the `NikaEvent` union
  (`NikaExecutionStartedEvent`, `NikaExecutionSettledEvent`,
  `NikaExecutionCancelledEvent`, `NikaExecutionRefusedEvent`,
  `NikaExecutionInterruptedEvent`), alongside the transport-agnostic
  `isNikaTerminalEvent` guard, which narrows any frame the engine reported
  with a terminal status rather than matching on its kind.

### Security

- `bin` and `NIKA_BIN` must be absolute paths. A bare name such as `nika`
  reached `spawn()`, where the operating system resolved it through `PATH`,
  the implicit lookup the README promises never happens; a relative path was
  resolved against the working directory the same way. Both now refuse with
  a message that names the value and the rule.


- `allowInsecureHttp: true` now admits plaintext HTTP only for a loopback host
  (`localhost`, `127.0.0.0/8`, `[::1]`); any other host over `http:` is a
  `NikaConfigurationError`, so the opt-in can no longer send a bearer token in
  clear text to a routable address.

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
