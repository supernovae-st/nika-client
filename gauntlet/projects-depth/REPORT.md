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
- `npm test` — 9 files and 119 tests passed.
- `node --check` — all five consumer entry points and the runner passed.
- `git diff --check` — passed.

The final release-candidate replay used the clean engine `nika 0.116.0
(b38267751)` with `supernovae-st-nika-client-0.116.0.tgz`; all five projects
remained green. The generated JSON records installed-from-pack proof, stable
scenario facts, typed error names/codes, receipt verdicts, event observations,
concurrency, cancellation, CAS, and restart evidence.

An additional packed two-process recovery project runs through
`npm run gauntlet:recovery`. Process A admits the job, persists sequence 1 and
exits; process B creates a new client, calls `attachRun`, resumes at sequence 2
without a duplicate, and observes the same durable job settle successfully.
Its machine evidence is `gauntlet/results/recovery-e2e.json`.

The historical paid-provider and three-pass trace ledgers remain useful prior
evidence, but are explicitly labelled as historical 0.115 observations and are
not release gates for this 0.116 candidate.

## Finding

The live owning contract and engine validation define `pauseUntil` as an ISO
calendar date (`format: date`, for example `2026-09-01`). The gauntlet exposed
that the old README constructed a refused timestamp; the 0.116 documentation
and exported type comment now teach the owning date contract.
