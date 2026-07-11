# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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


The SDK tracks the `nika serve` HTTP surface. The engine ships the
Diamond rewrite (`supernovae-st/nika`, v0.9x releasing — 0.99.0 at time
of writing). `nika serve` will re-admit to the workspace during the v0.9x arc;
until then, treat this SDK as target-facing and pin to a tagged
release. Granular `[0.64.0]` → `[0.74.0]` entries predate public
changelog discipline and are collapsed here.

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
