# AGENTS.md — nika-client (TypeScript SDK)

Vendor-neutral agent entry per the AGENTS.md convention (agents.md).

## What this repo is

The TypeScript client SDK for Nika — the open workflow language for AI.
Its one public `Nika` facade drives the released local engine
(`supernovae-st/nika`, AGPL) or live `nika serve` HTTP (`--bind` +
`--workflows` + `--token-file`). The language spec is `supernovae-st/nika-spec`
(Apache-2.0).

## Editing rules

1. The remote wire types mirror live `nika serve` OpenAPI (`openapi.json`) —
   never invent fields; check the owning contract and engine source when in
   doubt. Bare `nika serve` is the resident cadence firer; HTTP is the
   `--bind` door. Cancellation requests are supported; active cancellation
   acknowledges an action, and `run.done` retains the engine's actual result.
   Artifact routes stay absent until the owning engine contract adds them.
2. 4 verbs only: `infer` · `exec` · `invoke` · `agent`.
3. Commit trailer: `Co-Authored-By: Nika 🦋 <nika@supernovae.studio>`.
