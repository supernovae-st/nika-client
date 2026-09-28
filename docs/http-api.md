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
| `GET /health` | `serverIdentity()` and internal handshake | public protocol and capability identity; cached per client |
| `GET /v1/openapi.json` | generation only | authenticated OpenAPI 3.1 document |
| `POST /v1/compile` | `compile()` | source-only authoring, explicit native opt-in and zero-call replay |
| `GET /v1/workflows` | `listWorkflows()` | contained relative workflow names |
| `GET /v1/workflows/{name}` | `workflow(name)` | path-free metadata, never source bytes |
| `POST /v1/check` | `check()` | validates a served name or immutable snapshot bytes without a job |
| `POST /v1/jobs` | `run()` | admits a served name or exact snapshot bytes with an idempotency key |
| `GET /v1/jobs/{id}` | internal settlement | durable job identity, outputs, receipt, settlement, or redacted error |
| `GET /v1/jobs/{id}/status` | `status(run)` | current status only |
| `GET /v1/jobs/{id}/events` | `events(run)` / `attachRun()` | bounded, sequenced SSE with replay |
| `POST /v1/jobs/{id}/cancel` | `cancel(run)` | 200 a settled job or its terminal replay; 202 the request accepted on a running job, settled later by observation |
| `GET /v1/jobs/{id}/trace/verify` | `traceVerify(receipt)` | engine-owned typed trace verdict; a positive verdict may carry `reason: "unsealed"` |
| `GET/PUT /v1/schedules/{id}` | `scheduleStatus()` / `schedule()` | resident schedule projection and CAS mutation |

## Connection rules

`serverIdentity()` returns a detached copy of the validated HTTP handshake,
including `engineVersion`, protocol clocks, and `supportedCapabilities`. It
needs no local binary or workflow file. The snapshot is cached by the client:
it is not a fresh liveness or readiness probe, and the public endpoint does not
authenticate the caller. Mutating the returned object cannot change the SDK's
admission checks. Native clients refuse this HTTP-only operation with
`NikaCompatibilityError`.

- HTTPS is required for every host except loopback. Plain HTTP is accepted
  only for `localhost`, `127.0.0.0/8`, or `[::1]`, and only with an explicit
  `allowInsecureHttp: true`; that opt-in never admits a routable host.
- URLs containing credentials, a query, or a fragment are rejected.
- Tokens must contain 32–512 visible ASCII bytes and are never sent to
  `/health`.
- HTTP admissions have a bounded timeout; authoring waits for the resident's
  own deadline or the caller's signal. Each JSON/SSE machine frame has a byte ceiling.
- Remote `check()` refuses `model` and `nativeStrict`; remote `run()` refuses
  `vars`, `model`, and `maxCostUsd` until the request envelope owns them.
- Caller-provided workflow catalog names must be contained slash-separated
  paths. Absolute paths, backslashes, empty segments, `.` and `..` are
  rejected before network I/O.

A contained `.nika` or legacy `.nika.yaml` name uses the resident registry without a local
engine. Prefix a local file with `./` to capture and submit its snapshot.
A successful by-name check returns `clean: true` and the compact resident
acknowledgement; no local check report or exit code is fabricated.

## Authoring

`compile(request, { signal? })` sends the engine-owned generation-1 or
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
Use `signal`, for example `AbortSignal.timeout(600_000)`, for an explicit caller
deadline. Aborting stops waiting; it does not cancel an already dispatched
provider call. If the first answer is lost, the server may have completed and
kept the round while the caller has no replay token; another fresh compile can
spend again. There is no result lookup or idempotency guarantee for that case.

`requestTimeout` still bounds JSON body reads after headers, and
`machineBufferBytes` bounds their size. Direct native-process
authoring returns a capability error instead of introducing a subprocess
fallback. Cost-decision and reconciliation APIs are still separate work;
this authoring method does not claim the complete V9 consumer contract.

## Settlement

The terminal `execution.settled` frame and the durable job nest the run's
`settlement` whole (engine 0.118, ADR-128): its `status` and `cause`, the
elapsed time, the task tally, the spend with its qualifier, and the failure
named with its task. The SDK types every known field, refuses a settlement
whose `status` contradicts the record carrying it, keeps fields it does not
know, and never derives a settlement from an exit code; a job the resident
lost (`interrupted`) carries none.

## SSE recovery

An event may carry the resident's `at` timestamp and typed journal
`evidence`. The timestamp is observation metadata outside the trace hash.
`evidence: { status: 'mirror_lost', reason: 'write_failed' | 'record_refused' }`
reports journal loss independently of execution success. The SDK preserves
it on events and on `run.done`, including durable reattachment; its absence
does not certify a sealed trace. Use `traceVerify()` for the engine's verdict.
Unknown projection fields and malformed evidence are still refused.

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
