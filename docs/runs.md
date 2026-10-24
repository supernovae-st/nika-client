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
| `run.done` | The same promise as `run.result()`, kept for older code |

Every member is bound to its run, so you can pass it around:
`const { events, result } = run`. The handle only observes, settles, reports
and cancels its run; checking, proof, catalogs and authoring stay on `Nika`.

## Check a workflow without running it: `check()`

You do not need `check()` before `run()`: the engine checks on every run, and
a red file never becomes a run. Use `check()` to show the audit without
running anything, for example in a CI step or an editor.

```ts
const report = await nika.check('hello.nika', { nativeStrict: true });
console.log(report.clean, report.exitCode);
```

- **On a local engine** you get the engine's whole report: `clean`,
  `exitCode` and its `findings[]`. Options: `model` (check against another
  model), `nativeStrict` (the engine's `--native-strict` audit) and `signal`
  (stops this check only).
- **On a server, by served name**, you get the server's short answer:
  `clean: true`, or its typed refusal with `clean: false`. The package never
  invents findings or an exit code. An explicit local path (`./hello.nika`)
  is captured locally and returns the engine's findings and exit code.
  `model` and `nativeStrict` are refused over HTTP with a typed error.

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

`result.settlement` carries the engine's own account of the ending: its
`cause` (`normal`, `human_gate`, `task_failed`, `budget`, `operator`…), the
task tally, the elapsed time and the spend with its pricing qualifier. An
unknown cost is never reported as zero.

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
never merged.

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
server streams no per-task frames, and the package never invents one.

| `event.kind` | Local engine frame (`event.raw.kind`) | Server frame (`event.raw.kind`) |
|---|---|---|
| `run.started` | `workflow_started` | `execution.started` |
| `task.scheduled` · `task.started` · `task.completed` · `task.failed` | `task_scheduled` · `task_started` · `task_completed` · `task_failed` | none: the server streams no per-task frame |
| `run.waiting` | `run_settled` carrying `paused` | `execution.settled` carrying `paused` |
| `run.settled` | `run_settled` carrying `succeeded` · `failed` · `cancelled` | `execution.settled` carrying `succeeded` · `failed` · `cancelled`; `execution.cancelled` carrying `cancelled` only; `execution.refused` carrying `failed` only |
| `run.interrupted` | `workflow_interrupted` carrying `interrupted` | `execution.interrupted` · `interrupted` carrying `interrupted` |
| `run.sealed` | `run_sealed`, when an engine streams one | none |
| `engine.event` | every other frame (`workflow_completed`, `workflow_paused`, `permit_checked`…) | every other frame, including a `null` or future kind |

`event.status` is always the engine's own word (a waiting run reads
`paused`). `event.task` is the task a `task.*` frame named. `event.error` is
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
two frames, so the bound matters on a local engine.

The bound is finite on purpose. Each frame is capped by `machineBufferBytes`
(64 KiB), so a run's kept history holds at most
`eventBufferSize × machineBufferBytes` of frame text: 256 MiB at the defaults.
That is arithmetic, not a measurement: on engine 0.123.0 the 273 frames of
the 90-task run totalled 0.19 MiB, and the largest, the run's first frame
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
  started.
- **`nika serve`.** A running job answers 202,
  `{ accepted: true, status: 'cancellation_requested' }`, and `run.result()`
  settles on the ending the server records: `cancelled`, `succeeded`,
  `failed`, or `interrupted` once its grace period expired. A job cancelled
  before its execution started settles on the reply itself (200,
  `status: 'cancelled'`). A job that already ended replays its result with
  `accepted: false` and `status: 'already_settled'`.

[`examples/watch-and-cancel.ts`](../examples/watch-and-cancel.ts) prints each
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
are still here in 0.123.0. They stay through the 0.123 maintenance line. If a
later version removes them, its release notes say so.
