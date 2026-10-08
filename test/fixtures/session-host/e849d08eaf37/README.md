# nika/session-host@1 recorded fixture

Engine commit: e849d08eaf37efdcea2b4850fdf115504e731ee3 (branch codex/nika-decisions-20261008;
host crate commits e079f3e79, 18479cf38, e849d08ea on 7d98023f9).

Recorded by the real doors of nika-session-host (the NDJSON driver of `nika session --json` and
the HTTP routes under /v1/sessions, in-process; the CLI registration and the nika serve wiring are
not in this binary yet). SYNTHETIC: the Session is the real SessionRuntime over a temporary project,
but its reasoner is a ScriptedReasoner that is never asked; the intents reach the deterministic
compiler. No provider, no model, no HOME history (temporary conversation).

Re-record: test -p nika-session-host --lib -- --ignored --nocapture record_contract_fixture
(the test prints the directory it wrote).

Files
- native-answers.json: each command's own answer on the native door, in script order.
- native-log.json: every native stdout line that carries `event` (the log), replays excluded.
- http-answers.json: each command's HTTP response body, same script.
- http-sse-log.json: GET /v1/sessions/{s}/events from the start, until `closed`.
- http-decisions.json: over HTTP, {step, sent, answered}: open, busy, conflict, stop (receipt),
  stopped_settlement (cancelled with the late proposal under withdrawn), stop_replayed, question,
  answer, close.

Script (both doors): open; submit c-1 COPY on the opening snapshot (proposal); submit c-2 "yes" on
the OPENING snapshot (stale_snapshot); submit c-1 again, same bytes (replayed result, same event);
details; submit c-3 "yes" on the current snapshot (saved); stop s-1 (nothing_to_stop); close.
Native and HTTP frames are equal after naming ses_/snp_ values by first appearance and the
temporary project root as <root> (asserted by the_native_and_http_doors_give_the_same_session).
