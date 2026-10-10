# Recorded complete-document creation outcomes

Engine commits (0.123 language lane, over carrier `09234bce8`): `557a10c79` (seats: `plan.document`,
decision restatement), `da4c9aa28` (the creation door), `fcdd44292` (these fixtures). Recorded by
the engine's own test runs and copied here byte for byte; `manifest.json` is the engine owner's,
with each file's sha256, status and candidate digest.

Door: the in-process `nika_compile_cognition::compile_with_cognition_composed` entry with
SCRIPTED seats (author `mock/authoring`), rendered by `nika_compile::outcome_document`, the
generation-1 machine document `nika compile --json` and Serve's `/v1/compile` emit. Not a
launched CLI or HTTP door, and not a model. The catalogue is a scripted release
(`fixture-document-r1`) lending `block:stale-filter-report`; a real binary lends only the blocks
its admitted release holds.

| File | Status | Records |
|---|---|---|
| `ready-composed.outcome.json` | ready | `plan.document` (composed, one receipt), `plan.document_create`, `decision.document_create` |
| `ready-written.outcome.json` | ready | `plan.document` (written, no receipt), both sections |
| `continuation.outcome.json` | incomplete | both sections, no `plan.document`, no candidate; mandatory question `const.webhook_endpoint` |
| `edit-created.outcome.json` | ready | the creation a later change revises (same bytes as `ready-composed`) |
| `edit-revised.outcome.json` | ready | after the record is remembered and reopened, « Raise the age threshold to 72 hours. »: `source_revision` and `document_revision` over the created bytes, the receipt rebound 48 → 72; no `plan.document` |

Intents: `intent-stale-filter.txt` (no trailing newline), `intent-config-values.txt` and
`intent-digest-webhook.txt` (each ends with a newline, which `plan.document.request` keeps).

Volatile, not contract: `provenance.compiler_version`, every `spec_pin`, the card and convention
digests under `identity`, `elapsed_ms`.

These prove the SDK decodes and preserves what the engine wrote. They prove no model capability,
no launched door and no Foundry release beyond the scripted one.
