# `nika run <file> --json` wire captures

Byte-for-byte stdout/stderr of real engines, replayed by `fake-nika.mjs` so the
native transport is tested against what an engine actually writes. They are
recordings, not live proof: a test that replays them proves the SDK decodes
these bytes, never that a given engine still emits them.

Captured 2026-09-18 on macos/aarch64 with the SDK's own argv
(`run <file> --json` plus `--max-cost-usd 0` for the budget case), a cleared
environment, a throwaway `HOME`, `NIKA_KEYCHAIN=off`, and a synthetic provider
key whose base URL pointed at a local canary socket (0 connections observed).

The `0.118.7-*` captures used the same argv (`--max-cost-usd 0` included), a
cleared environment, a throwaway `HOME`, `NIKA_KEYCHAIN=off`, `mock/echo`, and
no provider key at all. The gate's question was never answered.

| Prefix | Engine | Dialect |
|---|---|---|
| `0.118.7-*` | released `nika 0.118.7 (f3a31a6ee)`: the `@supernovae-st/nika-darwin-arm64@0.118.7` npm payload, `bin/nika` sha256 `8e1aeecb…2dd4` equal to its `INTEGRITY.json` | admitted lifecycle frames only |
| `0.119.0-*` | released `nika 0.119.0 (d2f89bedd)`, checksum and release attestation verified | pre-#1650: pretty `CheckReport`, plain teaching line, stderr-only refusal |
| `pr1679-*` | debug build of engine PR #1679 head `02247f40` (merged to main as `48ef9ac0`); not a release | one compact JSON object per pre-run refusal |

| File | Workflow | Exit |
|---|---|---|
| `*-sec004.*` | `exec` under `permits: {}` (`NIKA-SEC-004`) | 2 |
| `*-parse005.*` | `outputs: { greeting: { from: greet } }` (`NIKA-PARSE-005`) | 2 |
| `*-missing-file.*` | the workflow file does not exist (a finding with no `code`) | 3 |
| `*-budget1709.*` | a priced model under `--max-cost-usd 0` (`NIKA-1709`) | 2 |
| `*-input1708.*` | a required input not supplied (`NIKA-1708`); 0.119.0 writes stderr only | 3 |
| `0.119.0-hello.ndjson.stdout` | admitted `mock/echo` hello: six lifecycle frames | 0 |
| `0.119.0-admitted-failure.ndjson.stdout` | admitted run whose `nika:assert` fails: seven frames | 1 |
| `0.118.7-human-gate.ndjson.stdout` | a `nika:prompt` with no `default:` run unattended: `workflow_paused`, then `run_settled` with `status: "paused"` and `cause: "human_gate"`; four frames | 4 |
| `0.118.7-sigterm-cancel.ndjson.stdout` | a `nika:wait` run sent SIGTERM after its first frame: `workflow_cancelled`, then `run_settled` with `status: "cancelled"` and `cause: "operator"`; seven frames | 130 |

## Literal input channel (`c1683-*` · issue #116)

Replayed by `fake-nika-inputs.mjs`. Captured 2026-09-18 on macos/aarch64 with
the SDK's own argv (`run <file> --json --inputs-json - --max-cost-usd 0`, the
map on stdin), a cleared environment, a throwaway `HOME`, `NIKA_KEYCHAIN=off`
and a pure `nika:jq` workflow (no model seat, no network).

| Prefix | Engine | Dialect |
|---|---|---|
| `c1683-*` | clean integration build for engine #1683, `nika 0.120.0-dev (21ff7d53a)`, binary sha256 `0daa94a6e13f178461b30ffa76a3090c6bbc6a88050355f71b1903fc2977e301`; joins Compile and build-identity main, not a release | one compact `{"error":{"code","message"}}` per pre-run refusal, prose on stderr |

These are the bytes of a candidate, so they pin how the SDK decodes that
envelope, not what a released engine writes: recapture them from the release
that ships the channel.

