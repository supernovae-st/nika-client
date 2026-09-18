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
  events. It reads the first machine frame before it returns a run, so
  `run()` resolves on the engine's admission and rejects on its refusal.
- `src/lib/run-refusal.ts` reads the engine's one pre-run refusal object (its
  check report carrying `clean: false`, or its `{ error }` envelope) and turns
  it into the typed `NikaOperationError`. It judges nothing: a shape the
  engine was not measured to write is a protocol fault, never a refusal.
- `src/lib/legacy-run-refusals.ts` is temporary. It recovers the three refusal
  dialects of engines up to 0.119.0, which predate the one `run --json`
  grammar, and is deleted with its call sites once no supported engine writes
  them.
- `src/lib/http-transport.ts` is the remote Adapter. It verifies the remote
  server identity once per client, resolves and verifies a local engine only
  for caller-owned snapshot capture, then uses the authenticated HTTP
  contract.
- `src/lib/run-session.ts` is the lifecycle Seam. It owns the eager event
  pump, bounded independent observers, cancellation memoization, and the sole
  terminal settlement. It builds the `NikaRun` handle as closures over itself,
  so the Run owns `events()`, `result()`, `status()` and `cancel()`.
- `src/lib/run-events.ts` is the semantic Adapter: a pure projection of one
  protocol frame onto the SDK's lifecycle vocabulary, with the frame kept by
  identity on `raw`. It is applied at the edge of an observer view. There is
  one history and one bounded queue per observer, and no second event bus.
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
- remote execution by contained workflow name uses the resident registry;
  explicit local paths need a compatible local engine to capture a snapshot;
- when that capture is red the HTTP adapter returns the local engine's plain
  `nika check --json` report, so `findings[]` stays canonical and no workflow
  bytes are sent;
- HTTP observation (attach, durable status, events, cancel, workflow catalog,
  schedule status, trace verdicts) needs no local engine;
- remote trace verification currently returns the engine's typed unavailable
  verdict because the server has no path-free journal authority.

## Lifecycle invariants

1. `run()` resolves only after stable admission and returns an immutable
   `NikaRun` handle: `id`, `events()`, `result()`, `status()`, `cancel()`, and
   `done`, the compatibility alias of `result()`. Its members are closures
   over the run's one session, so an extracted method still works. The handle
   owns the lifecycle and nothing else: checking, proof, catalogs and
   authoring stay on the facade. A run handle never means "maybe a run": a refusal
   before admission rejects `run()` with `NikaOperationError` and no handle
   exists. Over HTTP a red local snapshot refuses before any request is sent;
   on the native transport the first machine frame decides. A run event is the
   engine's admission evidence and is replayed as the first event; a refusal
   object is the whole stream. The one spawn that executes the workflow is the
   one that judges it: the SDK adds no preflight check and never spawns twice.
2. `run.result()` is the only terminal promise (`run.done` is the same one).
   Workflow failure is result data; configuration, transport, protocol, and
   compatibility failures throw. A `paused` result is a human gate: neither a
   failure nor a completed execution.
3. `run.events()` creates an independent bounded observer in the lifecycle
   vocabulary. Aborting an observer never cancels the run. The vocabulary is a
   stateless per-frame projection: it names a fact only for a (kind, status)
   pair a producer defines, never defaults a state word, never deduplicates,
   and never synthesizes a frame a transport did not emit. Every other frame
   keeps flowing as `engine.event`, so transports differ in cardinality but
   never in names, and `event.raw` is always the untouched protocol frame.
4. `run.cancel()` is idempotent per run: every call returns the one request.
5. `run.status()` reads the durable HTTP projection and refuses a native-only
   run instead of guessing from local process state.
6. Schedule creation uses `If-None-Match: *`; updates require the exact opaque
   revision in `If-Match`.
7. `attachRun()` is the one recovery door. It creates a fresh owned session
   for an existing HTTP job; its initial sequence is caller-owned durable
   checkpoint state, never inferred from in-memory SDK history. A native run
   is process-bound: its `run.id` is an ephemeral correlation id, and the SDK
   keeps no local job store, starts no hidden `nika serve`, and reads no
   journal to fake durability.
8. Ownership has no registry. The facade maps each handle it created to its
   session in a `WeakMap`. The deprecated `nika.events(run)`,
   `nika.cancel(run)` and `nika.status(run)` wrappers resolve through it, so a
   foreign, reconstructed, serialized, or other-client handle still throws
   `NikaRunOwnershipError`. `nika.events(run)` keeps yielding the protocol
   vocabulary unchanged. The wrappers stay for one release train counted from
   publication: they ship unchanged in the first published train that carries
   the Run-owned lifecycle, the earliest train that may remove them is the one
   after it, and the removal is the One SDK baseline owner's decision (#114),
   announced in that train's release notes. No version or date is fixed.
9. An interrupted observation is a typed transport error carrying its cursor
   (`NikaObservationInterrupted`), never an engine failure: the run may still
   be running. The engine's own `interrupted` evidence state is data instead:
   a `run.interrupted` event and `result.status === 'interrupted'`.

## Deletion test

If one Adapter is removed, the facade and lifecycle Seam remain coherent and
the other Adapter still compiles. If the Transport Interface is removed,
authority differences leak into every public method. If `run-session.ts` is
removed, each consumer must reimplement buffering, ownership, cancellation,
and settlement. Those boundaries therefore carry real architectural load.
