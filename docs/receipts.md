# Prove what ran: receipts, traces and signing keys

Every run leaves a *trace*: a tamper-evident, hash-chained record of what
happened, written by the engine (locally under `.nika/traces/` in its working
directory). With a signing key, the engine also *seals* the trace: it signs
the record when the run ends. The run hands your code a *receipt*, and
`traceVerify(receipt)` asks the engine to check the trace against it. The
package never reads a trace or does cryptography itself.

## What `traceVerify()` answers

Measured on engine 0.123.0 with the quick-start file:

| Where the run happened | `traceVerify()` answers | What it means |
|---|---|---|
| Local engine, with a key it can read | `{ verified: true, verdict: 'verified' }` | the record is sealed and matches the receipt |
| Local engine, no key it can read | `{ verified: false, verdict: 'invalid', reason: 'receipt_mismatch' }` | the run still succeeded, but its record is unsealed |
| `nika serve` with a key it can read | `{ verified: true, verdict: 'sealed', reason: 'sealed' }` | the job's journal is sealed and names this receipt's trace |
| `nika serve` without one | `{ verified: true, verdict: 'ok', reason: 'unsealed' }` | the job's journal is intact but unsigned |

- **Locally**, `traceVerify` runs the engine's verifier on the trace the
  receipt names (`nika trace verify`), then checks that the receipt matches
  the engine's evidence for it (`nika trace evidence`): `verified: true`
  means both held. `receipt_mismatch` is also the answer for a tampered or
  edited receipt: do not read every one as "just unsigned".
- **Over HTTP**, `traceVerify` asks the server for its verdict on the journal
  it wrote for the job (`GET /v1/jobs/{id}/trace/verify`). The verdict is the
  CLI's word, in lower case: `ok` (intact, unsigned), `sealed`, `anchored` and
  `replayed` hold; `incomplete`, `tampered` and `broken` do not; `unchained`,
  `empty`, `unreadable`, `refused`, `line-over-long` and `unknown` are the
  CLI's refusal classes; `unavailable` means the server has no journal for the
  job (refused before its first event, still queued, or a backend that keeps
  none). `reason` is always present: beside a verdict that holds it names the
  seal tier (`sealed`, `unsealed`). The package sets `verified: true` only for
  a verdict that holds **and** names this receipt's `trace_id`.

> [!WARNING]
> **Over HTTP, check `proof.verified` first.** `verdict` and `reason` are the
> server's words about the job's journal: they stay `sealed` even when the
> receipt you passed does not match that journal, and then `verified` is
> `false` (measured on 0.123.0 with a receipt whose `trace_id` was changed).
> Treat a job as sealed only when
> `proof.verified && ['sealed', 'anchored', 'replayed'].includes(proof.verdict ?? '')`;
> `verified: true` with `verdict: 'ok'` means intact but unsigned.

> [!IMPORTANT]
> A verified receipt proves that the run's record is intact and matches the
> receipt. It does not prove that the workflow was right, or that a person
> read its output. The record is tamper-evident, not tamper-proof.

## Admitted, executed, sealed: three different facts

| Fact | How you see it | What it is not |
|---|---|---|
| **Admitted** | `run()` resolves with a `NikaRun`. A workflow the engine refuses makes `run()` throw `NikaOperationError` (`NIKA-SEC-004`, `NIKA-PARSE-005`, `NIKA-1708`…), and no run exists. `check()` shows the same verdict without running: `clean: false` and the findings. | Not a successful execution. |
| **Executed** | `run.result()` and `isNikaRunSucceeded(result)`. An admitted failure is data (`status: "failed"`). A human gate is `paused` (a `run.waiting` event), not success. | Not proof that the record is sealed. |
| **Sealed** | `result.receipt.sealed` and `traceVerify(receipt)`. Tamper-evident, not tamper-proof; not replayed unless you ask the CLI (`--replay`); not anchored without a sidecar. | Not "the workflow was correct", and not "a person read the output". |

Measured on engine 0.123.0 with the quick-start file: `run.events()` yields
the same six events with or without a signing key. With a key, the receipt
reads `sealed: true` and `traceVerify` returns
`{ verified: true, verdict: 'verified' }`. With an empty `HOME` and no key,
the same run **succeeds** with `sealed: false`, and `traceVerify` returns
`{ verified: false, verdict: 'invalid', reason: 'receipt_mismatch' }`, while
the engine's own `nika trace verify` still calls the journal chain OK and
unsealed. The event count that command prints counts journal entries; it is
not the number of `run.events()`.

**Watch the three facts from TypeScript, then one changed byte.**

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/supernovae-st/nika-client/HEAD/media/stills/sdk-admitted-executed-sealed.png">
    <img src="https://raw.githubusercontent.com/supernovae-st/nika-client/HEAD/media/gifs/sdk-admitted-executed-sealed.gif" alt="node gate.mts on a workflow that runs ls under permits: {} prints check refused · exit 2 and NIKA-SEC-004, then run not started: no run, no events, no trace; a one-line permits fix checks clean and runs. node prove.mts with no signing key prints receipt sealed false · 5 events and not verified · invalid · receipt_mismatch; after NIKA_KEYCHAIN=off nika key init it prints sealed true · 6 events and verified. node tamper.mts changes one byte on line 4 of the trace, and node verify.mts prints not verified · invalid and engine BROKEN at line 5" width="860">
  </picture>
