# Examples

Small programs that use `@supernovae-st/nika` the way an application does.
Each one imports the package by name, runs on Node.js 22.18 or newer as a
`.ts` file as is, and works keyless and offline with `mock/echo` or
`nika:wait`.

| Example | What it shows | Door |
|---|---|---|
| [`quick-start.ts`](quick-start.ts) | The README quick start: run `hello.nika`, read the typed result, verify the receipt | local |
| [`watch-and-cancel.ts`](watch-and-cancel.ts) | `run.events()` as the run happens, `run.cancel()` after a delay or on Ctrl+C, the settled result | local or server |
| [`server-recovery.ts`](server-recovery.ts) | An idempotent job on `nika serve`, a retry that returns the same job, `attachRun()` from a saved cursor in a second process, `traceVerify()` | server |
| [`compile-then-run.ts`](compile-then-run.ts) | `compile()` an intention, answer its questions from a JSON file, run the ready candidate | local or server |

The workflows they run are here too: [`hello.nika`](hello.nika) (one
`mock/echo` task) and [`wait.nika`](wait.nika) (two three-second `nika:wait`
tasks, so there is time to watch and to cancel). [`nika.yaml`](nika.yaml) is
the one-line project file `nika serve` needs.

## Run them from a clone

```sh
npm ci && npm run build          # the examples import the built package by name
cd examples
NIKA_KEYCHAIN=off node ../dist/bin/nika.js key init   # once: a signing key the examples' engine can read
node quick-start.ts
node watch-and-cancel.ts
```

`node ../dist/bin/nika.js` is the package's own `nika` command; in your app it
is `./node_modules/.bin/nika`. Without a signing key the quick start still
runs and prints `not verified: receipt_mismatch` (see
[receipts.md](../docs/receipts.md)).

For the server examples, start a `nika serve` in this folder (terminal A),
then point the examples at it (terminal B):

```sh
# terminal A, in examples/
mkdir -p .nika && (umask 077 && openssl rand -hex 24 > .nika/serve.token)
node ../dist/bin/nika.js serve --bind 127.0.0.1:8787 --workflows . --token-file .nika/serve.token

# terminal B, in examples/
export NIKA_URL=http://127.0.0.1:8787 NIKA_TOKEN="$(cat .nika/serve.token)"
node server-recovery.ts start      # submits wait.nika, retries, stops after the first event
node server-recovery.ts resume     # reattaches from recovery.json, verifies the record
node watch-and-cancel.ts           # the same watch-and-cancel, over HTTP
```

Measured on engine 0.123.0: `start` prints `retry with the same key · same
job: true` and stops at `1 run.started running`; `resume` prints
`2 run.settled succeeded` and, on a server with a signing key,
`trace · verified true · sealed (sealed) · sealed true` (`ok (unsealed)` and
`sealed false` without one). `watch-and-cancel.ts` asks to cancel after one
second: the running task finishes, and the run settles `cancelled` with cause
`operator` before the second task starts.

`compile-then-run.ts` documents its own arguments; run it from the repository
root as its header shows.

## Use them in your app

Copy an example and the workflow it runs into your project, then run it
there: `npm install @supernovae-st/nika` provides the package, and
`./node_modules/.bin/nika` the same commands as `node ../dist/bin/nika.js`
above.
