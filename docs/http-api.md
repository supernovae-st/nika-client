# HTTP contract

`openapi.json` is the checked-in contract pin. The SDK authenticates every
route except public `GET /health`; bearer tokens are redacted from failures.
A non-2xx answer typed as `{ error: { code, message } }` becomes a
`NikaOperationError` carrying `status`, `code`, and the refused `operation`;
any other non-2xx body is discarded and reported as a redacted
`NikaTransportError`.

| HTTP route | SDK surface | Contract |
|---|---|---|
| `GET /health` | internal identity handshake | public liveness and protocol versions |
| `GET /v1/openapi.json` | generation only | authenticated OpenAPI 3.1 document |
| `GET /v1/workflows` | `listWorkflows()` | contained relative workflow names |
| `GET /v1/workflows/{name}` | `workflow(name)` | path-free metadata, never source bytes |
| `POST /v1/check` | `check()` | judges a served name, or immutable snapshot bytes, without a job |
| `POST /v1/jobs` | `run()` | admits a served name, or exact snapshot bytes, with an idempotency key |
| `GET /v1/jobs/{id}` | internal settlement | durable job identity, settlement, outputs, receipt, or redacted error |
| `GET /v1/jobs/{id}/status` | `status(run)` | current status only |
| `GET /v1/jobs/{id}/events` | `events(run)` / `attachRun()` | bounded, sequenced SSE with replay |
| `POST /v1/jobs/{id}/cancel` | `cancel(run)` | `202` acknowledges an active cancellation request; `200` returns queued cancellation or an already observed outcome |
| `GET /v1/jobs/{id}/trace/verify` | `traceVerify(receipt)` | engine-owned typed trace verdict |
| `GET/PUT /v1/schedules/{id}` | `scheduleStatus()` / `schedule()` | resident schedule projection and CAS mutation |

## Connection rules

- HTTPS is required for every host except loopback. Plain HTTP is accepted
  only for `localhost`, `127.0.0.0/8`, or `[::1]`, and only with an explicit
  `allowInsecureHttp: true`; that opt-in never admits a routable host.
- URLs containing credentials, a query, or a fragment are rejected.
- Tokens must contain 32–512 visible ASCII bytes and are never sent to
  `/health`.
- Each request has a bounded timeout and each JSON/SSE machine frame has a
  byte ceiling.
- Remote `check()` refuses `model` and `nativeStrict`; remote `run()` refuses
  `vars`, `model`, and `maxCostUsd` until the request envelope owns them.
- Caller-provided workflow catalog names must be contained slash-separated
  paths. Absolute paths, backslashes, empty segments, `.` and `..` are
  rejected before network I/O.

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

The stored settlement also supplies `run.done` when the terminal event was
already consumed or admission replays an existing job. A paused event closes
the current observation and resolves `done`, while the job remains resumable
under engine authority. Attachment does not answer a human gate.

An active cancellation returns `cancellation_requested` without waiting for
the runtime to finish. Await `run.done` for its actual result: cancellation
can race success or failure, and ownership lost without a runtime result is
`interrupted`. The SDK does not replace that result with the requested one.
Concurrent accepted cancellation requests share one action result. A failed
request is not cached forever: the caller may retry it on the same run handle
without abandoning the independently observed execution.

## Idempotency and schedules

An omitted run idempotency key is generated once per admission. A caller key
must be 1–255 bytes. Reusing a key with different snapshot bytes is an engine
conflict, not a retry success.

The namespace is the whole durable job store under the server's configured
`state-root`, across workflows, clients, schedules, and server restarts. The
current engine has no time-based eviction: keys remain bound while that state
root exists and still count toward its configured job capacity. Use globally
unique, business-stable keys; do not recycle daily counters or workflow-local
names.

Schedules use compare-and-swap semantics. Create omits `revision`; update must
carry the exact previous `sha256:...` revision. The SDK never fabricates or
normalizes schedule facts.
