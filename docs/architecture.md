# SDK architecture

The package has one public facade and two execution adapters:

```text
application
    |
    v
Nika facade
    |
    v
Transport interface  <--- lifecycle and authority seam
    |                         |
    v                         v
NativeProcessTransport    HttpTransport
    |                         |
    v                         v
local nika process         authenticated nika serve
```

## Modules and responsibilities

- `src/index.ts` is the public Module. It validates caller-owned values, owns
  run handles, and exposes one stable vocabulary.
- `src/lib/transport.ts` is the Interface. It describes the operations both
  Adapters must implement and makes unsupported authority explicit.
- `src/lib/native-process-transport.ts` is the local Adapter. It spawns the
  selected engine without a shell and consumes newline-delimited machine
  events.
- `src/lib/http-transport.ts` is the remote Adapter. It verifies the remote
  server identity once per client, resolves and verifies a local engine only
  for caller-owned snapshot capture, then uses the authenticated HTTP
  contract.
- `src/lib/run-session.ts` is the lifecycle Seam. It owns the eager event
  pump, bounded independent observers, cancellation memoization, and the sole
  terminal `run.done` settlement.
- `openapi.json` and `src/generated/openapi.d.ts` pin the HTTP contract judged
  by CI. `scripts/check-sdk-coverage.js` fails if a live runtime path is
  missing or if the SDK names a path outside that contract.

## Authority rules

The SDK transports engine facts; it does not reproduce engine decisions.
Parsing, admission, scheduling, cancellation settlement, receipts, trace
verification, permits, and cost remain engine-owned.

Some operations deliberately have one authority:

- resident workflow discovery, durable status, and schedules require HTTP;
- a direct native process refuses those operations with
  `NikaCompatibilityError`;
- remote execution still needs a compatible local engine to capture an
  immutable snapshot before any network admission;
- HTTP observation (attach, durable status, events, cancel, workflow catalog,
  schedule status, trace verdicts) needs no local engine;
- remote trace verification currently returns the engine's typed unavailable
  verdict because the server has no path-free journal authority.

## Lifecycle invariants

1. `run()` resolves only after stable admission and returns an immutable
   `{ id, done }` handle.
2. `run.done` is the only terminal promise. Workflow failure is result data;
   configuration, transport, protocol, and compatibility failures throw.
3. `events(run)` creates an independent bounded observer. Aborting an observer
   never cancels the run.
4. `cancel(run)` is idempotent per owned run handle.
5. `status(run)` reads the durable HTTP projection and refuses a native-only
   run instead of guessing from local process state.
6. Schedule creation uses `If-None-Match: *`; updates require the exact opaque
   revision in `If-Match`.
7. `attachRun()` creates a fresh owned session for an existing HTTP job; its
   initial sequence is caller-owned durable checkpoint state, never inferred
   from in-memory SDK history.

## Deletion test

If one Adapter is removed, the facade and lifecycle Seam remain coherent and
the other Adapter still compiles. If the Transport Interface is removed,
authority differences leak into every public method. If `run-session.ts` is
removed, each consumer must reimplement buffering, ownership, cancellation,
and settlement. Those boundaries therefore carry real architectural load.
