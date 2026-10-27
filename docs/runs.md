# Runs: results, inputs, events and cancellation

A run is one admission of a workflow. `nika.run(workflow, options)` resolves
with a `NikaRun` once the engine admitted it, and the handle owns everything
that follows: its events, its result, its status and its cancellation. This
page covers both doors (the bundled engine and `nika serve`); where they
differ, it says so. Server specifics live in [server.md](server.md), proof in
[receipts.md](receipts.md), and every error in [errors.md](errors.md).

```ts
import { Nika, isNikaRunSucceeded } from '@supernovae-st/nika';

const nika = new Nika();
const run = await nika.run<{ answer: number }>('flow.nika', { maxCostUsd: 0.05 });
for await (const event of run.events()) console.log(event.kind, event.status);
const result = await run.result();
console.log(isNikaRunSucceeded(result) ? result.outputs?.answer : result.status);
```

| `NikaRun` member | What it gives you |
|---|---|
| `run.id` | The run's id: the server's durable job id over HTTP, a throwaway id on a local engine |
| `run.events(options?)` | The run's events as they happen, or replayed from the start |
| `run.result()` | The final result, settled once; a failed run resolves, it does not throw |
| `run.status()` | The current status without waiting (server runs only) |
| `run.cancel()` | Asks the engine to stop the run; every call returns the same request |
| `run.artifacts(options?)` | What the settled job produced, as its sealed journal lists it (server runs only) |
| `run.downloadArtifact(artifact, options?)` | One artifact's bytes as a stream that closes once they are proven (server runs only) |
| `run.readArtifact(artifact, options?)` | One artifact's proven bytes, whole, up to `maxBytes` (server runs only) |
| `run.done` | The same promise as `run.result()`, kept for older code |

Every member is bound to its run, so you can pass it around:
`const { events, result } = run`. The handle observes, settles, reports and
cancels its run, and on a server reads what its job produced; checking, proof,
catalogs and authoring stay on `Nika`.

## Check a workflow without running it: `check()`

You do not need `check()` before `run()`: the engine checks on every run, and
a red file never becomes a run. Use `check()` to show the audit without
running anything, for example in a CI step or an editor.

```ts
const report = await nika.check('hello.nika', { nativeStrict: true });
console.log(report.clean, report.exitCode);
```

