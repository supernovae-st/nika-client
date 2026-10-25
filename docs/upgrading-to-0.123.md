# Upgrading to 0.123

`@supernovae-st/nika` 0.123.1 bundles engine 0.123.1
(`nika 0.123.1 (cc7b51964)`) and speaks its machine protocol, **2**. Engines
and servers up to 0.122 speak protocol 1. Each package version pairs with
one protocol generation, so the move from 0.120.x is one rule:

> **Upgrade the package and every `nika serve` it talks to together.**

| Your package | Your engine or server | Result |
|---|---|---|
| 0.123.x | 0.123.x | works |
| 0.123.x | 0.122 and older (protocol 1) | refused at the identity probe, before any job: `NikaCompatibilityError`, `capability: 'engineIdentity'`, naming the engine version |
| 0.120.3 | 0.120.x | works; that pair stays as it was |
| 0.120.3 | 0.123.x | refused at identity by the 0.120.3 package |

Engines 0.121 and 0.122 have no matching package: they already sent compile
questions of type `choice` while announcing protocol 1, which the 0.120.3
package refuses as a protocol error.

## Steps

1. **Update the package.** `npm install @supernovae-st/nika@0.123.1`, then
   check what you installed:

   ```sh
   node -p "require('@supernovae-st/nika/package.json').version"   # 0.123.1
   ./node_modules/.bin/nika --version                              # nika 0.123.1 (cc7b51964)
   ```

2. **Point `NIKA_BIN` at a 0.123 engine, or unset it.** An explicit `bin` or
   `NIKA_BIN` wins over the bundled engine, and the package's own `nika`
   command refuses a protocol-1 engine there too
   (`NIKA_BIN=<a 0.122 binary> npx nika --version` exits 1).

3. **Upgrade each server.** Install engine 0.123.1 where your `nika serve`
   runs (`brew install supernovae-st/tap/nika`,
   `curl -LsSf https://nika.sh/install.sh | sh`, or the container image
   `ghcr.io/supernovae-st/nika:0.123.1`), stop the old server as usual
   (Ctrl-C drains running and queued jobs for up to 30 seconds), and start
   the new one with the same flags. Then check its identity:

   ```sh
   curl -s http://127.0.0.1:8787/health   # "engineVersion":"0.123.1", "machineProtocolVersion":2
   ```

4. **Run your tests against the new pair.** Nothing in `check`, `run`,
   `events`, `result`, `cancel`, `attachRun`, `schedule` or `traceVerify`
   changed its signature: 0.123.0 only adds exports. The changes below are
   in the data those methods return.

## What changed in the data

- **Compile questions.** A question may now be `type: 'choice'` with
  `options[]` (at least one); answer it with one option's `key`. A `text` or
  `literal` question carries no options. An outcome may carry
  `requested_trigger`: the schedule the intent asks for, to bind through
  `schedule()`, never a grant. See [compile.md](compile.md).
- **Provider-backed compile.** Over HTTP, `cognition: 'explicitProvider'`
  asks a server seated with `nika serve --authoring-model` for one authoring
  round (`compileNativeV2`), its `replay_token` answers the kept round, and
  the judged answer round (`compileJudgedAnswerRound`) replays the kept plan
  with your answers and only judges it. `nextCompileRequest()` builds the next
  round and `isNikaCompileHeld()` reads the held marker. Generation-2
  requests also carry what your local engine observes of the files the
  intent names (`observed_world`; `observe: false` turns it off). Locally,
  `authoringModel`, `decisionModel`, `limits`, `fresh` and `output` map to the
  CLI's flags.
- **Scheduled receipts.** A `catch-up-once` firing's `receipt.origin` may
  carry `missed_first` and `missed_count`: the silence it answers for. If you
  validate receipt fields yourself, allow them.
- **Server frames.** `JobEvent.at` (when the server admitted the event) and
  `evidence` (a reported journal loss, copied to `result.evidence`) are now
  part of the pinned contract the package checks.
- **A long provider round no longer fails at 300 seconds.** The package
  posts a provider round without a deadline through `node:http`, so Node's
  built-in `fetch` header timeout no longer cuts it short.

The full list is in the [changelog](https://github.com/supernovae-st/nika-client/blob/main/CHANGELOG.md). The engine's own
changes are in its [release notes](https://github.com/supernovae-st/nika/releases/tag/v0.123.0),
and what 0.123 does not do yet is on the
[known limits](https://docs.nika.sh/changelog/known-limits) page.

## Coming from 0.115 or 0.116

Read [migrating-to-0.116.md](migrating-to-0.116.md) first: it maps the
retired 0.115 clients (`@supernovae-st/nika-client`, `LocalNika`) onto the
one `Nika` class, then come back here.
