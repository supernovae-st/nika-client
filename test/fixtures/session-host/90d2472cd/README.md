# nika/session-host@1 door identities and activity marks recorded at engine 90d2472cd

Engine commit: 90d2472cd (supernovae-st/nika main after #1787; `nika 0.123.0-preview.1 (90d2472cd)`,
a dev build, binary sha256 `33beb7ab3efda75ecf5cada95ee97b7ff74269abbf6d8c387831f6bca8f207e6`).
Every read ran in a fresh temporary project and HOME, with only `PATH`, `HOME` and
`NIKA_KEYCHAIN=off`: no model, no provider key, no network beyond loopback.

`identities.json` records what each door advertised. The resident served one mock-model workflow,
as the SDK's candidate type-drift probe does. The documents are verbatim.

- `90d2472cd.native` is `nika --sdk-identity`.
- `90d2472cd.http` is the `/health` of `nika serve --sessions`.
- `90d2472cd.http_without_sessions` is the `/health` of a resident started without it.

Both doors name the same engine, build and Spec (`34ad76c5376ab6b1fb02e3e4c455ff23f1c1312c`, which
replaces `a88d3c6e…` at this commit) and the same wire clocks. Both doors serving Sessions list
`sessionHost`, `sessionIntelligence` and `sessionSteering`. A resident without Sessions lists none
of the Session words. `test/session-recorded-identities.test.ts` reads it with the other
recordings.

`activity.json`: per door, `native` (`nika session --json`) and `http` (`nika serve --sessions`, a
resident on 127.0.0.1), the `activity` frames that carry a call mark or a tool mark, in the order
this SDK's built package returned them after checking them. They come from the four conversations
recorded at `a3017c495` (see `../a3017c495/README.md`), walked again on this binary the same way:
the kept choice `vllm/agent-seat` reached a loopback author on 127.0.0.1 through the `vllm` route's
`NIKA_VLLM_BASE_URL`, a script, not a model, that reports 1000 input and 100 output tokens for
every request. Frames verbatim; nothing renamed, normalized or added.

- `steer`: four model requests, each `started` then `finished` with its time and tokens; the
  author's `models` and `language` tool steps, each `started` then `failed` with its reply (the
  engine's reason) and that reply's size.
- `models`: one request, then the author's `ask`, `started` then `finished` with its reply's size
  and no reply.
- `stop` and `full`: one request, `started`, then `cancelled` by the Stop, with its time and no
  tokens.

Both doors write the same marks apart from their times. `test/session-call-activity.test.ts`
reads them.
