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
| Answer round | the kept round's judged answer round by its `replay_token` (judge calls only) where `/health` lists `compileJudgedAnswerRound`, else a fresh round carrying the answers; or its zero-call replay | the engine replays the plan it recorded under `.nika/compile/` |
| The files the intent names | observed by the LOCAL engine in the client's `cwd` and sent as `observed_world` where `/health` lists `compileObservedWorld` (see below) | observed by the engine in its working directory |
| Who judges a candidate | the operator's decision model where `/health` lists `compileDecisionSeat` (`nika serve --decision-model`), else the authoring model | `decisionModel`, else the authoring model |

A door that lacks what a request needs refuses it with
`NikaCompatibilityError` before anything is posted or spawned, and the SDK
never compiles locally as a substitute for a server.

## The files your intent names, over HTTP

A server never reads your files. So that its seat does not ask you for a
field name, a key or a shape it could have read, every generation-2 request
(a provider round, a judged answer round, a zero-call replay) asks the local
engine what it observes of the files the request states — `nika compile
--observe-only -- <intent>` (a text revision: its `original_intent` and its
change), run in the client's `cwd` — and sends that document unchanged as
`observed_world`. It holds what `nika compile` hands its own seat: a CSV's
header, a JSON file's keys and nested key paths, a column's short repeated
values (a status, a kind), counts of value kinds, the absent and
outside-the-project states — never a row. The server admits it only in that
shape, about paths the request states, at most 64 rows and 256 KiB
(`422 compile_observation_refused` otherwise); its seat, its grounding law
and its judge then read it.

| `observe` option | Behavior |
|---|---|
| absent (default) | sent when `/health` lists `compileObservedWorld`; nothing otherwise |
| `true` | required: a server without the capability is a `NikaCompatibilityError` (`capability: 'compileObservedWorld'`) before anything is posted |
| `false` | never observed, never sent |

Where `/health` also lists `compileTrialInputs` (a server that tries
candidates), the same request carries `trial_inputs`: the text of the files
the observation read (the engine offers them only when they are UTF-8 text
and at most 1 MiB in all). The server writes them into a scratch project of
its own and tries each final candidate there before it can be `ready`, in the
observed room `nika compile` and the Session use; the trial's report reaches
its judge and its repairs (`provenance.decision.rehearsal`). These bytes go
to the server that will run the workflow on the same files anyway; they are
never sent to a model nor echoed back. `observe: false` sends neither.

The observation is part of a kept round's input: its answer rounds observe
again, and a file that changed in between makes another input
(`409 compile_replay_input_changed`): author again. A local engine that cannot
print the document (one from before the flag) fails typed with
`capability: 'compileObservedWorld'` and nothing is posted; pass
`{ observe: false }` to compile without it. A local compile ignores the
option: the engine always observes its own working directory.

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
- A judged answer round (`explicitProvider` with a kept round's
  `replay_token`) replays the kept plan with your answers and asks the seat
  only to judge it: judge calls, `compile_version` 2, never a second authoring
  call. It still may spend, on the judge.
- A zero-call replay (`deterministicOnly` with a `replay_token`) makes no call
  and answers generation 1; it asks no verifier either. A local answer round
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
| `replay_token` | `replay_token`: with `explicitProvider` the judged answer round, with `deterministicOnly` the zero-call replay | refused |
| `authoringModel` | refused | `--authoring-model` |
| `decisionModel` | refused | `--decision-model`; on a revision, an engine from `ae6845939` on |
| `fresh` (create) | refused | `--fresh` |
| `output` | refused | `--output` |

Over HTTP the request picks the wire generation:

| Request | Body | `/health` must advertise |
|---|---|---|
| no `cognition` | `compile_version: 1` | `compile` |
| `cognition: 'deterministicOnly'`, no token | `compile_version: 1` with that cognition | `compile` |
| `cognition: 'explicitProvider'` | `compile_version: 2`, a fresh round | `compileNativeV2` |
| `cognition: 'explicitProvider'` and `replay_token` | `compile_version: 2`, the kept round's judged answer round | `compileNativeV2` and `compileJudgedAnswerRound` |
| `cognition: 'deterministicOnly'` and `replay_token` | `compile_version: 2`, the kept round's zero-call replay | `compileNativeV2` |

