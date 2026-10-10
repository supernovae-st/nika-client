# nika/session-host@1 Session doors recorded at engine a3017c495

Engine commit: a3017c495 (supernovae-st/nika main after #1783; `nika 0.123.0-preview.1 (a3017c495)`,
a dev build, binary sha256 `22a22bd0cb962f02fea4d4f5e5729f436d06ead22fb2d1d8a3773ed5650cb358`).

`doors.json`: the frames of four conversations on each door, `native` (`nika session --json`) and
`http` (`nika serve --sessions`, a resident on 127.0.0.1), as this SDK's built package returned
them after checking them. Each conversation ran in a fresh temporary project and HOME, launched
with only `PATH`, `HOME` and `NIKA_KEYCHAIN=off`, its kept choice `vllm/agent-seat`: the engine's
`vllm` route reached a loopback author on 127.0.0.1 (`NIKA_VLLM_BASE_URL`), as the engine's own
`session_agent_machine` test drives the binary. The author is a script, not a model: it answers
each request that offers tools with its next step and holds one request until the walk lets it
go. No provider, no key, no network beyond loopback. Frames verbatim, the temporary project paths
included; the opening frames are left out.

- `steer`: a `steer` before any turn (`nothing_to_steer`, `target: null`); a turn whose author
  first calls `models` without a role (the tool step starts, then fails: `activity`); while the
  author's next request is held, a `steer` (`queued`, `l1`), a `follow_up` (`queued`, `l2`), a
  blank `steer` (`blank`) and the busy snapshot (`busy.queued`, both waiting). Released, that
  request's own tool call is not run (the engine tells the author the person wrote meanwhile, so
  it leaves no tool step), the steering line enters as the cited `u2` and the follow-up as `u3`
  once the run would end (`work.queued`, both `entered`); a `steer` after the turn
  (`nothing_to_steer`).
- `models`: the author asks which model runs the workflow (`ask`: tool steps `started`, then
  `finished` with its time), offering `deepseek/deepseek-v4-pro` (no key here: its route's facts
  with `configured: false` and the catalogue's output price), `vllm/agent-seat` and
  `acme/imaginary-1` (no facts: this machine's inventory offers neither for a run).
- `stop`: a `follow_up` queued while the request is held, then a Stop (`stop_requested`): the
  turn settles `stopped`, `reach: request_dropped`, the line returned unsent.
- `full`: 32 steering lines queued while the request is held (the 32nd `queued` as `l32`), then
  the 33rd, refused `full`.

Not recorded here: the receipt `not_reading`, a Stop that reaches `between_steps` or
`agent_cancelled`, a stopped outcome naming its `candidate`. At this commit neither door
advertises a capability for the doors (no `sessionSteering` in `/health` or the native identity).
