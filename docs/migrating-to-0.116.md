# Migrating to 0.116

The One SDK surface is additive relative to the published 0.115 package. The
existing constructor and lifecycle methods remain valid.

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

## Contract and release alignment

Version 0.116 targets the engine train whose OpenAPI contract contains check,
jobs, status, events, cancellation, typed trace verification, resident
workflow discovery, and schedule CAS. Do not publish the SDK before the
matching engine release and native payload assets exist.
