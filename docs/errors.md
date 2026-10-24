# Errors and troubleshooting

A workflow that runs and fails is **data**: `run.result()` resolves with
`status: 'failed'` and the engine's `error`. Everything else that can go wrong
is a typed error. Every error the package raises for an engine, transport,
configuration or compatibility problem extends `NikaError`. Misusing the API
itself (an empty workflow name, a negative event cursor, a receipt that is not
an object, a workflow name that escapes the served folder) throws a plain
`TypeError` or `RangeError` before any engine or network work starts.

```text
NikaError
├── NikaConfigurationError        bad options or inputs; nothing was started or sent
├── NikaEngineUnavailable         no engine for this machine (see below)
├── NikaTransportError            spawn, network, timeout or abort
│   ├── NikaProtocolError         output that breaks the machine contract
│   └── NikaObservationInterrupted  this client lost its view of a run that may still run
├── NikaCompatibilityError        the engine or server lacks what the call needs
├── NikaOperationError            the engine or server refused, with its own code
├── NikaEventBufferOverflowError  one event view was refused; the run is unaffected
└── NikaRunOwnershipError         a handle this client did not create
```

## A refused run

The engine refuses a workflow before admitting it for a red check, a cost
floor above `maxCostUsd`, a missing required input or a file it cannot read.
`run()` then rejects, before any `NikaRun` exists, with a
`NikaOperationError` carrying `operation: 'run'` and the engine's exit status
in `status`:

```ts
try {
  const run = await nika.run('./workflow.nika');
  const result = await run.result(); // admitted: a failure here is result data
} catch (error) {
  if (error instanceof NikaOperationError && error.operation === 'run') {
    console.error(error.code); // for example 'NIKA-SEC-004'
    for (const finding of error.findings ?? []) console.error(finding.message);
  } else throw error;
}
```

For a workflow whose `exec:` task runs `ls` under `permits: {}`, engine
0.123.0 answers `NIKA-SEC-004` (exit status 2) with the finding
``exec task under a boundary that forbids shells (task `list`) — fix: add "ls" to permits.exec``.

<p align="center">
  <img src="../media/stills/sdk-check-refused.png" alt="list-files.nika runs ls -1 under permits: {}. node gate.mts list-files.nika prints check refused · exit 2, NIKA-SEC-004 and the finding exec task under a boundary that forbids shells (task list) — fix: add ls to permits.exec, then run not started · NIKA-SEC-004 · no run, no events, no trace" width="860">
</p>
<p align="center"><sub>That file from TypeScript: <code>check()</code> returns the refusal and its fix, and <code>run()</code> rejects with <code>NikaOperationError</code> before any run exists. Captured from <code>@supernovae-st/nika</code> 0.123.0 and its bundled engine; <a href="../scripts/media/scenes/sdk-admitted-executed-sealed/gate.mts"><code>gate.mts</code></a> is the program. The whole story, through the seal, is in the <a href="../media/videos/sdk-admitted-executed-sealed.mp4?raw=true">recording</a>.</sub></p>

- `code` is the engine's own: the first check finding that names one
  (`NIKA-SEC-004`, `NIKA-PARSE-005`, `NIKA-AUTH-006`…) or the refusal's code
  (`NIKA-1709`, `NIKA-1708`). `machineCode` repeats it. When the engine named
  none, as for an unreadable file, `code` is the package's `run_refused` and
  `machineCode` is absent: the package never supplies an engine code.
- `findings` holds the engine's check findings untouched, as
  `NikaCheckFinding` (`code?`, `message`, `severity`, `gate`, `kind`, `task`,
  `docs_url`). A budget or launch refusal has none.
- Nothing was admitted, so nothing else exists: no run id, no events, no
  trace, no receipt.

Output that proves neither an admission nor a refusal (a line that is not
machine output, a truncated or oversized report, an engine that exits without
a frame) rejects `run()` with `NikaProtocolError` instead.

## A server's refusal

A refusal `nika serve` types as `{ error: { code, message } }` becomes a
`NikaOperationError` with the HTTP `status`, the server's `code`
(`unauthorized`, `job_not_found`, `idempotency_conflict`,
`malformed_snapshot`, `schedule_conflict`, or a stamped `NIKA-…` admission
code) and the refused `operation`. Server messages are the engine's, without
paths, and a reflected bearer token is redacted before it reaches a message.
A non-2xx answer without that typed body stays a `NikaTransportError` whose
body is redacted entirely. Compile refusals are listed in
[compile.md](compile.md#errors).

## Also good to know

- `NikaEventBufferOverflowError` is never about the run (see
  [runs.md](runs.md#a-view-opened-late)).
- `NikaObservationInterrupted` carries `lastSequence`, the cursor to resume
  from with `attachRun` (see [server.md](server.md#recovery-after-a-restart)).
- Local engine events stay open to new kinds; server events must match the
  closed, redacted `JobEvent` shape of the pinned OpenAPI contract, and
  unknown HTTP fields are rejected at that boundary.
- The package never turns an unpriced model into `$0`.

## Troubleshooting

| You see | Why | What to do |
|---|---|---|
| `not verified: receipt_mismatch` after a successful run | the engine your app starts found no signing key it can read, so the record is unsealed (or the receipt was edited) | `NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init`; if `nika key init` already stored a key in the macOS keychain, `./node_modules/.bin/nika key align` from a terminal (see [receipts.md](receipts.md#signing-keys-where-the-engine-finds-them)) |
| `NikaEngineUnavailable` from `new Nika()` | no engine payload for this machine: Windows, musl Linux (Alpine), Node.js older than 22 (npm skips the payload with an `EBADENGINE` warning), or an install with `--omit=optional` | Node.js 22 or newer on macOS or glibc Linux with optional dependencies; or an absolute `bin`/`NIKA_BIN`; or a `nika serve` by URL |
| `NikaCompatibilityError` with `capability: 'engineIdentity'` | the engine or server speaks another machine protocol (0.122 and older speak 1) | upgrade the engine and every `nika serve` to 0.123, or point `NIKA_BIN` at a 0.123 engine; see [upgrading-to-0.123.md](upgrading-to-0.123.md) |
| `NikaCompatibilityError` naming another capability (`inputsLiteral`, `jobInputs`, `compile`, `compileNativeV2`…) | the engine or server does not advertise what the call needs | use an engine that does, or drop the option; nothing was started |
| `NikaConfigurationError` about `bin` or `NIKA_BIN` | a bare name or a relative path, which would make the OS search `PATH` | an absolute path |
| `nika serve` exits with `token file must be mode 0600` | the token file is readable by others (or not 32–512 visible ASCII bytes) | `chmod 600 .nika/serve.token`, or mint it again with `openssl rand -hex 24` |
| `nika serve` exits with `nothing armed — this project has no nika.yaml` | the server needs a project file in its folder | a one-line `nika.yaml`: `nika: my-project` |
| `NikaProtocolError: Native machine line exceeded … bytes` | `machineBufferBytes` is smaller than an engine frame | keep the default 64 KiB: a 0.123.0 run's first frame is about 32 KiB |
| `run()` rejects with `NikaOperationError` | the engine refused the workflow before it ran | `error.code` and `error.findings`; `./node_modules/.bin/nika check <file>` shows the same audit |
| `result.status` is `failed` and nothing threw | an admitted run failed: that is data | read `result.error` (`code`, `message`, `task`) and `result.settlement` |
| `result.status` is `paused` | a human gate holds the run | it is neither success nor failure: show it as waiting |
