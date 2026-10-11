# nika/session-host@1 door identities recorded at engine 90d2472cd

Engine commit: 90d2472cd (supernovae-st/nika main after #1787; `nika 0.123.0-preview.1 (90d2472cd)`,
a dev build, binary sha256 `33beb7ab3efda75ecf5cada95ee97b7ff74269abbf6d8c387831f6bca8f207e6`).
Every read ran in a fresh temporary project and HOME, with only `PATH`, `HOME` and
`NIKA_KEYCHAIN=off`: no model, no provider key, no network beyond loopback. The resident served one
mock-model workflow, as the SDK's candidate type-drift probe does. The documents are verbatim.

`identities.json` records what each door advertised:

- `90d2472cd.native` is `nika --sdk-identity`.
- `90d2472cd.http` is the `/health` of `nika serve --sessions`.
- `90d2472cd.http_without_sessions` is the `/health` of a resident started without it.

Both doors name the same engine, build and Spec (`34ad76c5376ab6b1fb02e3e4c455ff23f1c1312c`, which
replaces `a88d3c6e…` at this commit) and the same wire clocks. Both doors serving Sessions list
`sessionHost`, `sessionIntelligence` and `sessionSteering`. A resident without Sessions lists none
of the Session words.

`test/session-recorded-identities.test.ts` reads it with the other recordings.
