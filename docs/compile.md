# Compile: from an intention to a checked workflow

`nika.compile(request)` asks the engine for a candidate workflow and runs
nothing. The outcome is data: `ready`, `incomplete` and `refused` all resolve,
and only transport, protocol, compatibility and engine-stamped failures throw.
A ready candidate is ordinary `.nika` source; you write it to a file and
`run(path)` admits it again, exactly like any other workflow.

```text
compile(request) ──▶ outcome
  ready ──────▶ write outcome.candidate ──▶ run(path)       Check admits it again
  incomplete ─▶ outcome.questions ──▶ nextCompileRequest(request, outcome, answers)
                                          └──▶ compile(next request) ...  (bounded: stop
                                               when a round brings no new answer)
  refused ────▶ outcome.diagnostics                          stop
```

The SDK holds no compiler. Both doors print the engine's one machine document
(`nika-compile/src/wire.rs::outcome_document`); the SDK validates it, keeps the
engine's fields verbatim and adds only `ready`, the replay token of a kept
round (HTTP) and the CLI's own facts (local engine).

## Two doors

| | `new Nika({ url, token })` | `new Nika()` (local engine) |
|---|---|---|
| Route | `POST /v1/compile` of `nika serve --bind` | `nika compile --json` |
| Deterministic compile | `compile` capability in `/health` | `compile` capability in `--sdk-identity` |
| Provider round | `cognition: 'explicitProvider'`; `/health` must advertise `compileNativeV2` | `authoringModel: 'provider/name'` |
| Who chooses the model | the server's operator (`nika serve --authoring-model`) | you, per request |
| Credentials | the server's environment | the local engine's environment |
| Answer round | replay by `replay_token`, zero provider calls | the engine replays the plan it recorded under `.nika/compile/` |

A door that lacks what a request needs refuses it with
`NikaCompatibilityError` before anything is posted or spawned, and the SDK
never compiles locally as a substitute for a server.

## What is a provider call, and what is not

- Without an opt-in, compile is deterministic. It contacts no provider, even
  when a key sits in the environment: an ambient key is never consent.
- HTTP `cognition: 'explicitProvider'` opts one fresh round into the server's
  seated model. It may spend. Its `limits` may only narrow the operator's
  bounds; above them the server answers `422 compile_limit`, never a clamp.
- A local `authoringModel` seats that model for this request. A local
  `decisionModel` seats a bounded-decision capability for finite ambiguities;
  its choices are recorded in `provenance.decision` and its cognition reads
  `explicitDecision`.
- An outcome is `compile_version: 2` exactly when a provider call happened;
  `provenance.authoring` is then the receipt (model, logical `calls`, token
  counters, `backend.authority`). Token usage is not an invoice.
- A replay (`deterministicOnly` with a `replay_token`) makes zero calls and
  answers generation 1; it asks no verifier either. A local answer round
  replays the recorded plan with no authoring call; a verifier that round asks
  makes its own calls.
- Compile creates no run, job, approval, trace, schedule or permission. The
  SDK reads no credential and sends none.

## The request

```ts
// HTTP: one provider round under the server's seat, narrowed by limits.
const first = await nika.compile({
  intent: 'Every morning at 9, summarize ./inbox/*.md into ./digest.md',
  cognition: 'explicitProvider',
  limits: { max_calls: 6, deadline_ms: 120_000 },
});

// Local engine: the model you seat, its key read by the engine.
const local = await new Nika().compile({
  intent: 'Every morning at 9, summarize ./inbox/*.md into ./digest.md',
  authoringModel: 'mistral/mistral-small-latest',
  limits: { max_calls: 6 },
});
```

Fields that exist on the HTTP wire keep their wire spelling; fields that only
a local engine has are named after the flag they become.