The SDK refuses with `NikaConfigurationError`, before any request or process,
what the published wire refuses by shape: an unknown field; `intent` mixed
with `workflow`/`change`; a `replay_token` without a cognition or that is not
64 lowercase hex digits; `limits` without a provider opt-in or beside
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
| `replay_token` | HTTP only: the `Nika-Compile-Replay` header of a provider round whose plan the server keeps |
| `judged_answer_round_available` | HTTP only, beside a kept round: whether the server that answered lists `compileJudgedAnswerRound` in `/health`. An SDK fact, read by `nextCompileRequest()` |
| `written`, `existing_destination` | local engine only, when the request named `output` |
| `plan_record_error`, `declined_record_error` | local engine only: it could not keep or remove a record under `.nika/compile/` |

Showing or hiding any of these is your application's choice; the SDK imposes
no display or masking.

## Revision, creation, reuse and intelligence evidence

A provider round can record how it revised or created a workflow, what of the
recalled knowledge the candidate's bytes really hold, and which intelligence
answered. The engine writes these records inside `provenance`; the SDK types
them, checks their known members and hands you the engine's own objects. It
adds, removes, copies, recomputes and corrects nothing.

| Where | Type | What it states |
|---|---|---|
| `provenance.plan.source_revision` | `NikaCompileSourceRevision` | `base_sha256` (the bytes revised), `candidate_sha256` (the bytes written), `resolved` (the words they now answer) |
| `provenance.plan.intent_sha256` | `string` | the digest of the words the record answers |
| `provenance.plan.document_revision`, `provenance.decision.document_revision` | `NikaCompileDocumentRevision` | `mode` (`operations` or `replaced`), both digests, `changed` in order, the `preservation` claimed, the `components` receipts |
| `provenance.plan.document` | `NikaCompileCreatedDocument` | a created document's settled record: `version` (`1`), `candidate_sha256` (the final bytes), `request` (the words they answer), `base_sha256` (`null`: a creation revises no program), `mode` (`written` or `composed`), the `components` receipts |
| `provenance.plan.document_create` | `NikaCompileDocumentCreateSection` | what the complete-document door made, as its answer rounds replay it: `mode`, `resolved`, `base_sha256`, `operations`, `changed`, `preservation`, `components` |
| `provenance.decision.document_create` | `NikaCompileDocumentCreate` | how the door made the document: `mode`, `base_sha256` (the author's own document a `composed` answer's operations applied to, `null` when written), `operations`, `changed`, `preservation`, `components`, their `reuse` witnessed on the outcome's candidate, and `candidate_sha256` (`null` when the outcome holds none) |
| `…components[]` | `NikaCompileComponentReceipt` | the component's identity in its release, each hole bound (`component_literal`, `bound`), node digests, the candidate digest, and for an invoked component its calling task and child program apart |
| `provenance.decision.knowledge_qualification.reuse` | `NikaCompileReuse` | per reference: `consulted`, `expanded`, `invoked`, `revised`, `absent` or `unreadable`, each component witnessed on the candidate's own bytes |
| `provenance.authoring.backend` | `NikaCompileAuthoringBackend` | the seated backend and its model identities, kept apart: requested (`requested_model`), transmitted (`forwarded_model`), configured (`decision_model`, `host`, `endpoint_basis`), reported (`observed_models`, `unreported_models`, a harness's `observed` rows) and attested (`served_model`, `null` when unknown) |

Every record is optional: an older engine, a deterministic round or a door
that made no such record carries none, and its outcome reads exactly as before.
A present record
must have its producer's shape: a digest that is not 64 lowercase hex
characters, a count that is not a non-negative integer, `null` where the
engine never writes `null`, or a missing digest, id, binding or count fails the
compile with `NikaProtocolError` naming the member's path (never its value).
Members the SDK does not know and new vocabulary words (`mode`, `use`,
`verdict`, `kind`) ride through untouched, and explicit `null` stays distinct
from an absent member.

Read the evidence for what it says:

- The plan is the round's replayable record. The engine drops it whole when
  its verifier holds, withdraws or doubts the candidate; the decision record
  then still states the revision that was made, for a preview or for a
  withdrawn candidate whose digest names bytes you never received.
- `base_sha256` identifies the source parent: it is not a session sequence and
  does not prove that earlier revisions are kept.
- A creation settles only when it is ready. `plan.document` binds the final
  bytes, after answers, defaults and the model seating changed them; a round
  still waiting on a mandatory question carries `document_create` and no
  `document`. The engine reads `plan.document` as the program history of those
  bytes: a later change to them is a revision over them, never an answer round
  of the creation. Read `plan.document`'s other members only when its
  `version` is `1`: a record of another version rides through unjudged.
- `decision.document_create.base_sha256` names the author's own earlier
  document inside the creation, never a program you sent.
- A digest is the engine's sha256 of the UTF-8 bytes. Comparing it with your
  own `sha256(candidate)` or `sha256(base)` is your check to make; the SDK
  never makes it for you.
- At engine `7d98023f9` (the 0.123 integration carrier), neither `nika compile`
  nor `POST /v1/compile` lends a component catalogue: a compile revision
  carries `components: []`, and receipts with bindings come from the Session's
  authoring. A receipt is evidence of construction, never a grant: a component's
  permits, model and name are not inherited.

## Answer rounds

`nextCompileRequest(request, outcome, answers, options?)` builds the next
request: the same input with these answers merged over the previous ones. It
maps; it judges nothing.

- **HTTP, a kept round: the judged answer round.** When a provider round
  answered a `replay_token` and its server serves the judged answer round
  (`outcome.judged_answer_round_available`, from the `/health` capability
  `compileJudgedAnswerRound`), the next request is that round's judged answer
  round: the exact input, the merged answers, `cognition: 'explicitProvider'`,
  the token and the previous `limits` (which may narrow it). The server
  replays the kept plan with the answers and asks its seat only to judge the
  replayed bytes: judge calls, `compile_version` 2, never a second authoring
  call. A candidate the seat accepts is `ready`. One it does not accept is
  held (`verify_held`, `incomplete`, no new token) and the server forgets the
  token: any later request with it answers `409 compile_replay_unavailable`.
  If the judged round answers new questions instead, the next request answers
  them by the same token (or by a newer one the round answered).
- **HTTP, a kept round on a server that does not judge.** Where the server
  does not list `compileJudgedAnswerRound`, the next request is a new fresh
  round carrying the answers (no token): the one round there that can judge
  them. It authors again and may spend. `{ cognition: 'deterministicOnly' }`
  asks for the zero-call replay instead; `{ cognition: 'explicitProvider' }`
  asks for the judged round whatever the server advertised, and the client
  then refuses it before posting.
- **HTTP, a kept round: the zero-call replay.** Pass `{ cognition:
  'deterministicOnly' }` for the replay that makes no call: the exact input,
  the token, no `limits`. It binds the answers into the kept plan but asks no
  judge, so a model-authored candidate comes back `incomplete`, a preview with
  its judgment pending (`provenance.decision.pending`); replaying again
  returns the same document. From a replay, the next request stays a replay
  unless you pass `{ cognition: 'explicitProvider' }`.
- **Either way,** the server compares the input byte for byte
  (`409 compile_replay_input_changed` otherwise). Tokens live in that server
  run only: a restart forgets them (`409 compile_replay_unavailable`), an
  operator may limit their count and lifetime, and a lost first answer leaves
  no token. Keep a token as you keep the request; do not log it.
- **HTTP, without a token.** A held candidate, a cold plan round or a round
  that needed no call keeps no plan. The next request is a new fresh round
  and may spend again. The `cognition` option is refused there: there is no
  kept round to answer.
- **Local engine.** The next request repeats the intent with every answer as
  `--answer`. When a round carries at least one answer, the engine replays
  the plan it recorded for that intent under `.nika/compile/` in its working
  directory, with no authoring call, and the seat's verifier may decide it in
  that round; keep the same `cwd` between rounds. `fresh` is dropped. A round
  with no answer reads the intent again and may spend.
- **A held outcome has no next round.** `nextCompileRequest()` refuses it with
  `NikaConfigurationError`: its token is forgotten and asking again would
  author anew. Stop there, or send a new request yourself.
- **`intent.clarification`.** Its answer replaces the whole request. A server
  refuses it as an answer (`422 compile_new_intent_required` on a fresh or
  judged round, `409 compile_replay_input_changed` on a replay): start a new
  create request with the replacement intent. A local engine consumes it as an
  `--answer` only beside a seat.

A loop must be bounded: stop on a held or refused outcome, when a round brings
no new answer, and after a few rounds.

```ts
let request: NikaCompileRequest = { intent, cognition: 'explicitProvider', limits: { max_calls: 8 } };
let outcome = await nika.compile(request);
for (let round = 0; !outcome.ready && round < 4; round += 1) {
  if (isNikaCompileHeld(outcome) || outcome.status === 'refused') break;
  const answers = await askYourUser(outcome.questions); // your application's choice
  if (Object.keys(answers).length === 0) break;
  // After a provider round that kept its plan: its judged answer round where the
  // server serves it, else a fresh round carrying the answers.
  request = nextCompileRequest(request, outcome, answers);
  outcome = await nika.compile(request);
}
```

### Servers without the judged answer round

The judged answer round needs a server that serves it, which `/health` says
with the capability `compileJudgedAnswerRound`, listed beside
`compileNativeV2` by every native server of engine integration commits
`158a961cd` (the round) and `b7dace1e5` (its capability). No released engine
carries them yet. The SDK gates the round the way it gates generation 2: on a
server without the capability it refuses a judged answer round with
`NikaCompatibilityError` (`capability: 'compileJudgedAnswerRound'`) after
`/health` alone, before anything is posted, and the kept round stays
untouched. Beside every kept round it also sets
`outcome.judged_answer_round_available`, so `nextCompileRequest()` chooses a
round the server serves.

A server from before the round, released 0.121.0 and 0.122.0 included, parses
`explicitProvider` with a `replay_token` as `422 malformed_compile_request`,
before any slot or call. The gate keeps that request from it. The SDK still
reports that refusal to a judged answer round as the same
`NikaCompatibilityError`, defensively, for a server replaced since this client
read its `/health` (once per client).

## Held candidates

When the verifier answers on a candidate's bytes and does not accept them, the
engine marks the outcome with an `applied` diagnostic targeting `verify_held`
and leaves it `incomplete`. `candidate` then holds a preview to show at most:
never run it or save it as an accepted result. `isNikaCompileHeld(outcome)`
reads the marker. A server keeps no replay token for it, and a held judged
answer round forgets the token it answered (a later request with it answers
`409 compile_replay_unavailable`), so asking again is a fresh round. A `verify_resume` marker means no admitted judgment was made: the
candidate is withdrawn and the round's record kept.

The SDK refuses with `NikaProtocolError` an outcome that calls itself `ready`
while carrying either marker, so a held or withdrawn candidate never reads as
ready.

## Errors

| Error | When |
|---|---|
| `NikaConfigurationError` | the request or options break a shape law (above); nothing was sent or spawned |
| `NikaCompatibilityError` | the door lacks `compile`, `compileNativeV2`, `compileJudgedAnswerRound`, a required `compileObservedWorld` or a field (`compileOptions`); the local engine could not observe the request's files; or the answer carries a wire generation this request cannot receive |
| `NikaProtocolError` | the answer breaks the contract: malformed JSON, a ready outcome without candidate or with a held marker, generation 2 without its receipt, a replay token where none can be, a destination the request never named |
| `NikaTransportError` | aborted, timed out, the engine could not be spawned or was killed |
| `NikaOperationError` | the engine refused: `code` is its machine code, `status` the HTTP status or the local exit code |

`POST /v1/compile` refusals, as `NikaOperationError.code`:

| Status | Codes |
|---|---|
| 401 | `unauthorized` |
| 408 | `request_timeout` (intake, generation 1, replays) · `compile_deadline_exceeded` (a fresh round's absolute deadline passed; a call in flight may still be billed) |
| 409 | `compile_replay_unavailable` (an unknown, expired or forgotten token: a held judged round forgets its own) · `compile_replay_input_changed` · `compile_context_changed` (the server's pinned knowledge snapshot moved; nothing was sent) |
| 413 | `body_too_large` |
| 415 | `unsupported_media_type` · `unsupported_content_encoding` |
| 422 | `malformed_compile_request` · `compile_version_unsupported` · `compile_mode_unsupported` · `compile_cognition_unsupported` · `compile_limit` · `compile_new_intent_required` · `compile_observation_refused` · `compile_trial_inputs_refused` |
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
- a provider round (fresh or judged) with `limits.deadline_ms` waits for that
  deadline, the server's 5 s handoff and one `requestTimeout` more, so the
  server's own `408 compile_deadline_exceeded` arrives before the client stops
  waiting;
- a provider round without `timeoutMs` or `limits.deadline_ms` gets no SDK
  deadline. The server sets none either unless its operator configured one
  (`nika serve --authoring-deadline`): the round runs until it settles.

Stopping your wait stops neither the server's round nor its spend, and loses
its answer and replay token. The server sends its headers only when the round
settles, and Node's built-in `fetch` stops waiting for response headers after
300 seconds. So a provider round with no deadline is posted through
`node:http`/`node:https`, which set no header or body deadline: only your
`signal` or the server ends the wait. A `fetch` you pass in the configuration
is used for every request, this one included, with its own timeouts: give it
a dispatcher that allows the round's length, or set `limits.deadline_ms`. A
local compile has no deadline unless you set one; a stopped child receives
SIGTERM, then SIGKILL after two seconds.

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
- An HTTP compile writes nothing, anywhere. Its generation-2 requests spawn
  the local engine with `compile --observe-only` (read-only, same bounds as
  above) unless `observe: false`.

## Engine versions

By the engine source at its release tags: 0.120.3, the engine this package
version bundles, speaks generation 1 only, without `requested_trigger` or
`choice` questions, and its CLI has none of the seat flags. 0.121.0 adds the
seat flags, `requested_trigger`, `choice` questions and Serve generation 2,
without `limits.max_calls`. 0.122.0 adds `limits.max_calls` and
`--authoring-max-calls`. The judged answer round and its capability are newer
still: engine integration commits `158a961cd` and `b7dace1e5`, in no release
yet; so are `nika compile --observe-only`, `observed_world` with its
`compileObservedWorld` capability, `trial_inputs` with `compileTrialInputs`,
and `nika serve --decision-model` with `compileDecisionSeat` (the 0.123
integration line). An engine without a flag
answers with a usage error; a server without a field answers
`422 malformed_compile_request`. Point `NIKA_BIN` (or `bin`) at the engine you
mean to use.

The pinned `openapi.json` and `src/generated/openapi.d.ts` describe an
unseated resident of the engine `ENGINE_QUAL_PIN` names (main `0e4e1c74f`),
whose document carries no generation 2. The generation-2 types are
written by hand from the engine source: `nika-serve/src/server/compile/v2.rs`,
`author.rs` and `openapi-native.json` (at `158a961cd` for the judged answer
round), `nika-serve/src/server/model.rs` (at `b7dace1e5` for its capability),
`nika-compile/src/wire.rs` and `nika-cli-host/src/compile.rs` with
`compile/render.rs`. The evidence types follow their producers at the
integration carrier `7d98023f9`: `nika-compile-seats` `foundry/document.rs`,
`instance.rs`, `invoke.rs`, `witness.rs` and `foundry.rs`, and the authoring
backend of `nika-providers` `authoring.rs`, `nika-cli-host`
`compile/authoring.rs`, `nika-serve` `compile/author.rs` with its
`openapi-native.json` and `nika-harness`; no release writes them yet.

## Example

[`examples/compile-then-run.ts`](../examples/compile-then-run.ts) compiles an
intention, answers its questions from a JSON file (over HTTP by the judged
answer round), writes the ready candidate and runs it through `run()`, on
either door. It reads the server URL and token
or the engine binary from the environment and embeds no key.
