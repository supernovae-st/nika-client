# The authoring Session

`compile()` is one stateless authoring request. The authoring Session is the
engine's conversation: the same `SessionRuntime` the `nika` terminal opens,
which keeps the request, its questions, the candidate under review, what was
saved and the runs it requested. The SDK reaches it through the engine's host
doors and adds nothing of its own: the engine reads every line, keeps every
identity and decides what happens; the SDK sends lines and hands you the
frames the engine wrote.

```ts
import { Nika, NikaSessionRefusedError } from '@supernovae-st/nika';

const nika = new Nika({ cwd: '/path/to/project' }); // or { url, token }
const session = await nika.openSession();
let shown = session.opened!.snapshot;               // what your interface shows

const result = await session.submit(shown, 'Résume mes notes chaque matin à 8h');
for (const outcome of result.outcomes ?? []) console.log(outcome.kind, outcome.text);
shown = result.snapshot;                            // the next thing to show

await session.close();
```

## Doors

| | Local engine | `nika serve` |
|---|---|---|
| Opens | `nika session --json` in the client's `cwd`: one process, one Session | `POST /v1/sessions`: the served project's Session |
| Project world | the client's directory | the server's project: `work.root` names a server path, never one on the client |
| Capability | `sessionHost` in the engine identity | `sessionHost` in `/health` |
| Another live Session | the engine refuses (`session_unavailable`) | `session_live` with the live id: `attachSession(id)` |

Without the capability, `openSession()` fails with `NikaCompatibilityError`
before any process is started or request is posted. The SDK never falls back
to the interactive terminal or to `compile()`.

### The conversation's own intelligence