| SDK field | HTTP body | Local engine argv |
|---|---|---|
| `intent` | `mode: "create"`, `intent` | the positional after `--` |
| `workflow` + `change` | `mode: "edit"`, `source`, `change: {text}` or `{set_constant}` | `--base <scratch file>` and `--change=<text>`; a `set_constant` becomes `Set const.NAME to JSON` |
| `original_intent` (edit) | `original_intent` | the positional beside `--base` |
| `workflow_id` (create) | `workflow_id` | refused: the `output` file name names the workflow |
| `answers` | `answers`, each a JSON value | `--answer=KEY=JSON`, once per key |
| `cognition` | `cognition` | refused |
| `limits.max_calls` | `limits.max_calls` | `--authoring-max-calls` |
| `limits.repairs` | `limits.repairs` | `--authoring-repairs` |
| `limits.max_tokens` | `limits.max_tokens` | `--authoring-max-tokens` |
| `limits.call_timeout_ms` | `limits.call_timeout_ms` | `--authoring-timeout`, whole seconds only |
| `limits.deadline_ms` | `limits.deadline_ms` | refused: no flag; bound the child with `timeoutMs` |
| `replay_token` | `replay_token` | refused |
| `authoringModel` | refused | `--authoring-model` |
| `decisionModel` (create) | refused | `--decision-model` |
| `fresh` (create) | refused | `--fresh` |
| `output` | refused | `--output` |

Over HTTP the request picks the wire generation:

| Request | Body | `/health` must advertise |
|---|---|---|
| no `cognition` | `compile_version: 1` | `compile` |
| `cognition: 'deterministicOnly'`, no token | `compile_version: 1` with that cognition | `compile` |
| `cognition: 'explicitProvider'` | `compile_version: 2`, a fresh round | `compileNativeV2` |
| `cognition: 'deterministicOnly'` and `replay_token` | `compile_version: 2`, a replay | `compileNativeV2` |

The SDK refuses with `NikaConfigurationError`, before any request or process,
what the published wire refuses by shape: an unknown field; `intent` mixed
with `workflow`/`change`; a `replay_token` without `deterministicOnly` or that
is not 64 lowercase hex digits; `limits` without a provider opt-in or beside
`deterministicOnly`; a limit that is not an integer within its published range
(`max_calls` and `max_tokens` 1–4294967295, `repairs` 0–4294967295, the two
durations from 1 ms); `original_intent` beside `set_constant`; a create-only
field on an edit. Over HTTP it also refuses `original_intent` on generation 1
and a generation-2 text change without `original_intent`. A field the chosen
door does not have is a `NikaCompatibilityError` with `capability:
'compileOptions'`. Answers and constant values are strict JSON, judged without
running caller code; a key cannot be empty or contain `=`.

Not exposed: `--authoring-samples`, `--authoring-strategy`,
`--authoring-reasoning`, `--knowledge`, `--knowledge-exclude`,
`--knowledge-pack`, `--no-knowledge`, `--hot-policy`, `--force`,
`--private-authoring-capture` and `--list`. A local engine still reads
`NIKA_AUTHORING_REASONING` and `NIKA_KNOWLEDGE*` from its own environment.

## The outcome

