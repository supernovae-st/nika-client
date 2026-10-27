# AGENTS.md — nika-client (TypeScript SDK)

Vendor-neutral agent entry per the AGENTS.md convention (agents.md).

## What this repo is

The TypeScript client SDK for Nika — the open workflow language for AI —
published as `@supernovae-st/nika`. One `Nika` class: without `url` it starts
the bundled engine (or `bin`/`NIKA_BIN`) as a child process; with
`{ url, token }` it talks to a live `nika serve --bind` over HTTP
(`--workflows` + `--token-file`). The engine is `supernovae-st/nika` (AGPL);
the language spec is `supernovae-st/nika-spec` (Apache-2.0). Each package
version bundles the engine with the same number and speaks its machine
protocol (2 for 0.123 and 0.124). 0.124 is the current release line. Work
stays focused on maintenance, security and the media capabilities workflows
need; native video is planned for 0.125. The 0.123.x line is the previous
line.

User documentation: `README.md` (the entry) and `docs/*.md` (shipped in the
npm package); runnable programs in `examples/`; recordings and one labelled
illustration in `media/` (see `media/README.md`; not shipped).

## Editing rules

1. The remote wire types mirror live `nika serve` OpenAPI (`openapi.json`) —
   never invent fields; check the owning contract and engine source when in
   doubt. Bare `nika serve` is the resident cadence firer; HTTP is the
   `--bind` door. Artifacts are the server's: its manifest and verified
   download routes (capability `artifacts`, engine 0.123.2), never a local
   file the SDK lists itself; cancel answers 200 (a settled job) or 202 (the
   request accepted on a running job, engine 0.118).
2. 4 verbs only: `infer` · `exec` · `invoke` · `agent`.
3. Commit trailer: `Co-Authored-By: Nika 🦋 <nika@supernovae.studio>`.
4. Media are rendered, never edited: change a tape or scene under
   `scripts/media/`, run `node scripts/media/render.mjs` then
   `node scripts/media/validate.mjs --typecheck`, and update
   `media/captions.json`. An illustration says so in its caption.
