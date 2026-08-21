# AGENTS.md — nika-client (TypeScript SDK)

Vendor-neutral agent entry per the AGENTS.md convention (agents.md).

## What this repo is

The TypeScript client SDK for Nika — the open workflow language for AI.
Its local module drives the released engine (`supernovae-st/nika`, AGPL).
Its root module types an intended workflow HTTP service that does not ship in
the reference engine today. The language spec is `supernovae-st/nika-spec`
(Apache-2.0).

## Editing rules

1. The remote wire types mirror the intended workflow service contract —
   never invent fields; check the owning contract and engine source when in
   doubt. `nika serve` is the resident cadence firer, not this HTTP service.
2. 4 verbs only: `infer` · `exec` · `invoke` · `agent`.
3. Commit trailer: `Co-Authored-By: Nika 🦋 <nika@supernovae.studio>`.