| Field | Meaning |
|---|---|
| `compile_version` | `2` when a provider call happened, else `1` |
| `status`, `ready` | the engine's completeness word; `ready` is exactly `status === 'ready'` |
| `candidate` | `.nika` source. Proposed only when ready; under `incomplete` a non-null candidate is a preview |
| `questions[]` | `key`, `label`, `type` (`text`, `literal` or `choice` with `options[]`), `why`, `mandatory`. `mandatory: false` belongs to a binding outside the program (a schedule's timezone, missed-run and overlap policies, ceiling) and never blocks ready |
| `diagnostics[]` | `kind`, `target`, `message`. Compiler targets include `semantic_verification`, `verify_held` and `verify_resume` |
| `requested_boundary` | the permits the candidate requests; never a grant |
| `requested_trigger` | the trigger the request names (`kind`, `status`, `cadence`, `cron`…), a requirement you bind through the schedule contract; absent on engines before the field |
| `check_preview` | the source-only Check report; never admission |
| `provenance` | `compiler_version`, `spec_pin`, `skeleton`, `cognition`, and when present `strategy`, `suggested_file`, `plan`, `decision`, `authoring` |
| `replay_token` | HTTP only: the `Nika-Compile-Replay` header of a fresh round whose plan the server keeps |
| `written`, `existing_destination` | local engine only, when the request named `output` |
| `plan_record_error`, `declined_record_error` | local engine only: it could not keep or remove a record under `.nika/compile/` |

Showing or hiding any of these is your application's choice; the SDK imposes
no display or masking.

## Answer rounds

`nextCompileRequest(request, outcome, answers)` builds the next request: the
same input with these answers merged over the previous ones. It maps; it
judges nothing and never decides to spend for you.

- **HTTP, with a token.** The next request replays the kept round: the exact
  input, `cognition: 'deterministicOnly'`, the token, no `limits`, zero
  provider calls. The server compares the input byte for byte
  (`409 compile_replay_input_changed` otherwise). A replay binds the answers
  into the kept plan but asks no verifier, so a model-authored candidate comes
  back `incomplete`: a preview with the answers in place and its judgment
  pending (`provenance.decision.pending`). Replaying again returns the same
  document. To have it judged, send a new provider round carrying every
  answer: your first request with `answers`. That round may spend, and the
  verifier then decides `ready` or holds the candidate.
- **HTTP, without a token.** A held candidate, a cold plan round or a round
  that needed no call keeps no plan. The next request is a new fresh round
  and may spend again.
- **Tokens** live in that server run only: a restart forgets them
  (`409 compile_replay_unavailable`), an operator may limit their count and
  lifetime, and a lost first answer leaves no token. Keep a token as you keep
  the request; do not log it.
- **Local engine.** The next request repeats the intent with every answer as
  `--answer`. When a round carries at least one answer, the engine replays
  the plan it recorded for that intent under `.nika/compile/` in its working
  directory, with no authoring call, and the seat's verifier may decide it in
  that round; keep the same `cwd` between rounds. `fresh` is dropped. A round
  with no answer reads the intent again and may spend.
- **`intent.clarification`.** Its answer replaces the whole request. A server
  refuses it as an answer (`422 compile_new_intent_required` on a fresh round,
  `409 compile_replay_input_changed` on a replay): start a new create request
  with the replacement intent. A local engine consumes it as an `--answer`
  only beside a seat.

A loop must be bounded: stop when a round brings no new answer, and cap the
number of rounds.

```ts
const first: NikaCompileRequest = { intent, cognition: 'explicitProvider', limits: { max_calls: 8 } };
let request = first;
let outcome = await nika.compile(request);
const given: Record<string, unknown> = {};
for (let round = 0; !outcome.ready && round < 4; round += 1) {
  if (isNikaCompileHeld(outcome) || outcome.status === 'refused') break;
  const reply = await askYourUser(outcome.questions); // your application's choice
  if (Object.keys(reply).length > 0) {
    Object.assign(given, reply);
    request = nextCompileRequest(request, outcome, reply); // a zero-call replay when a token came back
  } else if (request.replay_token !== undefined) {
    request = { ...first, answers: given }; // have the answered candidate judged; it may spend
  } else {
    break; // nothing new to send
  }
  outcome = await nika.compile(request);
}
```

## Held candidates

When the verifier answers on a candidate's bytes and does not accept them, the
engine marks the outcome with an `applied` diagnostic targeting `verify_held`
and leaves it `incomplete`. `candidate` then holds a preview to show at most:
never run it or save it as an accepted result. `isNikaCompileHeld(outcome)`
reads the marker. A server keeps no replay token for it, so asking again is a
fresh round. A `verify_resume` marker means no admitted judgment was made: the
candidate is withdrawn and the round's record kept.

The SDK refuses with `NikaProtocolError` an outcome that calls itself `ready`
while carrying either marker, so a held or withdrawn candidate never reads as
ready.

## Errors

| Error | When |
|---|---|
| `NikaConfigurationError` | the request or options break a shape law (above); nothing was sent or spawned |
| `NikaCompatibilityError` | the door lacks `compile`, `compileNativeV2` or a field (`compileOptions`), or the answer carries a wire generation this request cannot receive |
| `NikaProtocolError` | the answer breaks the contract: malformed JSON, a ready outcome without candidate or with a held marker, generation 2 without its receipt, a replay token where none can be, a destination the request never named |
| `NikaTransportError` | aborted, timed out, the engine could not be spawned or was killed |
| `NikaOperationError` | the engine refused: `code` is its machine code, `status` the HTTP status or the local exit code |

`POST /v1/compile` refusals, as `NikaOperationError.code`:

| Status | Codes |
|---|---|
| 401 | `unauthorized` |
| 408 | `request_timeout` (intake, generation 1, replays) · `compile_deadline_exceeded` (a fresh round's absolute deadline passed; a call in flight may still be billed) |
| 409 | `compile_replay_unavailable` · `compile_replay_input_changed` · `compile_context_changed` (the server's pinned knowledge snapshot moved; nothing was sent) |
| 413 | `body_too_large` |
| 415 | `unsupported_media_type` · `unsupported_content_encoding` |
| 422 | `malformed_compile_request` · `compile_version_unsupported` · `compile_mode_unsupported` · `compile_cognition_unsupported` · `compile_limit` · `compile_new_intent_required` |
| 500 | `internal_error` · `compile_disclosure_refused` (the answer would carry a withheld credential) |
| 503 | `compile_busy` · `compile_replay_capacity` · `stopping` |

Local engine refusals arrive with exit 2 (`destination_name`,
`invalid_answer`, `authoring_authority`) or exit 3 (`read_base`, `knowledge`,
`authoring_config`, `compile_error`, `destination`). An engine that does not
know a flag answers with its usage error and no machine document; the SDK
reports it as `NikaProtocolError` quoting that error. The type
`NikaCompileRefusalCode` lists these words without closing the vocabulary.

## Time and cancellation

`signal` and `timeoutMs` stop this request or child only. Over HTTP:

- a generation-1 request or a replay keeps the client's `requestTimeout`
  unless `timeoutMs` is set;
- a provider round with `limits.deadline_ms` waits for that deadline, the
  server's 5 s handoff and one `requestTimeout` more, so the server's own
  `408 compile_deadline_exceeded` arrives before the client stops waiting;
- a provider round without `timeoutMs` or `limits.deadline_ms` gets no SDK
  deadline. The server sets none either unless its operator configured one
  (`nika serve --authoring-deadline`): the round runs until it settles.

Stopping your wait stops neither the server's round nor its spend, and loses
its answer and replay token. Node's built-in `fetch` stops waiting for
response headers after 300 seconds by default, and the server sends its
headers only when the round settles: keep `limits.deadline_ms` under that, or
pass a `fetch` whose dispatcher allows longer `headersTimeout` and
`bodyTimeout`. A local compile has no deadline unless you set one; a stopped
child receives SIGTERM, then SIGKILL after two seconds.

Responses are bounded: 8 MiB for a local compile and for an HTTP
generation-2 request, whose answer carries the round's plan, decision records
and receipt. An HTTP generation-1 answer keeps the smaller of
`machineBufferBytes` (64 KiB by default) and 8 MiB.

## Files a local compile touches

- **Reads** the files a free intent names under the working directory, as a
  bounded observation of their keys and short repeated values, never their
  rows. An edit's base travels through a 0600 scratch file in a 0700 temporary
  directory, removed on every path.
- **Writes** the plan record `.nika/compile/<intent sha256>.plan.json` and the
  verdicts `.nika/compile/<intent sha256>.declined.json` (the directory ignores
  itself for Git), and with `output` the ready candidate. Nothing that is not
  ready is ever written to `output`.
- An HTTP compile writes nothing, anywhere.

## Engine versions

By the engine source at its release tags: 0.120.3, the engine this package
version bundles, speaks generation 1 only, without `requested_trigger` or
`choice` questions, and its CLI has none of the seat flags. 0.121.0 adds the
seat flags, `requested_trigger`, `choice` questions and Serve generation 2,
without `limits.max_calls`. 0.122.0 adds `limits.max_calls` and
`--authoring-max-calls`. An engine without a flag answers with a usage error;
a server without a field answers `422 malformed_compile_request`. Point
`NIKA_BIN` (or `bin`) at the engine you mean to use.

The pinned `openapi.json` and `src/generated/openapi.d.ts` describe the
released 0.120.3 resident and stay pinned to it. The generation-2 types are
written by hand from the engine source: `nika-serve/src/server/compile/v2.rs`,
`author.rs` and `openapi-native.json`, `nika-compile/src/wire.rs` and
`nika-cli-host/src/compile.rs` with `compile/render.rs`.

## Example

[`examples/compile-then-run.ts`](../examples/compile-then-run.ts) compiles an
intention, answers its questions from a JSON file, writes the ready candidate
and runs it through `run()`, on either door. It reads the server URL and token
or the engine binary from the environment and embeds no key.
