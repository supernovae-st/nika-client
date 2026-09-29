# `nika run <file> --json` wire captures

Byte-for-byte stdout and stderr of a real engine, replayed by `fake-nika.mjs`
so the native transport is tested against what an engine actually writes. A
replay proves that the SDK decodes these bytes, never that an engine still
emits them: a new engine release needs a new capture.

| File | Engine | Workflow | Exit |
|---|---|---|---|
| `315b3a516-input1708.compact.stdout` · `315b3a516-input1708.stderr` | `nika 0.121.0 (315b3a516)`, binary sha256 `8d2addeb1de80748d1536ba7a383f0182ea9ff45a7454ed2d1bea45663186d84`, a composed development build, not a release | a check-clean workflow with one `required: true` input, run with the input left unset (`NIKA-1708`) | 3 |

Captured on 2026-09-29 on macOS aarch64 with `nika run input-echo.nika
--json`, a cleared environment (no provider key, `NIKA_KEYCHAIN=off`, a
throwaway `HOME`, absent run-key files). The workflow was check-clean and
made no model or network call:

```yaml
nika: input-echo
inputs:
  ticket: { type: string, required: true }
permits:
  tools: ["nika:jq"]
tasks:
  echo:
    invoke:
      tool: "nika:jq"
      args: { expression: ".", input: "${{ inputs.ticket }}" }
outputs:
  ticket: ${{ tasks.echo.output }}
```

The released-engine dialects of older lines (a multi-line check report, a
refusal on stderr alone) have no capture here. The `admit-*` cases in
`fake-nika.mjs` are SYNTHETIC protocol shapes, labelled as such, and are not
engine captures.
