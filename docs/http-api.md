# HTTP contract

`openapi.json` is the checked-in contract pin. The SDK authenticates every
route except public `GET /health`; bearer tokens are redacted from failures.
A non-2xx answer typed as `{ error: { code, message } }` becomes a
`NikaOperationError` carrying `status`, `code`, and the refused `operation`;
For a check by served name, a typed 404 or 422 instead returns
`{ clean: false, error }`; authentication and transport failures still throw.
Any other non-2xx body is discarded and reported as a redacted
`NikaTransportError`.

| HTTP route | SDK surface | Contract |
|---|---|---|
| `GET /health` | `serverIdentity()` and internal handshake | validated cached identity and capabilities; not a fresh readiness or authorization check |
| `GET /v1/openapi.json` | generation only | authenticated OpenAPI 3.1 document |
| `GET /v1/workflows` | `listWorkflows()` | contained relative workflow names |
| `GET /v1/workflows/{name}` | `workflow(name)` | path-free metadata, never source bytes |
| `POST /v1/compile` | `compile()` | capability-gated stateless source authoring; 200 ready/incomplete/refused, no job |
| `POST /v1/check` | `check()` | validates a served name or immutable snapshot bytes without a job |
| `POST /v1/jobs` | `run()` | admits a served name or exact snapshot bytes with an idempotency key |
| `GET /v1/jobs/{id}` | internal settlement | durable job identity, outputs, receipt, settlement, or redacted error |
| `GET /v1/jobs/{id}/status` | `run.status()` | current status only |
| `GET /v1/jobs/{id}/events` | `run.events()` / `attachRun()` | bounded, sequenced SSE with replay |
| `POST /v1/jobs/{id}/cancel` | `run.cancel()` | 200 a settled job or its terminal replay; 202 the request accepted on a running job, settled later by observation |
| `GET /v1/jobs/{id}/trace/verify` | `traceVerify(receipt)` | engine-owned typed trace verdict; an intact unsigned journal can have `reason: "unsealed"` |
| `GET/PUT /v1/schedules/{id}` | `scheduleStatus()` / `schedule()` | resident schedule projection and CAS mutation |

## Connection rules

- HTTPS is required for every host except loopback. Plain HTTP is accepted
  only for `localhost`, `127.0.0.0/8`, or `[::1]`, and only with an explicit
  `allowInsecureHttp: true`; that opt-in never admits a routable host.
- URLs containing credentials, a query, or a fragment are rejected.
- Tokens must contain 32–512 visible ASCII bytes and are never sent to
  `/health`.
- Admission requests have a bounded timeout; versioned authoring uses the
  resident deadline or the explicit caller deadline. JSON/SSE frames have a byte ceiling.
- Remote `check()` refuses `model` and `nativeStrict`; remote `run()` refuses
  `model`, `maxCostUsd` and the deprecated `vars` until a request envelope
  owns them.
- Remote `run()` sends `inputs` as `JobByName.inputs` only for a served name
  and only when `GET /health` advertises `jobInputs`. That capability, not a
  202, is the negotiation: a resident from before the envelope accepts the
  extra field and ignores its values, so the SDK refuses it after `/health`
  alone with `NikaCompatibilityError` (`capability: 'jobInputs'`). The
  `inputs` envelope is engine-owned (nika#1642) and appears in the pinned V9
  contract. The connected server must still advertise it.
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
The bundled OpenAPI and generated types preserve the composed V9 producer contract, including this foundation. The SDK then posts a v1 create
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

## Authoring

`compile(request, { signal?, timeoutMs? })` with a `NikaCompileWireRequest` sends the engine-owned generation-1 or
generation-2 request unchanged. Its types come from the checked-in live
OpenAPI contract. The SDK checks the advertised capability before the POST,
never resolves a local engine, refuses redirects, and sends the POST once.
A timeout or lost response may have spent the authorized model request;
there is no automatic retry or fabricated idempotency key.

The result is `{ outcome, replayToken? }`. `ready`, `incomplete`, and
`refused` are authoring outcomes. HTTP refusals remain typed operation
errors. A candidate and `check_preview` are review material: compiling does
not create a job, execute effects, save source or bind a schedule.

If the server returns a kept-round token, a caller can explicitly replay
generation 2 with `cognition: 'deterministicOnly'`, `replay_token`, the exact
original input and its answers. It must omit `limits`. Replay makes no
model call, expires with the server's bounded store, and can fail after a
restart. The SDK neither stores the token globally nor replays implicitly.

The resident owns the authoring deadline (300 seconds by default). The SDK
does not apply the ordinary `requestTimeout` while waiting for compile headers.
Use `timeoutMs: 600_000` for an explicit waiting deadline, including initial
health negotiation. A signal-only abort during that first handshake is observed
when its shared request answers, within `requestTimeout`. Aborting stops waiting; it does not cancel an already dispatched
provider call. If the first answer is lost, the server may have completed and
kept the round while the caller has no replay token; another fresh compile can
spend again. There is no result lookup or idempotency guarantee for that case.

`requestTimeout` still bounds JSON body reads after headers, and
`machineBufferBytes` bounds their size. Native processes refuse versioned
resident requests; the published, unversioned `compile()` form works natively.
The two request forms never mix and keep their separate return types.
Cost review uses the separate explicit [review contract](cost-review-contract.md).

## Settlement

The terminal `execution.settled` frame and the durable job nest the run's
`settlement` whole (engine 0.118, ADR-128): its `status` and `cause`, the
elapsed time, the task tally, the spend with its qualifier, and the failure
named with its task. The SDK types every known field, refuses a settlement
whose `status` contradicts the record carrying it, keeps fields it does not
know, and never derives a settlement from an exit code; a job the resident
lost (`interrupted`) carries none.

## Frame time and journal evidence

Both resident projections are closed, and the SDK refuses fields it does not
know. The pinned V9 `openapi.json` includes optional `at` and `evidence` fields.
Older residents may omit them; absence does not invent evidence.

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
and `run.result()` still reads the state word the engine wrote on it.

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
is an engine conflict, not a retry success. Direct native runs still omit the
key and reject it if supplied.

The namespace is the whole durable job store under the server's configured
`state-root`, across workflows, clients, schedules, and server restarts. The
current engine has no time-based eviction: keys remain bound while that state
root exists and still count toward its configured job capacity. Use globally
unique, business-stable keys; do not recycle daily counters or workflow-local
names.

Schedules use compare-and-swap semantics. Create omits `revision`; update must
carry the exact previous `sha256:...` revision. The SDK never fabricates or
normalizes schedule facts.