| File | Stdin map | Exit |
|---|---|---|
| `c1683-unknown-input.*` | a key the workflow does not declare (`unknown_input`) | 3 |
| `c1683-type-mismatch.*` | the string `"42"` for a declared `integer` (`input_type_mismatch`) | 3 |
| `c1683-missing-required.*` | `{}` against four required inputs (`NIKA-1708`) | 3 |
| `c1683-duplicate-key.*` | `{"ticket":"a","ticket":"b",…}` (`invalid_inputs_json`) | 3 |
| `c1683-literal.ndjson.stdout` | admitted: `ticket` is the text `@env:NIKA_TEST_LITERAL`, kept literal; `workflow_started` names `api-caller` for supplied inputs and `file` for the default: seven frames | 0 |

Recaptured at 2026-09-18 15:01 UTC from the clean integration build above.
All eight refusal stdout/stderr files were byte-identical. The admitted seven-frame
trace was replaced with the new measured bytes, including Spec pin
`be8ff017d448c4d4e413d11c40613af0afb90754`. No envelope or refusal changed.

## Access pins (`0.123.1-access*` · NIK-267)

Replayed by `fake-nika.mjs`. Captured 2026-10-26 on macos/aarch64 with the
SDK's own argv (`run workflows/hello.nika --json --access=<pin>`), a cleared
environment, a throwaway `HOME` with no signing key, `NIKA_KEYCHAIN=off` and a
`mock/echo` workflow: no provider, no network, no seat. Without a key the
refusal writes no trace (`evidence: "none"`, no receipt); with one, the engine
also seals a one-event trace and the frame carries its receipt.

| Prefix | Engine | Dialect |
|---|---|---|
| `0.123.1-*` | released `nika 0.123.1 (cc7b51964)`: the `v0.123.1` release tarball `nika-macos-arm64-0.123.1.tar.gz`, sha256 `26e31cbb…4923` as its `SHA256SUMS` lists, binary sha256 `8e493fa9…3b54` | a pin refused before the prologue: one compact `run_settled` frame, `status: "failed"`, `cause: "refused"`, the code on `error`, and `access_plan` naming the rejected path; prose on stderr |

| File | Pin | Exit |
|---|---|---|
| `0.123.1-access1802.*` | `bogus-seat`: names neither an access class nor a known agentic CLI (`NIKA-1802`) | 3 |
| `0.123.1-access1801.*` | `local` for `mock/echo`: the model has no path matching the pin (`NIKA-1801`) | 3 |

## Skipped, recovered and cancelled tasks (`0.123.2-*`)

Replayed by `test/run-events.test.ts`. Captured 2026-10-26 on macos/aarch64
with the SDK's own argv (`run workflows/lifecycle.nika --json`), a cleared
environment, a throwaway `HOME` with no signing key (so the run settles
`evidence: "unsealed"`), `NIKA_KEYCHAIN=off` and a workflow of three
`nika:assert` tasks: no model, no provider, no network.

| Prefix | Engine | Dialect |
|---|---|---|
| `0.123.2-*` | released `nika 0.123.2 (5591478a7)`: the `@supernovae-st/nika-darwin-arm64@0.123.2` npm payload, `bin/nika` sha256 `910e9736…8856` equal to its `INTEGRITY.json` | admitted lifecycle frames, a `task_*` ending per task |

```yaml
nika: probe-sdk-lifecycle
permits:
  tools: ["nika:assert"]
tasks:
  skipped_one:
    on_error: { skip: true }
    invoke: { tool: "nika:assert", args: { condition: false, message: "skip me" } }
  recovered_one:
    on_error: { recover: { ok: false } }
    invoke: { tool: "nika:assert", args: { condition: false, message: "recover me" } }
  cancelled_one:
    after: { recovered_one: failure }
    invoke: { tool: "nika:assert", args: { condition: true } }
```

| File | Run | Exit |
|---|---|---|
| `0.123.2-skipped-cancelled.ndjson.stdout` | `task_skipped` for `skipped_one`; `task_recovered` then `task_completed` for `recovered_one`; `task_cancelled` for `cancelled_one` (its `after:` edge waits for a failure that was recovered); `run_settled` `succeeded`: fourteen frames | 0 |
