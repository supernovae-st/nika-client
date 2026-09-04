// This file is COPIED into a fresh npm consumer before execution. The bare
// import must resolve its public exports; importing a repository dist path
// would conceal broken package metadata and is deliberately not supported.
import { Nika } from '@supernovae-st/nika-client';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compareResult, compareSameJobResult, compareControlledCancellation, identity, verdict } from './contract.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const installed = createRequire(import.meta.url)('@supernovae-st/nika-client/package.json');
assert.equal(installed.version, config.version, 'installed SDK version');
assert.equal(process.env.NIKA_BIN, undefined, 'consumer must not inherit NIKA_BIN');
const remote = new Nika({ url: config.url, token: config.token, allowInsecureHttp: true,
  cwd: config.consumer, bin: config.absentBinary });
const client = config.door === 'sdk-native'
  ? new Nika({ cwd: config.project, ...(config.publicVersion ? {} : { bin: config.binary }) })
  : config.door === 'sdk-snapshot'
    ? new Nika({ url: config.url, token: config.token, allowInsecureHttp: true,
      cwd: config.project, bin: config.binary }) : remote;
let active;
// Do not exit on the supervisor's TERM: let the SDK reap its native child.
// The owning supervisor supplies a bounded KILL fallback for stuck consumers.
process.on('SIGTERM', () => {
  process.exitCode = 1;
  if (active) void client.cancel(active).catch(() => {});
});

async function execute(file, options, cancel = false) {
  const source = config.door === 'sdk-name' ? file : `./${file}`;
  active = await client.run(source, options);
  const run = active;
  const frames = [];
  let acknowledgement;
  let terminalObserved = false;
  let acknowledgementBeforeTerminal;
  const request = cancel ? (async () => {
    const arrived = await fetch(`${config.cancellationControl}/arrived`, { signal: AbortSignal.timeout(10_000) });
    assert(arrived.ok, 'controlled in-flight task reached rendezvous');
    await arrived.text();
    acknowledgement = structuredClone(await client.cancel(run));
    acknowledgementBeforeTerminal = !terminalObserved;
    assert.equal(acknowledgement.accepted, true, 'cancel action accepted');
    assert.equal(acknowledgement.status, 'cancellation_requested', 'pending action acknowledgement');
    assert(acknowledgementBeforeTerminal, 'pending acknowledgement precedes terminal observation');
    const released = await fetch(`${config.cancellationControl}/release`,
      { method: 'POST', signal: AbortSignal.timeout(3000) });
    assert(released.ok, 'release the held task after cancellation request');
    await released.text();
  })() : undefined;
  request?.catch(() => {});
  for await (const frame of client.events(run)) {
    // Keep the original observation even if later SDK processing mutates it.
    frames.push(structuredClone(frame));
    if (frame.kind === 'run_settled' || frame.kind === 'execution.settled'
      || (frame.kind === 'execution.cancelled' && frame.settlement)) terminalObserved = true;
  }
  await request;
  const result = structuredClone(await run.done);
  active = undefined;
  if (cancel) {
    compareControlledCancellation(result);
  }
  assert(result.receipt, 'SDK receipt');
  compareResult(result, config.expected, `${config.door}: ${file}`);
  const terminal = frames.findLast((frame) => frame.kind === 'run_settled' || frame.kind === 'execution.settled'
    || (cancel && frame.kind === 'execution.cancelled' && frame.settlement));
  assert(terminal, 'engine terminal event must be observed independently of action acknowledgement');
  compareResult(terminal, config.expected, `${config.door} terminal event: ${file}`);
  compareSameJobResult(result, terminal, `${config.door} event/result: ${file}`);
  assert.deepEqual(result.outputs, terminal.outputs, 'SDK result preserves its own transport output presence and values');
  let attachedResult;
  if (config.door !== 'sdk-native') {
    const cursor = frames.at(-1)?.sequence;
    assert(Number.isInteger(cursor), 'terminal event cursor');
    const attached = await remote.attachRun(run.id, { lastEventId: cursor });
    attachedResult = structuredClone(await attached.done);
    compareResult(attachedResult, config.expected, `${config.door} terminal attach: ${file}`);
    compareSameJobResult(attachedResult, result, `${config.door} terminal attach: ${file}`);
    assert.deepEqual(attachedResult.outputs, result.outputs, 'terminal attach preserves output presence and values');
  }
  return { scenario: config.name, door: config.door, ...verdict(result), ...identity(result),
    original_result: result, terminal_event: terminal,
    terminal_attach_result: attachedResult,
    acknowledgement, acknowledgement_before_terminal: acknowledgementBeforeTerminal,
    engine_boot: frames.find((frame) => frame.kind === 'boot') ?? null,
    terminal_cursor_attach: config.door !== 'sdk-native' };
}

let report;
if (config.action === 'catalog') {
  const names = await remote.listWorkflows();
  for (const name of config.names) {
    assert(names.includes(`${name}.nika.yaml`));
    assert.equal((await remote.check(`${name}.nika.yaml`)).clean, true, `check by name: ${name}`);
  }
  report = { installed_package: { name: installed.name, version: installed.version }, names };
} else if (config.action === 'replay') {
  active = await remote.run('clean.nika.yaml', { idempotencyKey: 'world-replay' });
  const original = active;
  const result = structuredClone(await original.done);
  compareResult(result, config.expected, 'original before registry mutation');
  writeFileSync(`${config.project}/clean.nika.yaml`, 'not valid workflow yaml\n');
  active = await remote.run('clean.nika.yaml', { idempotencyKey: 'world-replay' });
  assert.equal(active.id, original.id);
  const replayedResult = await active.done;
  compareResult(replayedResult, config.expected, 'replay before recapture');
  compareSameJobResult(replayedResult, result, 'replay before recapture');
  report = { replay_before_capture: true, job_id: original.id, ...identity(result),
    original_result: result, replayed_result: replayedResult, same_job_settlement_compared: true };
  active = undefined;
} else {
  report = await execute(`${config.name}.nika.yaml`, undefined, config.name === 'cancelled');
}
console.log(JSON.stringify(report));
