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
- `npm test` — the full repository suite passed.
- `node --check` — all five consumer entry points and the runner passed.
- `git diff --check` — passed.

The previous release-candidate replay used the public release engine `nika 0.118.7 (f3a31a6ee)`
with `supernovae-st-nika-0.118.7.tgz`; all five projects
remained green. The generated JSON records installed-from-pack proof, stable
scenario facts, typed error names/codes, receipt verdicts, event observations,
concurrency, cancellation, CAS, and restart evidence.

The incident-response controller first executes its original workflow and
verifies the incident plan. A separate controlled loopback fixture holds a
task until the cancellation request is acknowledged, then releases it. The
public 0.118.7 replay records `cancelled` with cause `operator`, one completed
task and one dependent task that never starts. SSE, terminal result and replay
agree; the resident shuts down without a forced kill. The ledger includes
byte-identical source/executed app hashes and the packed SDK SHA-256.
The hostile suite separately retains the `nika:wait` grace-expiry scenario;
`interrupted` remains a distinct result without a fabricated settlement.

An additional packed two-process recovery project runs through
`npm run gauntlet:recovery`. Process A admits the job, persists sequence 1 and
exits; process B creates a new client, calls `attachRun`, resumes at sequence 2
without a duplicate, and observes the same durable job settle successfully.
Its machine evidence is `gauntlet/results/recovery-e2e.json`.

The historical paid-provider and three-pass trace ledgers remain useful prior
evidence, but are explicitly labelled as historical 0.115 observations and are
not release gates for the current candidate.

## Public 0.120.1 replay

The current replay uses public release engine `nika 0.120.1 (9d554c84c)`
with `supernovae-st-nika-0.120.1.tgz`. All five projects passed with canonical
`.nika` files, including the incident controller's HTTP check and run, sealed
journal verification, substituted-trace refusal, controlled cancellation, and
graceful resident shutdown. Raw trace identifiers remain in the ledger; replay
comparison validates their shape and compares the behavioral verdicts because
each execution creates a fresh identity.

## Public 0.120.0 replay

The previous public replay used engine `nika 0.120.0 (f6155d1be)`
with `supernovae-st-nika-0.120.0.tgz`. All five projects passed with canonical
`.nika` files, including the incident controller's HTTP check and run, sealed
journal verification, substituted-trace refusal, controlled cancellation, and
graceful resident shutdown. That ledger is historical; it is not the current
release gate.

## Finding

The live owning contract and engine validation define `pauseUntil` as an ISO
calendar date (`format: date`, for example `2026-09-01`). The gauntlet exposed
that the old README constructed a refused timestamp; the 0.116 documentation
and exported type comment now teach the owning date contract.

The previous depth baseline used the complete Linux replay record from
GitHub Actions run 34260625242 (candidate b688b8b7). macOS reproduced every
behavioral field identically; its locally packed archive had a different
SHA-256. Both original records are retained in the integration evidence.
CI compares the exact Linux package digest as well as all behavioral fields.

The 0.120.0 committed depth baseline was the complete Linux observation from
[GitHub Actions run 35385698065](https://github.com/supernovae-st/nika-client/actions/runs/35385698065)
(`released-engine-replay`, artifact 10564395708). The measured Linux package
SHA-256 was `fbd179ac7232df08cd227546753580198df80b23688a74c359304c5d7616d762`.
Both platforms produced byte-identical uncompressed tar data (SHA-256
`cab67f73531ce602502136523c6081881e69f5de3df6d9bf37bc97658849ae2d`),
but different compressed bytes.

The current 0.120.1 committed depth baseline is the local macOS observation
against public engine `nika 0.120.1 (9d554c84c)`. The measured macOS package
SHA-256 is `a6ef6fc417c9f935c7fc623256015846aa7be049bbed7d368e58b284330608a2`.
Linux CI `release-evidence-replay` still requires its exact compressed archive
digest; that digest is not claimed here.
