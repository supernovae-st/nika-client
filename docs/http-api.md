# HTTP contract

`openapi.json` is the checked-in contract pin. The SDK authenticates every
route except public `GET /health`; bearer tokens are redacted from failures.

| HTTP route | SDK surface | Contract |
|---|---|---|
| `GET /health` | internal identity handshake | public liveness and protocol versions |
| `GET /v1/openapi.json` | generation only | authenticated OpenAPI 3.1 document |
| `GET /v1/workflows` | `listWorkflows()` | contained relative workflow names |
| `GET /v1/workflows/{name}` | `workflow(name)` | path-free metadata, never source bytes |
| `POST /v1/check` | `check()` | validates immutable snapshot bytes without a job |
| `POST /v1/jobs` | `run()` | admits exact snapshot bytes with an idempotency key |
| `GET /v1/jobs/{id}` | internal settlement | durable job identity, outputs, receipt, or redacted error |
| `GET /v1/jobs/{id}/status` | `status(run)` | current status only |
| `GET /v1/jobs/{id}/events` | `events(run)` / `attachRun()` | bounded, sequenced SSE with replay |
| `POST /v1/jobs/{id}/cancel` | `cancel(run)` | idempotent cancellation or terminal replay |
| `GET /v1/jobs/{id}/trace/verify` | `traceVerify(receipt)` | engine-owned typed trace verdict |
| `GET/PUT /v1/schedules/{id}` | `scheduleStatus()` / `schedule()` | resident schedule projection and CAS mutation |

## Connection rules

- HTTPS is required by default. Loopback HTTP needs
  `allowInsecureHttp: true`.
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
