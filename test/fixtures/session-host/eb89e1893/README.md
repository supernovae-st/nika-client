# nika/session-host@1 recorded fixture

Engine commit: eb89e1893cb5a44f47a12b6043ad87b067117529 (the merged tree; `nika-session-host` is
unchanged from 07eb12445 through eb89e1893 to 4271f09ef, as its owner recorded).

Recorded by the real doors of nika-session-host (the NDJSON driver of `nika session --json` and
the HTTP routes under /v1/sessions, in-process). SYNTHETIC: the Session is the real SessionRuntime
over a temporary project, its reasoner is scripted and never asked, and the intents reach the
deterministic compiler. No provider, no model, no HOME history (temporary conversation).

Re-record: cargo test -p nika-session-host --lib --locked -- --ignored --exact
http::tests::record_contract_fixture --nocapture (the test prints the directory it wrote).

Files: the same scripts as `../e849d08eaf37/README.md` (native-answers.json, native-log.json,
http-answers.json, http-sse-log.json, http-decisions.json), recorded over the current Work members,
and one more:

- http-run-review.json: over HTTP, {step, sent, answered}: open; propose (c-1 COPY); save (c-2
  "yes"); run (c-3 "run it": run_requested then the resident's cost review, run_review); stale_yes
  (c-4 "yes" on the snapshot the run was sent on: stale_snapshot, the line handed back); approve
  (c-5 "yes" on the current snapshot: run_reviewed approve, the job admitted once, its end
  observed); approve_replayed (c-5 again: the same recorded result, the original event); run_again
  (c-6 "run it": a new review); decline (c-7 "no": run_reviewed approve false, nothing admitted);
  close.

Words only, never codes: since this recording `run_not_started` may also say that a Stop accepted
while the turn prepared ended it before its run was admitted, or, on Serve, that the workflow on
disk is not the bytes the Session checked for this run.
