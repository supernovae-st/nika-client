# @supernovae-st/nika documentation

These pages ship inside the npm package (`node_modules/@supernovae-st/nika/docs/`)
and describe the version you installed. Start with the
[README](../README.md): install, a first run, what happens underneath and the
two doors. Then read the page for what you are building.

## Build with it

| Page | What it covers |
|---|---|
| [runs.md](runs.md) | `check()`, results and statuses, literal `inputs`, `run.events()`, late views and their bounds, cancellation, typed frames, the deprecated wrappers |
| [server.md](server.md) | `nika serve`: setup, idempotent runs, recovery with `attachRun`, restarts, connection rules, schedules, the local/server differences |
| [receipts.md](receipts.md) | Traces, receipts and `traceVerify()` on both doors, what a verified receipt proves, signing keys and where each process reads them |
| [compile.md](compile.md) | `compile()`: from an intention or an edit to a checked candidate, answer rounds, provider rounds on a seated server |
| [errors.md](errors.md) | The error hierarchy, refused runs, server refusals and a troubleshooting table |
| [upgrading-to-0.123.md](upgrading-to-0.123.md) | Moving from 0.120.x: the machine-protocol rule and what changed in the data |
| [glossary.md](glossary.md) | Workflow, run, job, execution, trace, seal, receipt, door, seat, round… defined once |

## Contracts and internals

| Page | What it covers |
|---|---|
| [http-api.md](http-api.md) | Every `nika serve` route the package uses, SSE recovery, idempotency, schedule revisions, compile generation 2 |
| [architecture.md](architecture.md) | Modules, the two transports, lifecycle invariants and authority boundaries (for contributors) |
| [testing.md](testing.md) | Test layers, gauntlets and release evidence (for contributors) |
| [migrating-to-0.116.md](migrating-to-0.116.md) | History: the 0.115 to 0.116 consolidation into one `Nika` class |

## Runnable examples

[`examples/`](../examples/README.md) in the repository holds programs you can
run against the bundled engine or a local `nika serve`: the quick start, a
watched and cancelled run, a server job recovered across two processes, and
compile then run.

## Elsewhere

- The SDK guide on docs.nika.sh: [overview](https://docs.nika.sh/sdk/overview),
  [quickstart](https://docs.nika.sh/sdk/start/quickstart),
  [configuration](https://docs.nika.sh/sdk/reference/configuration),
  [methods](https://docs.nika.sh/sdk/reference/methods),
  [types](https://docs.nika.sh/sdk/reference/types),
  [receipts](https://docs.nika.sh/sdk/runtime/receipts),
  [remote jobs](https://docs.nika.sh/sdk/remote/jobs),
  [OS schedulers](https://docs.nika.sh/sdk/operations/os-schedulers) and
  [deployment topologies](https://docs.nika.sh/sdk/operations/deployment-topologies).
- [Known limits in 0.123](https://docs.nika.sh/changelog/known-limits).
- The [engine](https://github.com/supernovae-st/nika) and the
  [language specification](https://github.com/supernovae-st/nika-spec).
