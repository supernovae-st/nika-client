# Upgrading to 0.123

<!-- TODO(0.124.0): add the tag commit in this page, as `nika 0.124.0 (<9 hex>)`, here and in step 1. -->
`@supernovae-st/nika` 0.124.0 bundles engine 0.124.0 (`nika 0.124.0`) and
speaks its machine protocol, **2**, as 0.123 did. Engines and servers up to
0.122 speak protocol 1. Each package version pairs with
one protocol generation, so the move from 0.120.x is one rule:

> **Upgrade the package and every `nika serve` it talks to together.**

| Your package | Your engine or server | Result |
|---|---|---|
| 0.124.x | 0.124.x | works: the pair this package is tested with |
| 0.123.x or 0.124.x | 0.123.x or 0.124.x | passes the identity probe (one protocol, 2); each call still checks the capability it needs (`artifacts` needs engine 0.123.2 or later) |
| 0.123.x or 0.124.x | 0.122 and older (protocol 1) | refused at the identity probe, before any job: `NikaCompatibilityError`, `capability: 'engineIdentity'`, naming the engine version |
| 0.120.3 | 0.120.x | works; that pair stays as it was |
| 0.120.3 | 0.123.x or later | refused at identity by the 0.120.3 package |

Engines 0.121 and 0.122 have no matching package: they already sent compile
questions of type `choice` while announcing protocol 1, which the 0.120.3
package refuses as a protocol error.

## From 0.123 to 0.124: the same protocol

0.124 keeps machine protocol 2 and changes no `nika serve` route, schema or
field this package reads closed, so moving from 0.123.x needs no new rule:
upgrade the package and every `nika serve` together, with the steps below.
The package itself changes one word a local `run.events()` consumer may
match: a skipped or cancelled task now arrives as `task.skipped` or
`task.cancelled`, no longer as an `engine.event` (see
[runs.md](runs.md#watch-a-run-runevents)). The rest is in the data your app
reads (the
[changelog](https://github.com/supernovae-st/nika-client/blob/main/CHANGELOG.md)
lists it):

- **More workflows are refused before they run.** A child workflow is judged
  through the task that calls it, and untrusted content is followed through
  a file a builtin reads (`NIKA-SEC-009`, `NIKA-SEC-014`). A gate inside the
  child does not clear its caller: give the parent a blocking `nika:prompt`
  of its own before the call, and bind a confirm gate's answer on a call
  whose child acts (`with: { go: "${{ tasks.ask.output }}" }` and
  `when: ${{ with.go == true }}`). On an `infer:` seated over ACP
  (`run.access.protocol: acp`), `temperature`, `max_tokens`, an enabled
  `thinking` budget or a `vision:` URL blocks `run_ready`; a seat route
  without ACP does not send them, and check does not flag them.
  `temperature` on `openai/gpt-5`, `gpt-5-mini`, `gpt-5-nano` and the
  o-series is refused. Run `./node_modules/.bin/nika check` on your
  workflows before you switch.
- **A failed harness turn fails its task** (`NIKA-1804`, `NIKA-1805`) where
  0.123 settled it `succeeded` with the error text as its output.
- **A refused `vars` pair names its code** (`unknown_input`,
  `input_type_mismatch`) instead of the package's `run_refused`.
- **The artifact manifest lists more files**: the sheet `nika:image_compose`
  saves, and an agent's image saved with `images: { save: }` beside the image
  itself.
- **The keyless system voice is unpriced local work**: a run whose only spend
  it is settles `unpriced`.
- **Under a cost cap, paid media is priced or refused.** The engine bills
  image and speech calls from a dated price table against `maxCostUsd`, a
  project `ceiling:`, a server's `--run-cost-ceiling` or a schedule's
  `maxCostUsd`, as it already did xAI images: OpenAI `gpt-image-2`,
  `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare` (these two from the
  usage they report), five Gemini image models, OpenAI `tts-1` and
  `tts-1-hd`, and nine ElevenLabs models. Any other paid media call is
  refused before any request (`NIKA-1709`, or `NIKA-1704` when only the run
  decides it), OpenAI's default voice `gpt-4o-mini-tts`, `gpt-image-1.5` and
  `gpt-image-1-mini` included, so a beat on one of them reads `UNREADY` at
  `nika arm`. Move speech to `tts-1`, `tts-1-hd`, a priced ElevenLabs model
  or the keyless `provider: system` voice, and images to `gpt-image-2` or a
  2.5 model.
<!-- TODO(0.124.0 V-1 merge): re-check this item against the merged supernovae-st/nika#1851 (written from its head dfe29896b), or drop it if the change did not land. -->
- **A `vision:` file is a read.** Grant each file in `permits.fs.read`: with
  no `permits:` block it is refused (`NIKA-AUTH-006`); outside the grant, or
  under a block that grants no read at all, a computed path included, it is
  refused too (`NIKA-SEC-004`). `./node_modules/.bin/nika check
  --infer-permits <file>` prints the block for a literal path. A secret in a
  vision entry now needs `egress: [{ to: "infer" }]`.

## Steps

1. **Update the package.** `npm install @supernovae-st/nika@0.124.0`, then
   check what you installed:

   ```sh
   node -p "require('@supernovae-st/nika/package.json').version"   # 0.124.0
   ./node_modules/.bin/nika --version                              # nika 0.124.0 (<tag commit>)
   ```

2. **Point `NIKA_BIN` at a 0.123 or later engine, or unset it.** An explicit `bin` or
   `NIKA_BIN` wins over the bundled engine, and the package's own `nika`
   command refuses a protocol-1 engine there too
   (`NIKA_BIN=<a 0.122 binary> npx nika --version` exits 1).

3. **Upgrade each server.** Install engine 0.124.0 where your `nika serve`
   runs (`brew install supernovae-st/tap/nika`,
   `curl -LsSf https://nika.sh/install.sh | sh`, or the container image
   `ghcr.io/supernovae-st/nika:0.124.0`), stop the old server as usual
   (Ctrl-C drains running and queued jobs for up to 30 seconds), and start
   the new one with the same flags. Then check its identity:

   ```sh
   curl -s http://127.0.0.1:8787/health   # "engineVersion":"0.124.0", "machineProtocolVersion":2
   ```

4. **Run your tests against the new pair.** Nothing in `check`, `run`,
   `events`, `result`, `cancel`, `attachRun`, `schedule` or `traceVerify`
   changed its signature: 0.123.0 and 0.124.0 only add exports. The changes
   are in the data those methods return: from 0.123, in the section above;
   from 0.120.x, below.

## What changed in the data from 0.120

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
changes are in its release notes
([0.123.0](https://github.com/supernovae-st/nika/releases/tag/v0.123.0),
[0.124.0](https://github.com/supernovae-st/nika/releases/tag/v0.124.0)),
and what 0.124 does not do yet is on the
[known limits](https://docs.nika.sh/changelog/known-limits) page.

## Coming from 0.115 or 0.116

Read [migrating-to-0.116.md](migrating-to-0.116.md) first: it maps the
retired 0.115 clients (`@supernovae-st/nika-client`, `LocalNika`) onto the
one `Nika` class, then come back here.
