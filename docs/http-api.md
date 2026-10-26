# HTTP contract

`openapi.json` is the checked-in contract pin. The SDK authenticates every
route except public `GET /health`; bearer tokens are redacted from failures.
A non-2xx answer typed as `{ error: { code, message } }` becomes a
`NikaOperationError` carrying `status`, `code`, and the refused `operation`.
For a check by served name, a typed 404 or 422 instead returns
`{ clean: false, error }`; authentication and transport failures still throw.
Any other non-2xx body is discarded and reported as a redacted
`NikaTransportError`.

| HTTP route | SDK surface | Contract |
|---|---|---|
| `GET /health` | internal identity handshake | public liveness and protocol versions |
| `GET /v1/openapi.json` | generation only | authenticated OpenAPI 3.1 document |
| `GET /v1/workflows` | `listWorkflows()` | contained relative workflow names |
| `GET /v1/workflows/{name}` | `workflow(name)` | path-free metadata, never source bytes |
| `POST /v1/compile` | `compile()` | capability-gated stateless source authoring; 200 ready/incomplete/refused, no job; generation 2 needs `compileNativeV2` |
| `POST /v1/check` | `check()` | validates a served name (with an optional `access` pin) or immutable snapshot bytes without a job |
| `POST /v1/jobs` | `run()` | admits a served name (with optional `access` and `inputs`) or exact snapshot bytes with an idempotency key |
| `GET /v1/jobs/{id}` | internal settlement | durable job identity, outputs, receipt, settlement, or redacted error |
| `GET /v1/jobs/{id}/status` | `run.status()` | current status only |
| `GET /v1/jobs/{id}/events` | `run.events()` / `attachRun()` | bounded, sequenced SSE with replay |
| `POST /v1/jobs/{id}/cancel` | `run.cancel()` | 200 a settled job or its terminal replay; 202 the request accepted on a running job, settled later by observation |
| `GET /v1/jobs/{id}/trace/verify` | `traceVerify(receipt)` | the server's engine-owned verdict on the journal it wrote for the job, in the CLI's lower-case words, and its `reason` (the seal tier beside a verdict that holds); see [Trace verification](#trace-verification) |
| `GET /v1/jobs/{id}/artifacts` | `run.artifacts()` | a settled job's artifact manifest, read from its sealed journal and bound to its receipt; see [Artifacts](#artifacts) |
| `GET /v1/jobs/{id}/artifacts/{name}` | `run.downloadArtifact()` / `run.readArtifact()` | one artifact's recorded bytes, with their size and SHA-256 in the headers, streamed past the request deadline |
| `GET/PUT /v1/schedules/{id}` | `scheduleStatus()` / `schedule()` | resident schedule projection and CAS mutation |

## Connection rules

- HTTPS is required for every host except loopback. Plain HTTP is accepted
  only for `localhost`, `127.0.0.0/8`, or `[::1]`, and only with an explicit
  `allowInsecureHttp: true`; that opt-in never admits a routable host.
- URLs containing credentials, a query, or a fragment are rejected.
- Tokens must contain 32–512 visible ASCII bytes and are never sent to
  `/health`.
- `GET /health` must name machine protocol 2, the generation of engine 0.123
  and of the engine this package bundles. A resident on another generation
  (0.122 and older speak 1) is refused with `NikaCompatibilityError`
  (`capability: 'engineIdentity'`) before any other request. A local engine
  that captures a snapshot or observes a compile must report the same
  machine protocol, snapshot, check-report and event clocks as the resident.
- Each request has a bounded timeout, except a compile provider round
  without `timeoutMs` or `limits.deadline_ms` (see [compile.md](compile.md))
  and an artifact download (see [Artifacts](#artifacts)),
  and each JSON body and SSE frame has a byte ceiling, `machineBufferBytes`:
  16 MiB by default, the bound of the resident's own job store, which
  refuses rather than truncates a larger result. A body past it is refused
  before it is read when its `Content-Length` says so, and the refusal names
  the option and the exact size; an SSE frame past it is read to its end,
  uncollected, so its refusal names its size too (see
  [runs.md](runs.md#large-results-machinebufferbytes)).
- Remote `run()` and `check()` send `access` as `JobByName.access` or
  `CheckByName.access`, the CLI's `--access` vocabulary, for a served name
  only; a snapshot body takes no pin, so a local path with `access` is
  refused (`NikaCompatibilityError`, `capability: 'snapshotAccess'`) before
  any capture or request. Every machine-protocol-2 resident reads the field;
  no capability gates it. The resident refuses an empty or blank pin at
  admission (422 `NIKA-1802`); any other pin is admitted (202), and a pin the
  execution cannot take settles the job `failed` with the engine's code. The
  check door is source-only and evaluates no access plan: it refuses an empty
  pin and acknowledges any other.
- Remote `check()` refuses `model` and `nativeStrict`; remote `run()` refuses
  `model`, `maxCostUsd` and the deprecated `vars`. The server applies its own
  per-run ceiling to manual jobs (`nika serve --run-cost-ceiling`, 1 USD by
  default).
- Remote `run()` sends `inputs` as `JobByName.inputs` only for a served name
  and only when `GET /health` advertises `jobInputs`. That capability, not a
  202, is the negotiation: a resident from before the envelope accepts the
  extra field and ignores its values, so the SDK refuses it after `/health`
  alone with `NikaCompatibilityError` (`capability: 'jobInputs'`). The
  `inputs` envelope is engine-owned (nika#1642); `JobByName.inputs` is in the
  pinned `openapi.json` of engine 0.123.
- A snapshot body takes no `inputs` overlay, an empty map included: `run()` of
  a local path with `inputs` is refused before any capture or request.
- The serialized `inputs` map is bounded at 1 MiB by the SDK, the bound the
  native channel reads. The resident's whole-request ceiling is its own and may
  be lower.
- Caller-provided workflow catalog names must be contained slash-separated
  paths. Absolute paths, backslashes, empty segments, `.` and `..` are
  rejected before network I/O.

A contained `.nika` name uses the resident registry without a local
engine. Prefix a local file with `./` to capture and submit its snapshot.
A successful by-name check returns `clean: true` and the compact resident
acknowledgement; no local check report or exit code is fabricated.

## Compile foundation

Serve must advertise `compile` in `/health`. This route was added in engine
commit `4334e58bddf539a6253f448eb05d562b6919f2b7`, after release 0.120.2, and
first published in release 0.120.3.
The bundled OpenAPI and generated types preserve that exact producer contract. The SDK then posts a v1 create
intent or inline edit source to `/v1/compile`, with bearer authentication and
JSON content type. A string change becomes `{text: change}`; a structured change
preserves `{set_constant: {name, value}}`. Literal answers retain their JSON
types. There is no path, destination, idempotency key or local fallback.

Every core outcome uses HTTP 200. `incomplete` and `refused` remain reviewable
data; non-200 error envelopes raise `NikaOperationError` with the HTTP status
and engine code. Bad versions, malformed outcomes, overflow, cancellation and
timeout fail typed. The response is bounded by the smaller of
`machineBufferBytes` and 8 MiB. Compile's timeout covers health negotiation,
response headers and the complete body.

The shared outcome contains candidate source, questions, diagnostics, requested
boundary, source-only Check preview and provenance. It carries no process exit
code or materialized destination. A candidate and its requested boundary grant
nothing: execution needs a separate caller decision and normal `run` admission.

## Compile generation 2 (ahead of the pin)

A resident whose operator seated a native authoring model (`nika serve
--authoring-model`) advertises `compileNativeV2` and also speaks
`compile_version: 2`. The SDK sends generation 2 only for a request that names
`cognition: 'explicitProvider'` (one fresh round under that seat, or, with a
kept round's `replay_token`, that round's judged answer round) or a
`replay_token` with `cognition: 'deterministicOnly'` (a zero-call replay of a
round the server kept), and refuses all three after `/health` alone on a
resident without the capability. The body carries `mode`, `cognition`, the
input (`intent` and `workflow_id`, or `source`, `change` and
`original_intent`), `answers`, `limits` (`explicitProvider` only) and
`replay_token`.

The answer is `compile_version: 2` exactly when a provider call happened, with
its receipt in `provenance.authoring`; a replay and a round that needed no call
answer generation 1. A fresh round whose native plan the server keeps answers
the `Nika-Compile-Replay` header, surfaced as `outcome.replay_token` (64
lowercase hex digits, never quoted in an error); a header on any other answer
is a `NikaProtocolError`. Every 200 answer to a generation-2 request carries
`Cache-Control: no-store`; the SDK caches nothing either. A replay binds its
answers with zero calls but asks no verifier, so a model-authored candidate
stays `incomplete`. The judged answer round replays the kept plan with the
answers and asks the seat only to judge it (judge calls, generation 2, no
authoring call): `ready`, or held with its token forgotten (a later request
with it answers 409 `compile_replay_unavailable`). A server that serves it
lists `compileJudgedAnswerRound` in `/health` (engine 0.123.0 does whenever
its operator seats a model with `--authoring-model`); the SDK posts the round
only there, refuses it elsewhere after `/health` alone with a
`NikaCompatibilityError` (`compileJudgedAnswerRound`), and sets
`outcome.judged_answer_round_available` beside every kept round. An older
server's `422 malformed_compile_request` to the round maps to the same error,
as a defensive path.
The server sets no default deadline on a provider round: the client waits for
`limits.deadline_ms` plus the server's 5 s handoff and one `requestTimeout`,
or, without that limit, sets none unless `timeoutMs` is given. A
generation-2 answer is read up to 8 MiB. Refusals add 409 (`compile_replay_unavailable`, `compile_replay_input_changed`,
`compile_context_changed`), 408 `compile_deadline_exceeded`, 422
`compile_new_intent_required`, 500 `compile_disclosure_refused` and 503
`compile_replay_capacity` or `stopping`.

This contract is ahead of the pinned `openapi.json`, which describes the
default document of the engine 0.123 resident: the default document never
carries it, and a seated resident merges it into its live document. Its types
are written by hand from the engine source at tag `v0.123.0`
(`crates/nika-serve/src/server/compile/v2.rs`, `author.rs`,
`openapi-native.json`). This package speaks only to engine 0.123 (machine
protocol 2), which serves it when seated. See [compile.md](compile.md).

## Trace verification

`traceVerify(receipt)` over HTTP needs the receipt's `job_id` and asks
`GET /v1/jobs/{id}/trace/verify`. The answer (`TraceVerification`, closed)
carries the server's `verdict` and `reason`, both required by the pinned
contract, beside the CLI's own document (`exit`, `chain`, `seal`, `anchor`,
`replay`, `lines`) and never a filesystem path. The verdict is the CLI's
headline word for the journal the server wrote for the job: `ok`, `sealed`,
`anchored` and `replayed` hold; `incomplete` (no terminal frame, the writer's
liveness in `reason`), `tampered` (a buried seal) and `broken` (an edited
chain) do not; `unchained`, `empty`, `unreadable`, `refused`, `line-over-long`
and `unknown` are the CLI's refusal classes; `unavailable` means no journal
exists for the job (refused before its first event, queued, or a backend
keeping none). Beside a verdict that holds, `reason` is the seal tier:
`sealed` or `unsealed`.

The SDK sets `verified: true` only when the verdict holds (compared without
case) **and** the answer's `trace_id` equals the receipt's. The verdict
describes the job's journal, not the receipt: a receipt whose `trace_id` does
not match keeps the server's `sealed` and reads `verified: false`. Measured on
engine 0.123.0: a server with a signing key answers `sealed`/`sealed`, one
without answers `ok`/`unsealed`, and both read `verified: true` for the
matching receipt.

## Artifacts

`run.artifacts()`, `run.downloadArtifact()` and `run.readArtifact()` need a
server whose `/health` lists `artifacts` (the engine added the routes in
nika#1834; the released 0.123.1 does not list them). Without it, and on the
native transport, they reject with `NikaCompatibilityError`
(`capability: 'artifacts'`) before any request.

**The manifest** (`ArtifactManifest`) is read like any JSON answer: bearer
token, `requestTimeout`, `machineBufferBytes`. The SDK checks each field the
contract names by type and lets any other key ride through, so a later
additive key is not a refusal: `receipt` (the closed `JobReceipt`, its
`job_id` the run's, with a `chain_head`), `verdict` (the journal tier,
`sealed` or `anchored`; any other word is refused), `max_artifact_bytes`,
`truncated` and `artifacts`. Each entry has a unique `name`, a `kind`, a
`size` that is a byte count, a `sha256` of 64 lowercase hexadecimal digits,
a `mime`, an optional `task` and an `event_id`; a `file` carries its `path`,
an `agent_image` none. A `path` must be contained (relative, `/`-separated,
no empty, `.` or `..` segment, no backslash, no NUL). That check is lexical
and POSIX, the server's own: it does not make a path safe to join under a
local directory on every system (`C:x` is drive-relative on Windows, and two
paths that differ only by case collide on a case-insensitive disk). To write
an artifact locally, resolve the joined path, check that it stays under your
directory, and open it exclusively (`wx`). Any other shape is a
`NikaProtocolError` that quotes no value. The receipt must equal the job's own, compared key by key: the one
the handle settled with, or, when the handle has not seen the settlement, the
one `GET /v1/jobs/{id}` returns.

**A download** sends the name as one path segment, `encodeURIComponent(name)`
(its `/` become `%2F`, which the server decodes once and matches exactly),
with `Accept-Encoding: identity`. A name the manifest lists is held to its
entry: the 200 must carry `Content-Length` equal to `size`,
`Nika-Artifact-Sha256` equal to `sha256`, and no `Content-Encoding`. Any
other 200 is a `NikaProtocolError` before a byte is read. A name the complete
manifest does not list is still sent, so the server answers its own 404
`artifact_not_found`; a 200 for it is a protocol fault. Past a truncated
manifest's 1,024 entries a name is held to the response's two headers alone,
and `download.artifact` is absent.

The request goes through the client's unbounded fetch, as a provider compile
round does: no `requestTimeout` on its headers (the server hashes the whole
file against its record before it answers) or its body, which the server
streams outside its own request deadline, and no `machineBufferBytes`. Only
the caller's `signal`, or cancelling the stream, ends it. With an injected
`fetch`, that fetch's own timeouts apply.

The stream hashes every chunk as it arrives and never passes the recorded
size. It holds its last chunk back and closes only once exactly `size` bytes
hashed to `sha256`; bytes that are not the recorded ones fail it with a
`NikaProtocolError`. A body that ends before its `Content-Length`, or resets
before its end, is requested again, up to 3 more times, after 100, 200 and
400 ms: the server has no range requests, so the whole artifact comes again,
its headers are held to the same size and digest, and its first bytes must
hash as the bytes already received. A retry the transport cannot deliver (no
connection, or one dropped before its headers) counts as one more incomplete
attempt. A refusal on a retry fails the stream with that `NikaOperationError`
(409 `artifact_changed` for a file that changed); a download still incomplete
after the last attempt fails with a `NikaTransportError`, and an abort with a
`NikaTransportError` naming the method. A body whose bytes all arrived but
whose end was lost is judged by its digest, without a retry.

`readArtifact()` reads the same stream into one `Uint8Array` and resolves
only once it closed. It refuses an artifact larger than `maxBytes` (16 MiB by
default) with `NikaConfigurationError`: before any download for a listed
one, from its `Content-Length` for one past a truncated manifest.

| Route | HTTP status · `error.code` |
|---|---|
| both | 401 `unauthorized` · 404 `job_not_found` · 409 `job_not_settled`, `artifact_journal_unavailable`, `artifact_journal_unverified` · 500 `internal_error` · 503 `store_busy`, `artifact_capacity` |
| the manifest only | 408 `request_timeout` |
| a download only | 403 `artifact_too_large` · 404 `artifact_not_found` · 409 `artifact_changed` |

Each is a `NikaOperationError` whose `operation` is the method called
(`artifacts`, `downloadArtifact` or `readArtifact`), with the server's code on
`code` and `machineCode` and the HTTP `status`. The SDK retries none of them:
a 503 says to retry with backoff. A server without a run key lists
`artifacts` but answers every request 409 `artifact_journal_unverified`,
since its journals are unsealed (see
[server.md](server.md#download-what-a-job-produced-artifacts)).

## Settlement

The terminal `execution.settled` frame and the durable job nest the run's
`settlement` whole (engine 0.118, ADR-128): its `status` and `cause`, the
elapsed time, the task tally, the spend with its qualifier, and the failure
named with its task. The SDK types every known field, refuses a settlement
whose `status` contradicts the record carrying it, keeps fields it does not
know, and never derives a settlement from an exit code; a job the resident
lost (`interrupted`) carries none.

## Frame time and journal evidence (engine 0.123)

Both resident projections are closed, and the SDK refuses any field it does
not know. Engine 0.123 adds two optional resident fields,
declared in the pinned `openapi.json`: a 0.123.0 resident writes `at` on
every frame, and `evidence` only when it reports a journal loss.

- `JobEvent.at` is when the resident admitted the event: an RFC 3339 timestamp
  in UTC, outside the event's hash chain. It rides `event.raw.at` untouched.
  Anything that is not such a timestamp is a `NikaProtocolError`. The durable
  `Job` declares no `at`, so one there is still an unknown field.
- `evidence`, on the terminal frame and on the durable `Job`, reports that the
  run's journal mirror stopped recording. It is exactly a `status` and a
  `reason`. The one status is `mirror_lost`. The reason is `write_failed`
  (opening, writing or syncing the journal failed) or `record_refused` (a
  record could not be admitted within the writer's bounds): a coarse class,
  never OS text and never a path. Any other shape or word is a
  `NikaProtocolError`, as the engine itself refuses one, and its value is
  never quoted in the error.

`evidence` is independent of the execution and is never a verdict: a run can
settle `succeeded` while its mirror is lost. It never changes `result.status`,
the settlement, or the receipt's identity checks. `run.result()` copies it to
`result.evidence` from the frame or record that settled the run, so a caller
who never iterates events still learns the trace may be incomplete before
trusting `traceVerify`. Its absence claims nothing: not that a journal exists,
only that no loss was reported. A native run never carries it.

## Lifecycle vocabulary over the resident's frames

`run.events()` names the resident's closed `JobEvent` frames in the SDK's
lifecycle vocabulary and keeps each frame on `event.raw`:

| `JobEvent.kind` | `JobEvent.status` | `event.kind` |
|---|---|---|
| `execution.started` | any | `run.started` |
| `execution.settled` | `paused` | `run.waiting` |
| `execution.settled` | `succeeded` · `failed` · `cancelled` | `run.settled` |
| `execution.cancelled` | `cancelled` only | `run.settled` |
| `execution.refused` | `failed` only | `run.settled` |
| `execution.interrupted` · `interrupted` | `interrupted` | `run.interrupted` |
| anything else: a `null` or future kind; an end kind whose status is absent, `null`, future, `queued` or `running`; or a pair that contradicts itself (`execution.refused` carrying `succeeded` or `cancelled`, `execution.cancelled` carrying `succeeded` or `failed`, an end kind carrying `interrupted`) | | `engine.event` |

The pairs above are exhaustive and listed, never computed as a product of
kinds and words. An unnamed frame is still delivered with `event.raw` intact,
and `run.result()` still reads the state word the engine wrote on it. One
such frame is common: a job admitted with a non-empty `inputs` map opens its
stream with `execution.queued` (status `queued`, sequence 1), so it streams
three frames where a job without inputs streams two (engine 0.123.1).

The resident streams no per-task frame, so an HTTP run yields no `task.*`
event: the SDK never synthesizes one. `event.sequence` is the validated SSE
id, the cursor to persist. The engine's `interrupted` (execution ownership
was lost, settlement unknown) is data: a `run.interrupted` event and
`result.status`. It is unrelated to `NikaObservationInterrupted` below, which
is this client losing its view of a run that may still be running.

## SSE recovery

The client checks that SSE ids are canonical positive integers and equal
`data.sequence`. An identical duplicate is ignored. A conflicting duplicate,
gap, or out-of-order frame is a protocol failure. After a reset the client
asks durable job state before reconnecting with `Last-Event-ID`; retry delays
and attempts are bounded.

A replacement Node process can call `attachRun(jobId, { lastEventId })`. The
SDK proves that the durable job exists before returning an owned run handle,
then sends the cursor as `Last-Event-ID`. Persist the job id and last event
sequence in the same application transaction that records each consumed event.
A cursor means “fully processed”, not merely “received”.

## Idempotency and schedules

HTTP `run()` requires a caller-owned `idempotencyKey` of 1–255 bytes. Omitting
it throws `NikaConfigurationError` before network I/O or local snapshot capture.
Persist the key before admission and retry the exact request with the same key
if the response is lost or times out. The SDK never generates a hidden key or
retries admission automatically. Reusing a key with different request bytes
is an engine conflict, not a retry success: the `access` pin and the `inputs`
map are part of those bytes, so another pin under the same key answers 409
`idempotency_conflict`. A request without a pin keeps the exact bytes earlier
releases sent. Direct native runs still omit the key and reject it if
supplied.

The namespace is the whole durable job store under the server's configured
`state-root`, across workflows, clients, schedules, and server restarts. The
current engine has no time-based eviction: keys remain bound while that state
root exists and still count toward its configured job capacity. Use globally
unique, business-stable keys; do not recycle daily counters or workflow-local
names.

Schedules use compare-and-swap semantics. Create omits `revision`; update must
carry the exact previous `sha256:...` revision. The SDK never fabricates or
normalizes schedule facts.

A scheduled job's `receipt.origin` is closed: the firing's `kind`,
`schedule_origin`, `schedule_id`, `schedule_revision`, `slot_id`, `decision`,
`scheduled_for`, `fired_at` and `arm_generation`, and, from engine 0.123
(machine protocol 2), the silence a `catch-up-once` firing answers for:
`missed_first` (its first missed slot) and `missed_count` (how many slots it
holds), `scheduled_for` being its last. The SDK reads them as the resident
writes them: both or neither, on a `catch_up` decision only, at least one
slot, the first never after `scheduled_for`. Any other member or combination
is a `NikaProtocolError`.
