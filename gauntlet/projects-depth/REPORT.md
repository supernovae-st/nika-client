# Packed depth-project gauntlet

## Outcome

Five isolated Node consumers install `@supernovae-st/nika-client` from the tarball produced by `npm pack`; none imports repository source or build output. The runner executes every consumer against an explicit compatible `NIKA_BIN` and writes the machine-readable evidence to `gauntlet/projects-depth/results.json`.

| Consumer | Depth exercised |
|---|---|
| Multi-tenant webhook router | Real loopback webhook ingress, authenticated loopback `nika serve`, duplicate HTTP delivery, idempotent job identity, concurrent workflow routing, SSE observation |
| Scheduled research monitor | Resident cadence declaration, exact-revision CAS update, typed stale-writer conflict, server restart with durable state, client reconnect, SSE sequence observation |
| Evidence/provenance pipeline | Concurrent native runs, bounded workflow fan-out, deterministic source and root hashes, two verified receipts, forged receipt rejection |
| Incident-response controller | Live remote run, bounded concurrent signal assessment, stabilization wait, explicit idempotent cancellation, cancellation SSE, typed remote trace-authority verdict |
| Deployment gate | Concurrent allow/refuse runs, parallel regional checks, deterministic assertion law, verified receipt, typed transport-capability refusal |

All workflows use the public envelope and task-map form, the canonical `invoke` verb, declared permit boundaries, `mock/echo`, bounded `for_each` concurrency, and explicit cost caps. Every workflow passes clean, compiled, paid-ready, hint-free `nika check --native-strict` validation.

## Verification

- `NIKA_BIN=/path/to/compatible/nika node scripts/run-depth-projects.mjs` — 5/5 succeeded from isolated packed installs.
- `npm test` — 5 files and 57 tests passed.
- `node --check` — all five consumer entry points and the runner passed.
- `git diff --check` — passed.

The captured run used `nika 0.115.0 (08fb9e289)`, the matching engine carrier contract consumed by this SDK branch. The generated JSON records installed-from-pack proof, stable scenario facts, typed error names/codes, receipt verdicts, event observations, concurrency, cancellation, CAS, and restart evidence.

## Finding

The live owning contract and engine validation define `pauseUntil` as an ISO calendar date (`format: date`, for example `2026-09-01`). The current SDK README example constructs a full timestamp with `toISOString()`, which the resident authority refuses with `schedule.pause: pauseUntil must be an ISO date`; this gauntlet follows the owning contract and leaves the documentation correction to its owner.
