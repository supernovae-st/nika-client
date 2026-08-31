# Migrating to 0.116

Version 0.116 is an intentional breaking consolidation of the two published
0.115 clients into one `Nika` facade. This is a 0.x minor release, but existing
0.115 imports and method calls do not all remain source-compatible. Migrate in
a branch and run the packed-package gauntlets before upgrading production.

## Removed 0.115 surfaces

- The `@supernovae-st/nika-client/local` export and `LocalNika` class are
  removed. Use `new Nika({ bin, cwd })`; call `check()`, `run()`, `events()`,
  and `traceVerify()` on that instance.
- The root `nika.jobs` and `nika.workflows` namespaces are removed. Use the
  facade methods shown below.
- `Nika.fromEnv()`, `nika.health()`, `Nika.verifyWebhook()`, and the exported
  webhook helper are removed. Construct the client explicitly; health is now
  an internal compatibility preflight. Keep webhook verification in the
  application boundary that owns its signing format.
- Preview artifact, workflow-source/reload, and `runAndCollect` helpers are
  removed instead of continuing as methods that always refuse.
- Node 18 and 20 are no longer supported; the package now requires Node 22 or
  newer.

## Constructor migration

The 0.115 root constructor was HTTP-only. In 0.116, no URL means the native
process transport; supplying `url` and `token` selects HTTP. Remote `check()`
and `run()` also need a local Nika binary (`bin`, `NIKA_BIN`, or the exact
optional host payload package) because
the SDK captures and validates immutable snapshot bytes before admission.

```ts
// 0.115
const oldClient = new Nika({ url, token, timeout: 30_000 });

// 0.116
const nika = new Nika({
  url,
  token,
  bin: process.env.NIKA_BIN,
  requestTimeout: 30_000,
  allowInsecureHttp: url.startsWith('http://127.0.0.1'),
});
```

`timeout`, retries, polling, concurrency, logger, and per-run `signal` options
from the old HTTP client are gone. Request and frame bounds are client
invariants; observe or cancel a returned run through its owned lifecycle.

## Method mapping

| 0.115 | 0.116 |
| --- | --- |
| `local.check(file)` | `nika.check(file)` |
| `local.run(file)` | `await nika.run(file)`, then `nika.events(run)` and `run.done` |
| `local.runToEnd(file)` | `const run = await nika.run(file); await run.done` |
| `local.traceVerify(path)` | No path-based replacement; retain the engine-issued receipt and call `nika.traceVerify(receipt)` |
| `nika.jobs.submit(workflow)` | `nika.run(workflow)` |
| `nika.jobs.status(id)` | retain the owned run; `nika.status(run)` |
| `nika.jobs.stream(id)` | `attachRun(id)`, then `events(run)` |
| `nika.jobs.cancel(id)` | `nika.cancel(run)` |
| `nika.workflows.list()` | `nika.listWorkflows()` |
| `nika.workflows.metadata(name)` | `nika.workflow(name)` |

The new run handle is intentionally only `{ id, done }`. Methods reject a
look-alike object from another client, so persist the job id and reattach after
a process restart instead of rebuilding a handle by hand.

`LocalNika.version()`, `dryRunPlan()`, and `test()` have no One SDK method in
0.116. Keep those CLI-facing probes in deployment/CI (`nika --version`,
`nika run --dry-run --json`, and `nika test`) until a future typed authority is
explicitly admitted. This release does not silently emulate them.

## New resident discovery

```ts
const names = await nika.listWorkflows();
const metadata = await nika.workflow(names[0]);
```

These methods require an HTTP client. A native-process client returns a typed
`NikaCompatibilityError` with capability `workflowCatalog`.

## Durable status

```ts
const run = await nika.run('flow.nika.yaml');
console.log(await nika.status(run));
console.log(await run.done);
```

`status(run)` is an observation, not terminal settlement. Keep `run.done` as
the sole terminal promise. Native-process runs refuse `status()` because a
short-lived process has no independent durable status authority.

## Durable run recovery

```ts
const recovered = await nika.attachRun(saved.jobId, {
  lastEventId: saved.lastEventSequence,
});
for await (const event of nika.events(recovered)) {
  await saveApplicationCheckpoint(recovered.id, event.sequence);
}
console.log(await recovered.done);
```

`attachRun()` is HTTP-only. It proves the job exists, returns a normal owned
run handle, and resumes the stream with `Last-Event-ID`. Save the job id and
event cursor in application durable state before the original process exits.
If more events arrive before the application subscribes than its configured
buffer can retain, `events()` refuses with `NikaEventBufferOverflowError`
instead of silently skipping a replay prefix.

## Contract and release alignment

Version 0.116 targets the engine train whose OpenAPI contract contains check,
jobs, status, events, cancellation, typed trace verification, resident
workflow discovery, and schedule CAS. Do not publish the SDK before the
matching engine release and native payload assets exist.
