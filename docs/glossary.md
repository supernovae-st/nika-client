# Glossary

The words these pages use, defined once. The engine's own vocabulary is in the
[Nika documentation](https://docs.nika.sh) and the
[language specification](https://github.com/supernovae-st/nika-spec).

| Word | Meaning |
|---|---|
| **Workflow** | A `.nika` file: the model to use, what it may touch (`permits:`), its tasks and its outputs. On a server, a workflow is also addressed by its *served name*, a path relative to the server's `--workflows` folder. |
| **Check** | The engine's static audit of a workflow, before any model is called: plan, models, access, cost, permits. `nika check` prints it; `check()` returns it; every `run()` applies it first. |
| **Access pin** | The path the engine takes to a workflow's model: a class (`mock`, `api`…) or a harness seat (`codex`, `claude-code`…), set with `access` (`--access` on the CLI). A pin is a pin: one the engine cannot take is refused (`NIKA-1801`, `NIKA-1802`), never swapped for another path. |
| **Admission** | The engine accepting a workflow for a run. `run()` resolves on admission and rejects on a refusal; nothing runs without it. |
| **Run** | One admission of a workflow, and the `NikaRun` handle your code gets for it. |
| **Job** | A run held by `nika serve`. Its id (`run.id` over HTTP) is durable: store it to reattach after a restart. |
| **Execution** | The engine's own id for what actually ran (`execution_id`), carried by the receipt. |
| **Event** | One lifecycle step of a run, as `run.events()` yields it: `run.started`, `task.completed`, `run.settled`… The engine's exact frame rides on `event.raw`. |
| **Sequence** | The server's number for an event (`event.sequence`), the cursor you store and pass back as `lastEventId`. Local events have none. |
| **Settlement** | How a run ended, in the engine's words: `result.status` and `result.settlement` (cause, task tally, time, spend). |
| **Human gate** | A step that waits for a person. The run is `paused` (a `run.waiting` event): neither failed nor finished. |
| **Interrupted** | The engine lost an execution, so its ending is unknown. Not the same as `NikaObservationInterrupted`, which means this client lost its view of a run. |
| **Trace** | The tamper-evident, hash-chained record of a run that the engine writes (locally under `.nika/traces/`). |
| **Seal** | The engine's signature over a trace, written as its last line when the run ends, with a signing key. A trace without one is *unsealed*. |
| **Receipt** | The proof material a run hands your code (`result.receipt`). Pass it back unchanged to `traceVerify()`. |
| **Artifact** | A file a settled server job produced, as its sealed journal records it with its size and SHA-256: what a builtin saved (`nika:chart`, `nika:image_generate`…) or an image an agent sent. `run.artifacts()` lists them (the job's *manifest*, bound to its receipt), and `run.downloadArtifact()` streams one, its bytes proven against that record. A local run has no manifest. |
| **Signing key** | The engine's run-signing key pair (`nika key init`). The engine your app starts reads it from `~/.nika/keys/` or `NIKA_RUN_KEY_FILE`/`NIKA_RUN_PUB_FILE`, never from an OS keychain. |
| **Door** | One of the two ways the package reaches an engine: the bundled engine as a child process (`new Nika()`, transport `native-process`) or a `nika serve` over HTTP (`new Nika({ url, token })`, transport `http`). |
| **`nika serve` (the resident)** | The engine running as a long-lived server you operate. It holds jobs and schedules across restarts. |
| **Snapshot** | The exact bytes of a local workflow file, captured by a local engine and sent to a server when you pass a path such as `./flow.nika`. |
| **Idempotency key** | A key you own for one business operation. Over HTTP, the same key returns the same job, so a retry never runs twice. |
| **Schedule** | A cadence declared on a server (`schedule()`), changed only by its current *revision*. |
| **Inputs** | Literal JSON values for the workflow's declared `inputs:`, passed with `run(workflow, { inputs })`. |
| **Permits** | What a workflow may reach: files, network, commands, tools. Default-deny engine policy; nothing in this package grants more. |
| **`mock/echo`** | The engine's offline rehearsal model: it echoes the prompt back (prefixed `mock(echo) ·`), with no key and no network. |
| **Compile** | Asking the engine for a candidate workflow from an intention or an edit (`compile()`). It runs nothing. |
| **Round** | One compile request and its outcome. An `incomplete` outcome asks questions; `nextCompileRequest()` builds the next round with your answers. |
| **Seat** | The authoring model a server's operator configured (`nika serve --authoring-model`). Over HTTP, a request opts in to it with `cognition: 'explicitProvider'`. |
| **Kept plan** | The plan a server keeps from a provider round, named by its `replay_token`, so an answer round can replay it instead of authoring again. |
| **Compile generation** | The compile wire version: `compile_version` 2 exactly when a provider call happened, 1 otherwise. |
| **Capability** | A feature an engine or server advertises (`nika --sdk-identity`, `GET /health`): `inputsLiteral`, `jobInputs`, `compile`, `compileNativeV2`… The package checks it before it asks. |
| **Machine protocol** | The generation of the machine contract between this package and the engine (2 for 0.123 and 0.124). The package refuses an engine on another generation at its identity probe, before any job. |
| **Release train (lockstep)** | Each package version bundles the engine with the same number, the one it was tested with, and moves with it. |