</p>
<p align="center"><sub>Admitted: <code>check()</code> and <code>run()</code> refuse the file and no run exists. Executed, not sealed: with no key the run succeeds and the receipt reads <code>sealed false</code> over 5 journal entries. Sealed: after <code>NIKA_KEYCHAIN=off nika key init</code> the next run of the same file has 6, the last one <code>run_sealed</code>, and verifies. Then one changed byte, and the stored receipt fails: <code>BROKEN at line 5</code>. Recorded from <code>@supernovae-st/nika</code> 0.123.0 and its bundled engine; the runs are <code>mock/echo</code> rehearsals.<br>▶ <a href="https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-admitted-executed-sealed.mp4?raw=true">MP4</a> · <a href="https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-admitted-executed-sealed.txt">transcript</a> · <a href="https://github.com/supernovae-st/nika-client/tree/main/scripts/media/scenes/sdk-admitted-executed-sealed">the programs it runs</a></sub></p>

## What a receipt carries

Pass a receipt back unchanged, and store it with what it proves.

- **A local run's receipt** carries the proof fields (`trace_path`,
  `chain_head`, `chain_len`, `sealed`) with `trace_id`, `execution_id`,
  `snapshot_digest` and `receipt_format`.
- **A `nika serve` job's receipt** carries the job's identity (`job_id`,
  `execution_id`, `trace_id`, `snapshot_digest`, `origin`) and the
  `chain_head`. Store it with the job id. A scheduled job's `origin` names the
  firing; see [server.md](server.md#schedules).

A trace can hold model outputs and file contents, so keep `.nika/` out of
git and treat traces as application data.

## Signing keys: where the engine finds them

Run-signing keys belong to the engine. `nika key init` mints one,
`nika key trust` prints its public key and fingerprint to enroll on other
machines, `nika key rotate` retires it and mints a new one (records signed
with a retired key stay verifiable), and, on Linux, `nika key align` copies a
Secret Service key to the files the other processes read.

Which key a process signs with depends on the process and, for `nika` run
from a terminal, on the platform. Nika 0.123:

| Process | Opens an OS keychain? | Signs with, in this order |
|---|---|---|
| `nika` run from a terminal, on macOS | no: Nika 0.123 never opens the keychain on macOS, even from a terminal (`nika doctor` says `the keychain is not opened by this ad-hoc build`) | `NIKA_RUN_KEY_FILE` + `NIKA_RUN_PUB_FILE`, then `~/.nika/keys/` |
| `nika` run from a terminal, on Linux | yes: the desktop's Secret Service, when one answers | `NIKA_RUN_KEY_FILE` + `NIKA_RUN_PUB_FILE`, the Secret Service, then `~/.nika/keys/` |
| the engine your app starts (`new Nika()`) | never: it has no terminal | `NIKA_RUN_KEY_FILE` + `NIKA_RUN_PUB_FILE`, then `~/.nika/keys/` |
| `nika serve` | never | `NIKA_RUN_KEY_FILE` + `NIKA_RUN_PUB_FILE`, then `~/.nika/keys/` |

So the key your app's runs use must be a file, and `NIKA_KEYCHAIN=off` makes
one on every platform:

- **A new machine.** `NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init`
  writes the key to `~/.nika/keys/` (mode `0600`), where every process reads
  it.
- **Without the variable, on Linux.** From a terminal, `nika key init`
  refuses with `run-signing key material already exists`, even on a new
  machine: off macOS the engine cannot see whether the keychain already holds
  a run-key, so it never risks replacing one. On a desktop,
  `nika key init --force` then stores the key in the Secret Service only,
  where your app's engine and `nika serve` never look. To repair that, run
  `./node_modules/.bin/nika key align` once from a terminal: it copies the
  Secret Service key to `~/.nika/keys/`, retiring any other file key it
  replaces, so the CLI, your app and `nika serve` sign with one key.
- **Without the variable, on macOS.** `nika key init` from a terminal writes
  the files too, unless the keychain holds a run-key that Nika 0.122 or older
  stored there. Then it refuses, and the repair it names, `nika key align`,
  cannot succeed with Nika 0.123, which can neither read nor copy that key: it
  exits with `this process does not open the keychain`. The variable skips
  the keychain check and mints a new key as files, a new signing identity
  beside the old keychain key.
- **CI and servers.** Give the engine an explicit pair through
  `NIKA_RUN_KEY_FILE` and `NIKA_RUN_PUB_FILE`; `nika key init` with those two
  variables set writes the pair there.
- **Rotation.** `NIKA_KEYCHAIN=off nika key rotate` retires the file key to
  `~/.nika/keys/retired.pub` and writes the next one as files. Without the
  variable, on a Linux desktop terminal, the new key would go to the Secret
  Service, and your app would keep signing with the old file key.
- **Check it.** `nika doctor` prints a `run-key` line for the process that
  runs it. To see what the engine your app starts sees, take the terminal
  away: `./node_modules/.bin/nika doctor 2>&1 | cat` names the key file it
  signs with, or says `none · runs stay unsigned`.

`NIKA_KEYCHAIN=off` skips only the keychain; the file and explicit-pair paths
stay. Store receipts and public trust material in your app. Never copy a
private run key into SDK configuration, source control, workflow inputs or an
HTTP request.
