# @supernovae-st/nika documentation

These pages ship inside the npm package (`node_modules/@supernovae-st/nika/docs/`)
and describe the version you installed. Their links to files the package does
not ship (recordings, examples, scripts, the changelog) open the repository on
GitHub. Start with the
[README](../README.md): install, a first run, what happens underneath and the
two doors. Then read the page for what you are building.

## Build with it

| Page | What it covers |
|---|---|
| [runs.md](runs.md) | `check()`, results and statuses, literal `inputs`, access pins, `run.events()`, late views and their bounds, large results and `machineBufferBytes`, cancellation, typed frames, the deprecated wrappers |
| [server.md](server.md) | `nika serve`: setup, idempotent runs, recovery with `attachRun`, the 5-second cancel grace, restarts, connection rules, schedules, the local/server differences |
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

## Watch it

Five terminal recordings of the published 0.123.0 package and the engine it
bundles, each run in a fresh project with `mock/echo` (no model key), and one
illustration. Each comes as a GIF, an MP4 you can pause, and a text
transcript. They live in the GitHub repository, not in the npm package.
[media/README.md](https://github.com/supernovae-st/nika-client/blob/main/media/README.md) says how they are made and checked, and
what the illustration draws.

| Watch | What it shows | Where it is explained |
|---|---|---|
| [The quick start](https://github.com/supernovae-st/nika-client/blob/main/media/gifs/sdk-quickstart.gif) · [MP4](https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-quickstart.mp4?raw=true) · [transcript](https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-quickstart.txt) | The install, the signing key, `run()`, a typed result, a verified receipt | [README](../README.md#quick-start) |
| [Two doors](https://github.com/supernovae-st/nika-client/blob/main/media/gifs/sdk-doors.gif) · [MP4](https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-doors.mp4?raw=true) (illustration) | One call through the package to the bundled engine or to `nika serve`: check, run, events, seal, verify | [README](../README.md#what-happens-underneath) |
| [Three facts](https://github.com/supernovae-st/nika-client/blob/main/media/gifs/sdk-admitted-executed-sealed.gif) · [MP4](https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-admitted-executed-sealed.mp4?raw=true) · [transcript](https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-admitted-executed-sealed.txt) | A refused file that never runs, an unsealed run, a sealed one, one changed byte | [receipts.md](receipts.md#admitted-executed-sealed-three-different-facts) |
| [Events](https://github.com/supernovae-st/nika-client/blob/main/media/gifs/sdk-events.gif) · [MP4](https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-events.mp4?raw=true) · [transcript](https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-events.txt) | `run.events()` for a four-task run, then `result()` | [runs.md](runs.md#watch-a-run-runevents) |
| [Compile](https://github.com/supernovae-st/nika-client/blob/main/media/gifs/sdk-compile.gif) · [MP4](https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-compile.mp4?raw=true) · [transcript](https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-compile.txt) | A sentence to a ready candidate in two rounds, with no model call | [compile.md](compile.md#start-here-no-model-no-key) |
| [Your server](https://github.com/supernovae-st/nika-client/blob/main/media/gifs/sdk-remote.gif) · [MP4](https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-remote.mp4?raw=true) · [transcript](https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-remote.txt) | `nika serve` set up as the README says, one job, a retry, a wrong token | [server.md](server.md#set-it-up) |

## Runnable examples

[`examples/`](https://github.com/supernovae-st/nika-client/blob/main/examples/README.md) in the repository holds programs you can
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
