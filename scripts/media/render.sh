#!/usr/bin/env bash
# render.sh — render an SDK tape against the real released binary and the
# LOCAL package build. Sibling of the engine's render-tape.sh · same
# honesty contract: every line of output is the SDK's own, nothing global
# is touched. Usage: bash scripts/media/render.sh [tape-name]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="${1:-local-driver}"
TAPE="$ROOT/scripts/media/$NAME.tape"
[ -f "$TAPE" ] || { echo "no tape at $TAPE" >&2; exit 1; }
command -v vhs >/dev/null || { echo "vhs not installed (brew install vhs)" >&2; exit 1; }
command -v nika >/dev/null || { echo "nika not on PATH" >&2; exit 1; }

# The staged demo dir the tape enters: this package installed from the
# local checkout, the workflow, and the complete lifecycle driver script.
rm -rf /tmp/sdk-demo
mkdir -p /tmp/sdk-demo
cat > /tmp/sdk-demo/flow.nika.yaml <<'EOF'
# a two-step launch brief · outline first, then the brief written from it
nika: brief
model: mock/echo
permits: {}
tasks:
  outline:
    infer: { prompt: "Outline a 3-point launch brief", max_tokens: 120 }
  brief:
    with:
      outline: ${{ tasks.outline.output }}
    infer:
      prompt: "Write the brief from · ${{ with.outline }}"
      max_tokens: 200
outputs:
  brief: ${{ tasks.brief.output }}
EOF
cat > /tmp/sdk-demo/demo.mjs <<'EOF'
import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({ cwd: process.cwd() });
const report = await nika.check('flow.nika.yaml');
console.log('clean:', report.clean, '· findings:', report.findings.length);

const run = await nika.run('flow.nika.yaml', { maxCostUsd: 0.25 });
let eventCount = 0;
const watching = (async () => {
  for await (const _event of nika.events(run)) {
    eventCount += 1;
  }
})();
const result = await run.done;
await watching;
console.log('ok:', result.status === 'succeeded', '· events:', eventCount);
EOF
(cd /tmp/sdk-demo && npm init -y >/dev/null 2>&1 && npm install "$ROOT" >/dev/null 2>&1)
nika check /tmp/sdk-demo/flow.nika.yaml >/dev/null || {
  echo "the demo workflow must check clean before it is shown" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK" /tmp/sdk-demo' EXIT
cp "$TAPE" "$WORK/$NAME.tape"
(cd "$WORK" && vhs "$NAME.tape")

mkdir -p "$ROOT/media"
OUT="$ROOT/media/$NAME.gif"
if command -v gifsicle >/dev/null; then
  gifsicle -O3 --lossy=40 "$WORK/$NAME.gif" -o "$OUT"
else
  cp "$WORK/$NAME.gif" "$OUT"
fi
SIZE_MB=$(du -m "$OUT" | cut -f1)
[ "$SIZE_MB" -le 8 ] || { echo "✖ $OUT is ${SIZE_MB}MB (budget 8MB)" >&2; exit 1; }
echo "→ $OUT (${SIZE_MB}MB · budget 8MB)"
