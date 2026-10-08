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
Run.

## Commands, waits and Stop

`submit` and `stop` are commands. Each carries an identity (`command`,
generated unless you pass one). The engine keeps one ledger per Session:

- the same identity with the same bytes returns the recorded result again with
  `replayed: true`; the turn never runs twice;
- the same identity with other bytes is refused (`command_conflict`).

A `signal` stops your wait only. The engine keeps an accepted turn running;
the wait fails with `NikaSessionWaitError` naming the command, and sending the
same command again reads its result. `stop()` asks the turn under way to stop:
its result is a receipt (`stop_requested`, `nothing_to_stop`, `run_underway`),
and the stopped turn's own result settles it, ending with a `cancelled`
outcome whose `withdrawn` lists the proposal or question it withdrew.
`close()` ends the Session (natively, its process); it carries no identity and
over HTTP is the route's `DELETE`. A second line while a turn runs is refused
(`busy`) and returned to you. A local handle binds each identity to the bytes
it first sent, as the engine's ledger does, so the same identity with other
bytes is refused there before anything is written, even after its wait was
cancelled.

Reads (`snapshot()`, `details()`) and `stop()` never wait for the turn.

## Events

`events({ after })` yields the Session's events (`opened`, `accepted`,
`activity`, `result`, `closed`) as the engine wrote them, each with a `cursor`
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

## Status

The handle follows contract `nika/session-host@1` as the engine's
`nika-session-host` writes it (commits `e079f3e79`, `18479cf38`, `e849d08ea`;
not yet integrated or released). Besides tests against a synthetic host, the
handle is driven over frames that host recorded from its real native and HTTP
doors at `e849d08ea` (`test/fixtures/session-host/`): it sends the recorded
commands and decodes every recorded frame unchanged. Those doors ran
in-process; `nika session --json` and the served `/v1/sessions` routes are not
registered in a released binary yet.
