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
