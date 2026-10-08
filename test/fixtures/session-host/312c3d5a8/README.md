# nika/session-host@1 recorded fixture

Engine commit: 312c3d5a8 (host `92bc996c8`, the conversation's intelligence choice, with the
resident run recorder on top). Since this recording the Work's `intelligence.selected` names its
`scope` (`operator_default` here: no selection was given at open), and a Session run's `work.run`
carries what the run observed of itself (host `b5d844d84`).

Files recorded as `../eb89e1893/README.md` describes, over the same scripts (native-answers.json,
native-log.json, http-answers.json, http-sse-log.json, http-decisions.json, http-run-review.json):
SYNTHETIC, the Session is the real SessionRuntime over a temporary project, its reasoner scripted
and never asked, the intents reaching the deterministic compiler, the resident of
http-run-review.json scripted (its approved Run still names no identity). No provider, no model,
no HOME history.

And one REAL resident run:

- http-resident-run.json: {workflow, workflow_sha256, opened, ran}. A project holding `root.nika`
  (`workflow`, one `nika:jq` task) served with its Session door seated; the Session opened over
  HTTP (`opened`), then `run root.nika` typed as command c-3 against the opening snapshot (`ran`).
  The resident's own execution backend ran it (its files, its journal, unsealed); the Session
  reasoner was scripted and never asked. `workflow_sha256` is the sha256 of `workflow`, computed
  by the recorder; `ran.snapshot.work.run` names that source hash, the job's execution (a bare
  uuid), the job's trace identity (opaque, never the resident's path) and the receipt head.

Re-record: cargo test -p nika-serve --lib --locked -- --ignored --exact
server::tests::session::record_a_resident_run_fixture --nocapture (the test prints the directory
it wrote); the other files as `../eb89e1893/README.md` says.
