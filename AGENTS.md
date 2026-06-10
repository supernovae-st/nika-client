# AGENTS.md — nika-client (TypeScript SDK)

Vendor-neutral agent entry per the AGENTS.md convention (agents.md).

## What this repo is

The TypeScript client SDK for Nika — the open workflow language for AI.
Talks to a running engine (`supernovae-st/nika`, AGPL) over its serve
surface. The language spec is `supernovae-st/nika-spec` (Apache-2.0).

## Editing rules

1. The wire types mirror the engine's serve surface — never invent
   fields; check the engine source when in doubt.
2. 4 verbs only: `infer` · `exec` · `invoke` · `agent`.
3. Commit trailer: `Co-Authored-By: Nika 🦋 <nika@supernovae.studio>`.
