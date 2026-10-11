# nika/session-host@1 frames recorded at engine 0e4e1c74f

Engine commit: 0e4e1c74f (supernovae-st/nika main after #1784; `nika 0.123.0-preview.1 (0e4e1c74f)`,
a dev build, binary sha256 `43347652af3f33512103e1b8b7189bfc80dccbd2643f350053fb28502f7d3b89`).
Every recording ran in a fresh temporary project and HOME, with only `PATH`, `HOME` and
`NIKA_KEYCHAIN=off`: no model, no provider key, no network beyond loopback. Frames verbatim, the
temporary project paths included.

- `identities.json`: what each door advertised. `0e4e1c74f.native` is `nika --sdk-identity`,
  `0e4e1c74f.http` the `/health` of `nika serve --sessions`, `0e4e1c74f.http_without_sessions`
  the `/health` of a resident started without it. Both doors serving Sessions list
  `sessionSteering`; a resident without Sessions lists none of the Session words.
  `a3017c495.native` and `a3017c495.http` are the same reads of the a3017c495 binary (sha256
  `22a22bd0cb962f02fea4d4f5e5729f436d06ead22fb2d1d8a3773ed5650cb358`), whose doors take
  `steer` and `follow_up` without the word.
- `refusals.json`: lines written to each door by a client that is not this SDK (it sends no op the
  contract does not name), one per step after `open`: an unknown op naming the valid command
  `c-9`, a `steer` without its line naming `c-8`, an unknown op naming an invalid identity, a line
  that is not JSON, then a `steer` with its line (`nothing_to_steer`), natively a read, and the
  close. Each step keeps the line `sent`, the HTTP `status` and the `frame`. The first two are
  refused `malformed` naming `c-9` and `c-8`; the next two name no command; the Session goes on.
- `run-stop.json`: the engine's own `session_run_stop` workflow (task `b` holds on a FIFO), run by
  `run held.nika with a ceiling of 0.01` (command `c-1`) through this SDK's built package; while
  `b` holds, `stop` (`s-1`); the FIFO released; the settlement; the stop again. Per door: the busy
  snapshot (`held`), the stop's receipt, the settlement and the replayed receipt, whole, and the
  Run's own record of its end (`run_record`): natively the trace's last two lines
  (`task_cancelled`, `workflow_cancelled`, cause `operator`), over HTTP the resident's job as
  `GET /v1/jobs/{id}` and `/status` read it (`cancelled`, settlement cause `operator`), the job
  named by the Session's own "run admitted as job" activity. On both doors the Stop answers
  `run_stopping` (phase `stopping`) and the turn settles `run_requested`, `facts`, `run_stopped`,
  `work.run.end` `interrupted` and `sealed: true`; at a3017c495 the HTTP door answered
  `run_underway` and the Run completed.