`openSession({ intelligence: '2 deepseek/deepseek-v4-pro' })` opens the
Session with an intelligence chosen for this conversation alone, in the
engine's own first-screen words, passed as written: natively
`nika session --json --intelligence <words>`, over HTTP the `intelligence`
member beside the contract in `POST /v1/sessions`. The engine neither reads
nor writes the operator's kept choice, so opening this way never changes what
the person's next Session starts with; `work.intelligence.selected.scope`
reads `conversation` (`operator_default` for the operator's kept choice).
Words the engine does not read come back as a `session_unavailable` refusal
in its own words (`NikaSessionRefusedError`; status 409 over HTTP). It needs
the `sessionIntelligence` capability, in the engine identity or `/health`:
without it, nothing is started or posted (`NikaCompatibilityError`), and the
SDK never answers the first screen for you. `attachSession()` refuses the
option: a live Session keeps its own choice, which `/intelligence <words>`
changes from inside it.

## A line names the snapshot it answers

Every published snapshot has an opaque handle. `submit(snapshot, line)` sends
the line together with the handle of the snapshot it was typed against, and the
engine answers it with the `Waiting` value that snapshot held. When the Session
has moved on, the line is refused (`stale_snapshot`, or `unknown_snapshot` for
a handle this Session never published) and nothing reaches the runtime: show
the refusal's `snapshot` and let the person answer again. The SDK never resends
a line against a newer snapshot on its own, and it never decides whether a
line is a consent, an answer or a new request.

`work` is the engine's own snapshot (`nika/session-work@0`), carried verbatim:
`waiting` says what the next line answers, `candidate` holds the exact changes
a consent would land, `saved` the last Save and `requested`/`run` the Run
requested and the Run observed. A preview is not a Save, and a Save is not a
Run. Two waits carry more than their kind: `knowledge_choice` (engine
`5f1e91c6f`) holds the `line` a refused knowledge source stopped, exactly as
typed and sent nowhere (`/knowledge embedded` resumes it once, `cancel` drops
it), and `questions` (engine `6d217dfba`) lists in `ids` the witnesses of the
questions an intelligence asks together, in the order asked; the next line
may answer any of them. Neither is answered for the person.

From the 0.123 integration engine on, the snapshot also carries what a remote
interface needs to show and verify without reading anything else:

| Member | Type | What it states |
|---|---|---|
| `candidate.files[].content` | `string` | the exact bytes a consent lands; `bytes` stays their BLAKE3 witness (not a sha256) |
| `candidate.revision` | `NikaSessionDocumentRevision \| null` | how the candidate's workflow was made, bound to its bytes: a creation (`base_sha256` `null`, `mode` `written` or `composed`, engine `f1dad1ef5`) or a revision of its complete document (`operations`, `replaced`); `candidate_sha256` (sha256), `changed` in order, `preservation`, and each component's identity, bindings and `witness` on those very bytes; a compact projection of the compile's record, `null` when none binds the bytes |
| `authoring.draft` | `string \| null` | the compiler's candidate bytes, proposed or not: what to show while a question waits; showing it consents to nothing |
| `authoring.calls` | `NikaSessionAuthoringCalls \| null` | the compiler's receipt of its authoring calls: the model they asked for (`requested_model`, never what served them), how many, the reported usage (`null` when unknown, never `0`) and the `backend` as its transport named it; `null` when the compile made no call. `per_call` (`NikaSessionAuthoringCall[]`, engine `ca5845b85`, hyphenated roles kept since `2db30c6e2`) names each call in call order through the engine's allowlist: `call` (its role as the engine names it, such as `document`, `document-repair`, `revision-repair`), `instruction_sha256`, `schema_sha256`, `message_bytes` (the text content of its messages, not the serialized request), `references` (a count), `max_output_tokens` and `timeout_ms` (asked bounds), `elapsed_ms`, `stop_reason` or the engine's `failure_kind` (`admission_refused`, `provider_error`, `timeout`), `usage_reported`, `input_tokens`, `output_tokens`, `reasoning_effort` (asked, not served), `reasoning_tokens`; every fact is written, `null` when unrecorded, never guessed; digests are 64 lowercase hex; never summed into the totals; absent from engines that do not project the calls. No prompt, answer, proposed object, served model name or error text rides there |
| `question` | `NikaSessionQuestion`, absent otherwise | the compiler's own question while `waiting` is a `question` naming the same key: `key`, `label`, `type` (`text`, `literal`, `choice`, or `other` for a shape the engine does not name), `why`, `mandatory`, and `options` (`[{ key, label }]`, in the compiler's order) for a choice that has some; absent when no question waits, never `null` (host `46817419a`). The answer still names `waiting.id` |
| `answered` | `NikaSessionAnswered`, absent otherwise | what the Session did with the last line typed for an authoring question, recorded at the act itself: `question` (that question's witness, the string its `waiting.id` carried) and `act`, then that act's own members: `bound` (`key`, `value` exactly as bound, `reading`: `as_typed`, `offered_key`, `model_read`, or `seat_default` when an empty line took the seat the person chose, engine `2812ea11b`), `dropped` (`key`), `restated` (`key`), `waits` (`key`, `why`), `refused` (`class`, the stable refusal word); acts, readings and classes stay open. Never derived from the turn's outcome: a bound value stays bound when the compile that follows fails. Absent when the last line answered nothing (an aside, a read-only command, a line for another prompt) and in a restored Session, never `null`; every line clears it first and rereading returns the same. It names the question within this Session only and grants nothing |
| `intelligence` | `NikaSessionIntelligence` | configured facts: the person's `selected` intelligence as the engine's machine resolved it, the `author` seat, the `decision` seat selected and the `effort`; a selection is never the model that served a call |
| `knowledge` | `NikaSessionKnowledge`, absent otherwise | the authoring knowledge the Session reads now, a configured fact and never a call receipt, in one `state`: `admitted` (a release the strict door admitted: `source` `embedded` or `disk`, its `version` or `null`, its `manifest_sha256`, and `by`: `default`, `conversation`, `host` or `environment`), `refused` (a source the configuration names, refused: `source`, `by`, the stable `code` and its `cause`, never a host path; a line that would reach a model then waits as `knowledge_choice`) or `unread` (`why`). Engine `5f1e91c6f`; absent when the Session states none, never `null`; states stay open and grant nothing |
| `authoring.stages` | `NikaSessionStageTimes \| null` | how long the compile's other stages took, as its decision record states them (engine `5f1e91c6f`): `qualification_ms` (the knowledge qualification's wall time, or `null`) and `trials`, each trial of a candidate in the order run with its `attempt` (`completed`, `stopped`, `never_attempted`), `elapsed_ms` (`null` when never attempted, never `0`) and `runtime_bound_ms`; never summed, no output or text of the record; `null` when the record states neither stage |
| `bindings`, `delegations`, `questions` | lists, each absent when empty | what a conversation led by an intelligence holds (engine `6d217dfba`): the values the candidate binds (`NikaSessionBinding`: `key` when a question asked for it, `role` (`read_source`, `output_path`, `run_model`, `value`), the exact `value`, and its `provenance`: `kind` (`named`, `delegated`, `derived`, `offered`, `answered`, `retained`), the person's line it rests on (`message`: `u1`, `u2`, …) with their `excerpt`, or an accepted offer's `question` and `option`); the choices the person delegated (`NikaSessionDelegation`: `message`, `excerpt`, `scope`); and the questions asked now (`NikaSessionAskedQuestion`: `id` (its witness, what `waiting.ids` lists), `key`, `question`, `why`, `role`, `state` `open` or `after` with the keys it waits for, `options` with their values, `free_text`, `multi_select`). A provenance is a record, never an authorization; questions are never kept across a reopen. With the doors (engine main from `a3017c495`) an offered `run_model` value carries `choice` (`NikaSessionModelFacts`: the `role` it would serve, the exact `model`, the route `via`, its `class`, whether it is `configured` here, its `billing`, and `output_usd_per_million` on a metered route, absent when unknown, never `0`), absent when this machine's inventory offers no such model |
| `queued` | `NikaSessionQueuedLine[]`, absent when none | with the doors: the lines the person sent while the last run was under way (`steer()`, `followUp()`) and what became of each: `entered` with its `cite`, or `returned` unsent |
| `run` | `NikaSessionRun \| null` | the last observed Run with only the identities its observation carried: `current` (the Run of the workflow saved last), `workflow`, `end` (`{ end }`, plus `exit` for `unknown`), `trace`, `execution`, `workflow_sha256` (the source hash its start named), `chain_head`, `chain_len`; every member written, `null` where unobserved. A Run without `workflow_sha256` does not prove which bytes ran: both session-host doors observed none up to host `4271f09ef`; from host `b5d844d84` a run names what it observed of itself (recorded here from a real resident over HTTP at `312c3d5a8`: the sha256 of the bytes it ran, the job's execution uuid and opaque trace, the receipt head). `sealed` (engine `ad70c9aa7`) says whether the Run sealed its journal: an `interrupted` Run that sealed stopped at a wave boundary and its trace verifies, one that did not was cut mid-flight and its trace is incomplete; absent before that engine |

The SDK checks these members where they are, as it checks a compile's
evidence: a present member of another shape fails with `NikaProtocolError`
naming its path (never its value), while absent members (an older engine),
`null` where the engine writes it and every member the SDK does not know ride
through untouched.

## Commands, waits and Stop

`submit` and `stop` are commands. Each carries an identity (`command`,
generated unless you pass one). The engine keeps one ledger per Session:

- the same identity with the same bytes returns the recorded result again with
  `replayed: true`; the turn never runs twice;
- the same identity with other bytes is refused (`command_conflict`).

A `signal` stops your wait only. The engine keeps an accepted turn running;
the wait fails with `NikaSessionWaitError` naming the command, and sending the
same command again reads its result. `stop()` asks the turn under way to stop:
its result is a receipt (`stop_requested`, `run_stopping`, `nothing_to_stop`,
`run_underway`), and the stopped turn's own result settles it, ending with a
`cancelled` outcome whose `withdrawn` lists the proposal or question it
withdrew. From engine `ad70c9aa7` a Stop also reaches the Run a turn executes
when its door can stop it (the native door can, and from `0e4e1c74f` a
resident too; see below): `run_stopping` means the Run took its first signal,
as a first Ctrl-C sends it (work in flight completes and is counted, no new
wave starts) and `busy.phase` reads `stopping`; a second Stop sends nothing
more and a Stop never escalates to an abort.
`close()` ends the Session (natively, its process); it carries no identity and
over HTTP is the route's `DELETE`. A second line while a turn runs is refused
(`busy`) and returned to you. A local handle binds each identity to the bytes
it first sent, as the engine's ledger does, so the same identity with other
bytes is refused there before anything is written, even after its wait was
cancelled.

Reads (`snapshot()`, `details()`) and `stop()` never wait for the turn.

### Lines for a conversation's run under way

With the engine's Session doors (engine main from `a3017c495`), a person can
speak to the run an intelligence leads while it works. `steer(line)` sends a
line that enters after the calls under way (a tool call the intelligence asked
for meanwhile is not run: it reads the person's line first); `followUp(line)`
one that enters when the run would end. Both are commands with an identity,
answered at once with a receipt bound to the turn they found (`target`):
`queued`, with the line as it waits (`queued`: its identity `l1`, `l2`, …,
`mode`, the words and `state`), `not_reading` (a turn runs that no
conversation's run reads: send the line once it settled), `nothing_to_steer`
(no turn: submit the line), `blank` or `full` (the run took as many lines as
it takes, 32 at `a3017c495`). A queued line enters as the person's next cited
line (`u2`, …) and only then authorizes anything; a line is never kept for a
later run. `busy.queued` shows the lines the run reads now; `work.queued` keeps
what became of each after the run (`entered` with its `cite`, or `returned`
unsent). Stopping such a turn settles it with a `stopped` outcome
(`NikaSessionStopped`): `reach` (`between_steps`, `request_dropped`: a request
already sent may still be billed, or `agent_cancelled`: the agent was asked
once and ended its turn), the Session's `text`, the lines it returned `unsent`
and the draft revision it kept (`candidate`).

From engine `0e4e1c74f` both doors name the doors' word, `sessionSteering`
(the native identity and a resident's `/health`), and the handle sends these
lines only to a door whose identity listed it when the Session opened.
Elsewhere (`a3017c495`, which takes them without saying so, or an engine
without the doors) `steer()` and `followUp()` reject with
`NikaCompatibilityError` (`capability: 'sessionSteering'`) and nothing is
written. A line a host cannot parse is refused `malformed`, naming the valid
command identity it carries (engine `0e4e1c74f`); natively, a refusal that
names none is still taken as the oldest unanswered line's, in the order the
lines were written, and the Session goes on.

## Events

`events({ after })` yields the Session's events (`opened`, `accepted`,
`activity`, `result`, `closed`) as the engine wrote them (with the doors, an
`activity` of a conversation's run names the tool step it observed in `tool`:
`call`, `name`, `started`/`finished`/`failed` and `elapsed_ms` once it
answered, never its arguments or reply), each with a `cursor`
(`<session>:<event>`) to resume from. Without `after`, a view starts with every
event the door still holds: the server's whole log, or the events a local
handle retains (`eventBufferSize`). Over HTTP a cursor the server cannot resume
yields one `resync` frame with the current snapshot (its cursor is the point it
resynchronized to), then live events; nothing is replayed as a new effect. A
local handle refuses, when iteration starts, a cursor whose events it no
longer retains. Ending a view (its `signal`) never stops or closes the
Session.

## Refusals

`NikaSessionRefusedError` carries the host's word in `code` (`busy`,
`stale_snapshot`, `unknown_snapshot`, `command_conflict`, `malformed`,
`session_not_found`, `session_live`, `session_unavailable`; the vocabulary
stays open), the refused `line`, the current `snapshot` when the host sent one,
and for `session_live` the live `session`. Over HTTP, `401`, `413` and `415`
keep Serve's own error envelope (`NikaOperationError`).

## Runs a Session requests

A Save is never a Run: `run it` (or the person's own words) requests one, and
the outcomes say what the engine did: `run_requested`, then the Session's own
observation of the Run's end (`facts`, or `gate` when it paused),
`run_not_started` when nothing ran, or `run_unobserved` when the Run was
admitted but its end was not observed (its effects are unknown; it is never
reported as an observed Run). A resident runs it as one of its jobs and may
hold its cost review first (`run_review`: answer it with a line against that
snapshot). The Run's own progress arrives as `activity` events. Natively from
engine `ad70c9aa7`, and over HTTP from `0e4e1c74f`, the Session's `stop()`
stops the Run it executes: the receipt is `run_stopping` (or `stop_requested`
when the Run had not started its work: it then starts none), and the turn
settles with `run_stopped` (the Run stopped at a wave boundary and sealed its
trace as cancelled; `work.run.end` reads `interrupted` and `work.run.sealed`
is `true`) or `run_aborted` (it ended without sealing its trace: cut
mid-flight, the effects in flight unknown). A Stop taken before a held cost
review declines it (`run_not_started`). A resident asks its own job
cancellation once (the one `POST /v1/jobs/{id}/cancel` takes), so the job
itself ends `cancelled`; an earlier resident cannot stop the Run from the
Session, answers `run_underway`, and stopping it is that job's cancel.

## Status

The handle follows contract `nika/session-host@1` as the engine's
`nika-session-host` writes it (commits `e079f3e79`, `18479cf38`, `e849d08ea`,
then `cc08ea08f` with `run_unobserved`; not yet released). Besides tests
against a synthetic host, the handle is driven over frames that host recorded
from its real native and HTTP doors at `e849d08ea`, again on the merged
`eb89e1893`, whose Work carries the current members, with a resident's Run
cost review, at `312c3d5a8`, whose selection names its scope, with one Run
of a real resident through its HTTP Session door, and at `46817419a`, whose
Work names the question that waits (`test/fixtures/session-host/`): it sends
the recorded commands and decodes every recorded frame unchanged, and at
`ad70c9aa7` over one deterministic native walk whose every snapshot states its
`knowledge` and whose Run sealed its journal. At `a3017c495` it decodes the
Session doors a real binary wrote on both doors, each conversation led by a
loopback author (a script on 127.0.0.1, not a model, no provider): the
receipts but `not_reading`, the busy queue, the lines entered or returned, a
stopped turn, tool steps and the facts of offered models. At `0e4e1c74f` it
reads the doors' word as both doors print it, the refusals of lines a host
cannot parse, and a Stop that reaches the Run on both doors. The 0.123 integration engine registers
`nika session --json` (`3688552f3`); the served `/v1/sessions` routes arrive
with `nika serve --sessions`, and the pinned `openapi.json` declares them as
such a resident of engine main `0e4e1c74f` serves them (the work snapshot an
object whose `knowledge` member alone is described there).
`scripts/run-session-parity-e2e.mjs` qualifies
both doors of one binary once it hosts them (see `docs/testing.md`).