- **On a local engine** you get the engine's whole report: `clean`,
  `exitCode`, its `findings[]` and its `verdicts`. Options: `model` (check
  against another model), `nativeStrict` (the engine's `--native-strict`
  audit), `access` (judge the access plan under a pin, see
  [Pin the access path](#pin-the-access-path-access)) and `signal` (stops
  this check only).
- **On a server, by served name**, you get the server's short answer:
  `clean: true`, or its typed refusal with `clean: false`. The package never
  invents findings or an exit code. An explicit local path (`./hello.nika`)
  is captured locally and returns the engine's findings and exit code.
  `model` and `nativeStrict` are refused over HTTP with a typed error;
  `access` rides a served name only.

Each finding keeps the engine's fields (`NikaCheckFinding`): `code`,
`message`, `severity`, `gate`, `kind`, `task`, `docs_url`, and `span`, the
byte range of the workflow file it names (`start` inclusive, `end`
exclusive), so an editor can underline it. From engine 0.124 a parse refusal
in a local report carries a `span` too. A local check of a workflow that calls
a child workflow (`invoke: { workflow: ./child.nika }`) reads the children,
and engine 0.124 judges each call as the tasks the child stands for: a
lethal trifecta (`NIKA-SEC-009`) or a confirm gate that does not stop an
effect (`NIKA-SEC-014`) is refused through a child as it is inline. The
report lists those calls in `composed_calls`, which rides untyped.

The same audit, for humans, is `./node_modules/.bin/nika check hello.nika`.

## Read the result

```ts
import { Nika, isNikaRunSucceeded } from '@supernovae-st/nika';

const run = await new Nika().run<{ answer: number }>('flow.nika');
const result = await run.result();
if (isNikaRunSucceeded(result)) {
  console.log(result.outputs?.answer); // outputs stay typed and optional
} else {
  console.error(result.status, result.error?.code, result.error?.message);
  process.exitCode = 1;
}
```

| `result.status` | What happened |
|---|---|
| `succeeded` | The run finished. Its `outputs` are on the result, when the workflow declares any. |
| `failed` | The engine admitted the run and it failed. `result.error` carries the engine's `code`, `message` and, when one task failed, its `task`. |
| `paused` | A human gate holds the run. It is neither a failure nor a finished run. |
| `cancelled` | The run was cancelled. |
| `interrupted` | The engine lost the execution; how it would have ended is unknown. |

> [!WARNING]
> An admitted failure **resolves**: `run.result()` does not throw for a failed
> workflow. A `try { await run.result() } catch {}` alone never catches one,
> so a CI job or an app must read `result.status`, or call
> `isNikaRunSucceeded(result)`, and treat anything but `succeeded` as its own
> failure. Otherwise a red run passes silently.

`run.result()` rejects only for transport, protocol, configuration and
compatibility problems, with typed errors (see [errors.md](errors.md)). None
of those says the run failed: it may still be running.

`isNikaRunSucceeded` returns `false` for paused, failed, cancelled and
interrupted runs. It only reads the engine's status and never fills in
missing outputs. A paused run arrives as a `run.waiting` event, never as
`run.settled`, and `result.status` keeps the engine's word, `paused`: show it
as waiting, and never let a CI job pass it as success.

A paused run waits for an answer this package cannot give: `run()` has no
way to answer a gate. On a local engine the question is on the native
`workflow_paused` frame, an `engine.event` whose `raw.fields` hold it in the
`message` row; answer it from a terminal with
`nika run --resume <trace> --answer <task>=<value>`. From engine 0.124, a
command a Codex seat asks to run outside its sandbox always pauses, whatever
`permits.exec` grants, and its question names the command and the reason on
one line (`Run command: curl -sS https://example.com (reason: …)`). A
server's frames do not carry the question: the job reads `paused`.

`result.settlement` carries the engine's own account of the ending: its
`cause` (`normal`, `human_gate`, `task_failed`, `budget`, `operator`…), the
task tally, the elapsed time and the spend with its pricing qualifier. An
unknown cost is never reported as zero. From engine 0.124 the keyless system
voice (`nika:tts_generate` with `provider: system`) counts as an unpriced
call, like a mock or local model: a run whose only spend is that voice
settles with `spend.qualifier` `unpriced` and `unpriced_calls: 1`, and its
native task frame names why (`cost_unpriced: local_model`).

## Pass your app's data: `inputs`

`inputs` fills the workflow's declared `inputs:` by name, with the same
meaning on both transports:

```ts
const run = await nika.run('support-triage.nika', {
  inputs: { ticketId: '42' },
  // idempotencyKey: `triage-${ticket.id}`, // HTTP only
});
```

**Values are strict JSON and stay literal.** `'42'` stays a string and `42` a
number. `'@env:HOME'` and `'${{ tasks.x.output }}'` are plain text: never read
from the environment, never evaluated. Nothing is converted to the declared
type.

**The engine judges them before any run exists.** An undeclared key
(`unknown_input`), a value that does not fit its declared type
(`input_type_mismatch`) or a missing required input (`NIKA-1708`) makes
`run()` reject with a `NikaOperationError` carrying that code, `status: 3` on
a local engine and `status: 422` over HTTP. The values you pass are recorded
with `api-caller` provenance; declared defaults keep `file`.

**The package refuses what JSON would silently lose**, before it starts or
sends anything: `undefined`, a function, a symbol, a bigint, `NaN` or
`Infinity`, a cycle, a class instance (a `Date`, a `Map`), an object whose
prototype only pretends to be plain, an array hole, an accessor. That is a
`NikaConfigurationError` naming the path (`inputs.ticketId is undefined`),
never the value. None of your code runs while the map is judged: no getter is
called, and a `Proxy` is refused before it is read. The serialized map is
limited to 1 MiB on both transports. Do not put a secret in `inputs`.

**The engine must advertise the channel**, and the package checks before
admission:

- Local: `inputsLiteral` in `nika --sdk-identity`. The values travel on the
  engine's stdin (`nika run --inputs-json -`), so they never appear in a
  process listing.
- Server: `jobInputs` in `GET /health`, for a workflow run by its served
  name. A snapshot of a local file (`./flow.nika`) freezes its inputs, so an
  HTTP run of a local path refuses `inputs`, even an empty map.

Engine 0.123.0 advertises both. An engine without the capability makes `run()`
reject with `NikaCompatibilityError` (`capability: 'inputsLiteral'` or
`'jobInputs'`) and nothing runs. The SDK never falls back to `--var`. A server
that merely answers 202 has agreed to nothing: one older than this channel
accepts the field and ignores its values.

`vars` is deprecated. It remains the local `--var KEY=VALUE` operator
channel, unchanged: the engine reads `@env:NAME` from its environment and
converts text to the declared type, so it cannot carry literal values and has
no HTTP form. Passing `inputs` and `vars` together rejects `run()`; they are
never merged. From engine 0.124, a `vars` pair the engine refuses carries the
same code as `inputs` (`unknown_input`, `input_type_mismatch`); engine 0.123
named none, so the package's `run_refused` stood in its place.

## Pin the access path: `access`

A workflow's `model:` picks the intelligence; an access pin picks the path
the engine takes to it, the value `nika run --access` takes. It is an access
class (`local`, `mock`, `harness`, `oauth`, `api`) or a harness seat
(`claude-code`, `codex`, `copilot`, `gemini-cli`, `grok-build`, `kimi-code`,
`opencode`, `qwen-code`), the words engine 0.123.1 knows. The type,
`NikaAccessPin`, lists them for completion and still takes any string: the
engine, never the package, judges a pin.

```ts
const run = await nika.run('triage.nika', { access: 'codex' });
const report = await nika.check('triage.nika', { access: 'codex' });
console.log(report.verdicts?.access_ready, report.verdicts?.blockers);
```

A pin is a pin: the engine refuses one it does not know or that is retired
(`NIKA-1802`), or one the workflow's model cannot use (`NIKA-1801`), and it
never takes another path or model instead. Each door reports that refusal as
the engine wrote it:

| | Local engine | `nika serve` |
|---|---|---|
| Sent as | one argv element, `--access=<pin>` (a pin that starts with `-` stays a value) | `access` in the `POST /v1/jobs` or `POST /v1/check` body, beside a served name |
| A pin the engine takes | the run uses that path; `run_settled` lists it in `access_plan` with `pinned: true` | the job uses that path |
| An unknown, retired or unusable pin | `run()` resolves and `run.result()` settles `failed`: `error.code` `NIKA-1802` or `NIKA-1801`, `settlement.cause` `refused`, `exitCode` 3; no task ran | the server admits the job (202), its execution refuses the pin, and `run.result()` settles `failed` with `error.code`, no `settlement` |
| An empty or blank pin | the same, `NIKA-1802` | `run()` rejects with `NikaOperationError`: `code` `NIKA-1802`, `status` 422 |
| `check({ access })` | the report judges the access plan under the pin: an unusable pin keeps `clean: true` (the file holds), with `verdicts.access_ready: false` and the refusal in `verdicts.blockers` | the server's check is source-only and evaluates no access plan: it acknowledges any other pin, and refuses an empty one with `clean: false`, `error.code` `NIKA-1802` |
| A local file (`./flow.nika`) | the pin applies | refused before any capture or request: a snapshot carries no pin (`NikaCompatibilityError`, `capability: 'snapshotAccess'`) |

The package itself refuses only a value neither door can carry unchanged,
before anything starts: a non-string, a NUL byte or a lone surrogate
(`NikaConfigurationError`, `run({ access })` or `check({ access })` in its
message). Over HTTP the pin is part of the request bytes an idempotency key
binds: a retry sends the same pin, and another pin under the same key is an
`idempotency_conflict`. Measured on engine 0.123.1.

## Watch a run: `run.events()`

`run.events()` yields `NikaRunEvent`s: a lifecycle `kind` that means the same
on both transports, plus the exact engine frame on `event.raw`.

```ts
for await (const event of run.events()) {
  switch (event.kind) {
    case 'run.started': break;
    case 'task.completed': console.log('done:', event.task); break;
    case 'task.failed': console.error(event.task, event.error?.code); break;
    case 'run.waiting': console.log('a human gate holds the run'); break;
    case 'run.settled': console.log('ended:', event.status); break;
    case 'run.interrupted': console.warn('the engine lost this execution'); break;
    default: break; // new kinds may come: event.raw.kind names the frame
  }
}
```

For the quick-start file on a local engine you get six events:
`run.started`; `task.scheduled`, `task.started` and `task.completed` for the
task `greeting`; one `engine.event` (the engine's `workflow_completed`); then
`run.settled` with `succeeded`. That holds with or without a signing key
(measured on engine 0.123.0): a sealed run's seal is the last line of its
trace (`run_sealed`), and that run streamed no `run_sealed` frame, so read
`result.receipt.sealed` to know whether a run was sealed. A `nika serve` run
of the same file yields two events, `run.started` and `run.settled`: the
server streams no per-task frames, and the package never invents one. A
server job admitted with `inputs` yields three: the server first records
`execution.queued` (sequence 1, before `execution.started`), which the
package names `engine.event`, with no `status` (the frame's `queued` stays on
`event.raw.status`). Measured on engine 0.123.1; an empty `inputs` map adds
no such frame.

**Watch a four-task run stream its events.**

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/supernovae-st/nika-client/HEAD/media/stills/sdk-events.png">
    <img src="https://raw.githubusercontent.com/supernovae-st/nika-client/HEAD/media/gifs/sdk-events.gif" alt="nika check brief.nika plans 3 waves and 4 tasks. watch.mts loops over run.events() and prints each event's time and kind. node watch.mts prints 16 events: at 0.0 s run.started, four task.scheduled, audience and risks started and completed; at 2.0 s review started, an engine.event (permit_checked), review completed, brief started and completed, an engine.event (workflow_completed); at 2.1 s run.settled succeeded; then result succeeded · cause normal · 4/4 tasks ok" width="860">
  </picture>
</p>
<p align="center"><sub><code>watch.mts</code> prints each event of a four-task workflow with the time it arrived: sixteen events, the engine's <code>permit_checked</code> and <code>workflow_completed</code> frames as <code>engine.event</code> (their kind on <code>event.raw</code>), then <code>result()</code>: <code>succeeded · cause normal · 4/4 tasks ok</code>. The two-second gap is a <code>nika:wait</code> task, whose start engine 0.123.0 streams only when it completes. Recorded from <code>@supernovae-st/nika</code> 0.123.0 and its bundled engine; the run is a <code>mock/echo</code> rehearsal.<br>▶ <a href="https://github.com/supernovae-st/nika-client/blob/main/media/videos/sdk-events.mp4?raw=true">MP4</a> · <a href="https://github.com/supernovae-st/nika-client/blob/main/media/transcripts/sdk-events.txt">transcript</a> · <a href="https://github.com/supernovae-st/nika-client/tree/main/scripts/media/scenes/sdk-events">the workflow and the program</a></sub></p>

| `event.kind` | Local engine frame (`event.raw.kind`) | Server frame (`event.raw.kind`) |
|---|---|---|
| `run.started` | `workflow_started` | `execution.started` |
| `task.scheduled` · `task.started` · `task.completed` · `task.failed` · `task.skipped` · `task.cancelled` | `task_scheduled` · `task_started` · `task_completed` · `task_failed` · `task_skipped` · `task_cancelled` | none: the server streams no per-task frame |
| `run.waiting` | `run_settled` carrying `paused` | `execution.settled` carrying `paused` |
| `run.settled` | `run_settled` carrying `succeeded` · `failed` · `cancelled` | `execution.settled` carrying `succeeded` · `failed` · `cancelled`; `execution.cancelled` carrying `cancelled` only; `execution.refused` carrying `failed` only |
| `run.interrupted` | `workflow_interrupted` carrying `interrupted` | `execution.interrupted` · `interrupted` carrying `interrupted` |
| `run.sealed` | `run_sealed`, when an engine streams one | none |
| `engine.event` | every other frame (`workflow_completed`, `workflow_paused`, `permit_checked`, `task_recovered`…) | every other frame: `execution.queued` (a job admitted with inputs), a `null` or future kind |

`event.status` is always the engine's own word (a waiting run reads
`paused`). `event.task` is the task a `task.*` frame named. A task the engine
skipped ends on `task.skipped` and a task it cancelled on `task.cancelled`,
whatever the reason: both name their `task`, never an `error` or a `status`.
A task skipped by `on_error: { skip: true }` still keeps the error that made
it skip: the engine leaves it on `event.raw`, in the frame's `outcome` row.
A recovered task ends on `task.completed`; the engine's `task_recovered` frame
before it stays an `engine.event`. Measured on engine 0.123.2 with one task
skipped by `on_error: { skip: true }`, one recovered by
`on_error: { recover: … }` and one cancelled because its `after:` edge never
admitted. `event.error` is
the failure a `task.failed` frame or a `failed` settlement named; no other
event carries one. `event.sequence` is the server's replay cursor and exists
only over HTTP. An `engine.event` carries only its cursor and `raw`, never a
`status`.

The package names a fact only when the engine wrote it, for a (kind, status)
pair the table lists. The engine's state word decides and is never assumed: an
absent, null, future or still-running status stays an `engine.event`, and so
does a frame that contradicts itself (`execution.refused` carrying
`succeeded`, say). `event.raw` still holds that frame, and `run.result()`
still reads the state the engine wrote. The projection keeps no state between
frames, removes no duplicates and never makes up an event: transports differ
in how many events they send, never in their names.

`run.waiting` is not `run.settled`: a human gate holds a run that can resume,
neither failed nor done. `run.interrupted` is the engine reporting that it
lost an execution; it has nothing to do with the thrown
`NikaObservationInterrupted`, which means this client lost its view of a run
that may still be running.

### A view opened late

You can read the result first and the events after:

```ts
const run = await nika.run('wide.nika');
const result = await run.result();          // first the result,
for await (const event of run.events()) {}  // then every event the run saw
```

A late view gets every event the run kept, or it is refused; it is never
handed a shortened history. A run keeps its most recent `eventBufferSize`
events, **4096 by default**. For scale, measured on engine 0.123.0: a clean
run of N independent `mock/echo` tasks wrote `3N + 3` frames (1 task: 6, 10
tasks: 33, 90 tasks: 273). That is one fixture, not a law: a `nika:wait`
task adds a `permit_checked` frame, a failed task writes `task_failed`, and
retries, agents and `for_each` were not measured. Count your own run:
`error.observed` below gives the number. A `nika serve` job was measured at
two frames (three with inputs), so the bound matters on a local engine.

The bound is finite on purpose. Each frame is capped by `machineBufferBytes`
(16 MiB by default, see [Large results](#large-results-machinebufferbytes)),
so a run's kept history holds at most `eventBufferSize × machineBufferBytes`
of frame text: 64 GiB at the defaults. That is arithmetic over the per-frame
cap, not a size any run approaches: on engine 0.123.0 the 273 frames of the
90-task run totalled 0.19 MiB, and the largest, the run's first frame
(`workflow_started`, which carries the engine's admission pricing), was about
32 KiB. The bound covers the history only: events your code holds, other open
views and other runs add their own. Nothing here is a claim about heap or
process memory. If the ceiling matters to you, set `eventBufferSize`
yourself: an explicit value is kept exactly. Do not lower `machineBufferBytes`
below that first frame: a run then fails with a `NikaProtocolError`
(measured: 16 KiB fails, 32 KiB and 64 KiB pass).

Past the bound, the run still runs and `run.result()` still resolves. Only a
view is refused, with `NikaEventBufferOverflowError`, whose `reason` names the
bound it hit:

| `error.reason` | What happened | What to do |
|---|---|---|
| `replay_truncated` | The view opened after the run produced more events (`error.observed`) than it can be given (`error.limit`); `error.retained` is how many the run still holds | If `retained === observed`, nothing is lost: open the view with `bufferSize >= observed`. Otherwise the early events are gone from this process: set `eventBufferSize >= observed` for the next run, or watch it live |
| `live_backpressure` | A live view fell more than `error.limit` events behind | Read faster, or raise that view's `bufferSize`; other views and the result are unaffected |

```ts
try {
  for await (const event of run.events()) render(event);
} catch (error) {
  if (error instanceof NikaEventBufferOverflowError && error.reason === 'replay_truncated') {
    // The run is fine. Its history is longer than this view can replay.
    console.warn(`${error.observed} events, ${error.retained} retained; run ${result.status}`);
  } else throw error;
}
```

Neither refusal skips an event, and neither is about the run.
`error.observed` is a count taken when the view opened. The engine's journal
stays the source of truth for a local trace (`receipt.trace_path`,
`traceVerify`): a late `run.events()` only replays what this process saw, and
the package reads no journal to extend it. Over HTTP the server holds the
job: recover there with `attachRun(id, { lastEventId })` (see
[server.md](server.md#recovery-after-a-restart)).

### Large results: `machineBufferBytes`

`machineBufferBytes` is the most the package holds of one engine frame (a
local engine's stdout line, a server's SSE event) or one document (a server's
JSON answer, a captured report). Its default, **16 MiB**, is the bound of a
`nika serve` job store: the server refuses, rather than truncates, a result
that would outgrow it, so every result a server settles reaches
`run.result()` and `attachRun()` under the default. Outputs that carry an
image are the usual large result, base64 widening the bytes by a third: on
engine 0.123.1 a 200,049-byte outputs map rode a 200,756-byte frame and a
200,815-byte job record. A local engine bounds no frame: `run_settled`
carries the outputs map whole, whatever its size, and a task's output rides
its `task_completed` frame, so a local result above 16 MiB needs a larger
value.

Past the bound, the package reads the frame to its end without keeping it,
then rejects with a `NikaProtocolError` that names the option and the size
to set:

```text
SSE event frame of job 51b0db8a-518b-4b3b-83c4-9dec6f47de03 exceeded 65536 bytes (machineBufferBytes): it is 200756 bytes. Set machineBufferBytes to at least 200756, or leave it unset: its 16 MiB default holds any result nika serve settles. The job itself is unaffected: attachRun('51b0db8a-518b-4b3b-83c4-9dec6f47de03') reads it again
```

That is a 200,000-character output under `machineBufferBytes: 64 * 1024`
(the former default), measured on engine 0.123.1.

The same words name a server's JSON record (`HTTP /v1/jobs/<id> JSON
exceeded …`, its size read from `Content-Length`), a local line (`Native
machine line exceeded …`) and a local report (`` `nika check` output
exceeded … ``). On a server the job keeps its result: a client with a larger
bound reads it again with `attachRun(jobId)`, which reads the job's record
first, a few dozen bytes larger than its last frame. Locally, that result
never reaches your process: set the larger bound before the run.

## Files a server run produced: artifacts

An image in `outputs` rides as base64. A server run can hand you the file
itself instead: the files its builtins saved (`nika:chart`,
`nika:image_generate`, `nika:tts_generate`, `nika:image_fx`, and
`nika:image_compose` from engine 0.124) and the images its agents sent,
listed from the job's sealed journal, each one downloaded with its bytes
proven against the size and SHA-256 recorded there:

```ts
await run.result();
const { artifacts } = await run.artifacts();
const chart = await run.readArtifact(artifacts[0]!); // Uint8Array, up to 16 MiB by default
const { stream } = await run.downloadArtifact('file/out/totals.svg'); // streamed, no maxBytes
```

From engine 0.124, an `agent:` task that declares
`images: { save: ./out/banner.png }` has the engine write the image its
harness sent to that path, and the manifest lists that file
(`file/out/banner.png`) beside the image itself (`agent_image/1.png`),
the same bytes under two names.

Neither `machineBufferBytes` nor `requestTimeout` bounds a download. A local
run has no artifact manifest: its files are where its workflow wrote them, in
the client's `cwd`, and the three methods reject with
`NikaCompatibilityError` (`capability: 'artifacts'`).
[server.md](server.md#download-what-a-job-produced-artifacts) covers what is
listed, what a download proves, its retries and its errors.

## Cancel a run

```ts
const run = await nika.run('slow.nika');
const cancellation = await run.cancel();
const result = await run.result();

console.log(cancellation.accepted, cancellation.status, result.status);
```

`run.cancel()` is idempotent: every call returns the same request. An
`AbortSignal` you pass to `check`, `events` or `traceVerify` stops only that
request or view; it never cancels the run.

- **Local engine.** The package signals the engine process, and the result is
  whatever the engine then records. Work already in flight settles first
  (an MCP call in flight is told to cancel) and tasks not yet started are
  cancelled: the run settles `cancelled` (cause `operator`), `interrupted`
  when the process ended without a settlement, or `succeeded` when its last
  task had completed before the request landed. On engine 0.123.0,
  cancelling a run waiting in a `nika:wait` task printed
  `true cancellation_requested cancelled` once the wait ended, and a cancel
  during the first of two waits settled `cancelled` with the second never
  started. A local engine sets no time limit on that settling.
- **`nika serve`.** A running job answers 202,
  `{ accepted: true, status: 'cancellation_requested' }`, and the server
  gives the run a **fixed 5-second grace**, which no option changes, to reach
  its next wave boundary and settle. Within it, `run.result()` settles on what
  the run recorded: `cancelled`, or `succeeded` or `failed` when that raced the
  request. Past it, the server drops the execution and records the job
  `interrupted`: the events end with `run.interrupted`, `result.status` is
  `interrupted`, never `cancelled`, and the result carries no `settlement`, so
  that run's task tally and spend are unknown to the client; `run.status()`
  then reads `interrupted`. A task still waiting, calling a model or running
  a command 5 seconds after the request ends the job this way. Measured on
  engine 0.123.1: a job inside a 20-second `nika:wait` settled `interrupted`
  about 5 seconds after its cancel, with the events `run.started` and
  `run.interrupted`. A job cancelled before its execution started settles on
  the reply itself (200, `status: 'cancelled'`). A job that already ended
  replays its result with `accepted: false` and `status: 'already_settled'`.

[`examples/watch-and-cancel.ts`](https://github.com/supernovae-st/nika-client/blob/main/examples/watch-and-cancel.ts) prints each
event as it arrives and cancels after a delay or on Ctrl+C, on either door.

## Typed engine frames, outputs and ids

`event.raw` is a `NikaEvent`: a union over the frames both transports send. A
local engine sends `workflow_started`, `task_scheduled`, `task_started`,
`task_completed`, `workflow_completed`, `workflow_failed`,
`workflow_interrupted` and `run_settled`; the union also types `run_sealed`,
which the measured 0.123.0 runs kept in their trace instead of streaming it.
A `nika serve` job streams `execution.started`,
`execution.settled`, `execution.cancelled`, `execution.refused` and
`execution.interrupted` (a server that restarts marks an orphaned running job
`interrupted`). Kinds this version does not know yet stay readable through
the `NikaUnknownEvent` fallback, so the union is open on purpose and every
variant keeps room for future fields.

`run()` and `attachRun()` take one `Outputs` type argument. It types
`run.result()` and, on the raw frames, `run_settled`, `execution.settled` and
`workflow_completed`. It validates nothing at runtime, and defaults to
`Record<string, unknown>`:

```ts
const run = await nika.run<{ answer: number }>('flow.nika');
const result = await run.result();      // result.outputs?: { answer: number }

for await (const event of run.events()) {
  if (isNikaRunSettledEvent(event.raw)) {
    // The settlement frame of either transport (`run_settled` locally,
    // `execution.settled` over HTTP): status, outputs and receipt together.
    console.log(event.raw.status, event.raw.outputs?.answer, event.raw.receipt);
  }
}
```

A run can also end without settling outputs: cancelled, refused or
interrupted. `isNikaTerminalEvent(event.raw)` covers those too. It reads the
status the engine reported (`succeeded`, `failed`, `interrupted`,
`cancelled`) rather than the kind, so it holds on both transports and on kinds
this version does not know yet:

```ts
for await (const event of run.events()) {
  if (isNikaTerminalEvent(event.raw)) {
    console.log('no further frames for this run:', event.raw.status);
  }
}
```

`isNikaRunSealedEvent(event.raw)` narrows a `run_sealed` frame when an
engine streams one.

Run, execution and job ids are branded strings (`NikaRunId`,
`NikaExecutionId`, `NikaJobId`): they are assignable to `string`, but a plain
`string` does not stand in for one. Four words name three things. A
**workflow** is the file, or served name, you pass in. A **run** is this
client's handle on one admission (`run.id`); over HTTP that same string is the
server's **job** id (`/v1/jobs/{id}`, `attachRun(jobId)`). An **execution** is
the engine's own id for what actually ran (`execution_id`, the `execution.*`
kinds), carried by the receipt with the `trace_id`. The
[glossary](glossary.md) defines the other words.

## Migrating to the Run-owned lifecycle

The client-level lifecycle methods are deprecated. They still check
ownership: a run this client did not create throws `NikaRunOwnershipError`,
because there is no global run registry.

| Deprecated | Use | What changes |
|---|---|---|
| `nika.events(run, options?)` | `run.events(options?)` | lifecycle `kind`s; the frame the wrapper yields is now `event.raw` |
| `nika.cancel(run)` | `run.cancel()` | nothing: the same request |
| `nika.status(run)` | `run.status()` | nothing |
| `await run.done` | `await run.result()` | nothing: `done` stays as an alias of the same promise |

`nika.events(run)` still yields the engine's frames exactly as before, so
existing code keeps working while you move:

```ts
// before
for await (const e of nika.events(run)) {
  if (e.kind === 'workflow_started' || e.kind === 'execution.started') start();
}

// after
for await (const e of run.events()) {
  if (e.kind === 'run.started') start();
}
```

**How long they stay.** The wrappers shipped unchanged next to the Run-owned
lifecycle from 0.120.0, the first version published to npm with it, and they
are still here in 0.124.0. If a later version removes them, its release notes
say so.
