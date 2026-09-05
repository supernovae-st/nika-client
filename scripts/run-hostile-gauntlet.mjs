import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDurableCancellationTerminal } from './verify-release-replay.mjs';
import { CancellationRendezvous } from './one-door/cancellation.mjs';
import { cancellationFixture, compareSameJobResult, settlementFacts } from './one-door/contract.mjs';
import { bounded, cancelHeldRun, collectRunEvents } from './gauntlet-cancellation.mjs';
import { OwnedProcesses, runOwnedProcess } from './one-door/process.mjs';
import { stopResident, waitForHealth } from './one-door/resident.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function observeHostileReplay(client, run, signal,
  { timeoutMs = 5_000, cleanupMs = 2_000, ...limits } = {}) {
  const observer = new AbortController();
  const abort = () => observer.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const observation = collectRunEvents(client, run, observer.signal, limits);
  observation.catch(() => {});
  try {
    const [replayed, events] = await bounded(Promise.all([run.done, observation]), timeoutMs,
      'cancel replay settlement', signal);
    return { replayed, events };
  } finally {
    signal?.removeEventListener('abort', abort);
    observer.abort();
    await bounded(observation.catch(() => {}), cleanupMs, 'replay observer cleanup');
  }
}

async function exerciseScenarios({ scratch, nikaBin, scenario, start, signal }) {
  const { Nika, NikaError } = await import('../dist/index.js');
  let realEngineRuns = 0;
  function writeWorkflow(name, source) {
    const target = path.join(scratch, name);
    writeFileSync(target, source);
    return target;
  }

  function receiptPath(receipt) {
    const locator = receipt.trace_path;
    assert.equal(typeof locator, 'string');
    return path.isAbsolute(locator) ? locator : path.join(scratch, locator);
  }

  async function freeLoopbackPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    await new Promise((resolve) => server.close(resolve));
    return address.port;
  }

  const deterministic = writeWorkflow('deterministic.nika.yaml', `
nika: hostile-deterministic
permits:
  tools: ["nika:hash"]
tasks:
  digest:
    invoke:
      tool: "nika:hash"
      args: { content: "hostile", algo: sha256, encoding: hex }
outputs:
  digest: \${{ tasks.digest.output }}
`);

  const malformed = writeWorkflow('malformed.nika.yaml', `
nika: hostile-malformed
tasks:
  broken: [this is not a task]
`);

  const burstTasks = Array.from({ length: 12 }, (_, index) => `
  digest_${index}:
    invoke:
      tool: "nika:hash"
      args: { content: "${index}", algo: sha256, encoding: hex }`).join('');
  const burst = writeWorkflow('burst.nika.yaml', `
nika: hostile-burst
permits:
  tools: ["nika:hash"]
tasks:${burstTasks}
`);

  const canaryValue = 'NIKA_CANARY_8c8901a4_DO_NOT_LEAK';
  const canary = writeWorkflow('canary.nika.yaml', `
nika: hostile-canary
secrets:
  canary:
    source: env
    key: NIKA_HOSTILE_SECRET_CANARY
permits:
  tools: ["nika:hash"]
tasks:
  digest:
    invoke:
      tool: "nika:hash"
      args: { content: "public", algo: sha256, encoding: hex }
`);

  const fakeBin = path.join(scratch, 'fake-nika.mjs');
  writeFileSync(fakeBin, `#!/usr/bin/env node
const identity = {
  engineVersion: '0.115.0',
  machineProtocolVersion: 1,
  snapshotFormatVersion: 1,
  checkReportVersion: 4,
  eventFormatVersion: 1,
  traceFormatVersion: 1,
  supportedCapabilities: ['check', 'executionSnapshot', 'eventStream'],
};
if (process.argv.includes('--sdk-identity')) {
  process.stdout.write(JSON.stringify(identity));
} else {
  const workflow = process.argv[3] ?? '';
  if (workflow.includes('oversize')) process.stdout.write('x'.repeat(4096));
  else if (workflow.includes('malformed-machine')) process.stdout.write('{"kind":');
  else if (workflow.includes('crash')) process.exitCode = 23;
  else process.stdout.write(JSON.stringify({ report_version: 4, clean: true }));
}
`);
  chmodSync(fakeBin, 0o755);

  await scenario('unsafe-http-refusal', async () => {
    assert.throws(
      () => new Nika({ url: 'http://example.test', token: 'not-a-secret' }),
      /allowInsecureHttp/,
    );
    return { refusal: 'NikaConfigurationError', network_requests: 0 };
  });

  await scenario('missing-engine-refusal', async () => {
    const client = new Nika({ bin: path.join(scratch, 'does-not-exist') });
    const error = await client.check(deterministic).then(
      () => undefined,
      (cause) => cause,
    );
    assert(error instanceof NikaError);
    return { error: error.name, bounded: true };
  });

  await scenario('oversize-machine-line', async () => {
    const workflow = writeWorkflow('oversize.nika.yaml', 'nika: fake');
    const run = await new Nika({ bin: fakeBin, machineBufferBytes: 1024 }).run(workflow);
    const error = await bounded(run.done, 2_000, 'oversize refusal').then(
      () => undefined,
      (cause) => cause,
    );
    assert.equal(error?.name, 'NikaProtocolError');
    return { error: error.name, limit_bytes: 1024 };
  });

  await scenario('malformed-machine-frame', async () => {
    const workflow = writeWorkflow('malformed-machine.nika.yaml', 'nika: fake');
    const run = await new Nika({ bin: fakeBin }).run(workflow);
    const error = await bounded(run.done, 2_000, 'malformed frame refusal').then(
      () => undefined,
      (cause) => cause,
    );
    assert.equal(error?.name, 'NikaProtocolError');
    return { error: error.name };
  });

  await scenario('child-crash-settlement', async () => {
    const workflow = writeWorkflow('crash.nika.yaml', 'nika: fake');
    const run = await new Nika({ bin: fakeBin }).run(workflow);
    const result = await bounded(run.done, 2_000, 'crash settlement');
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 23);
    return { status: result.status, exit_code: result.exitCode };
  });

  await scenario('malformed-workflow-domain-report', async () => {
    const report = await new Nika({ bin: nikaBin, cwd: scratch }).check(malformed);
    assert.equal(report.clean, false);
    assert.notEqual(report.exitCode, 0);
    return { clean: report.clean, exit_code: report.exitCode };
  });

  await scenario('explicit-bin-empty-path', async () => {
    const previous = process.env.PATH;
    process.env.PATH = '';
    try {
      const client = new Nika({ bin: nikaBin, cwd: scratch });
      const report = await client.check(deterministic, { nativeStrict: true });
      const run = await client.run(deterministic, { maxCostUsd: 0 });
      const result = await run.done;
      assert.equal(report.clean, true);
      assert.equal(result.status, 'succeeded');
      realEngineRuns += 1;
      return { check: 'clean', status: result.status };
    } finally {
      process.env.PATH = previous;
    }
  });

  await scenario('parallel-run-load', async () => {
    const client = new Nika({ bin: nikaBin, cwd: scratch });
    const runs = await Promise.all(Array.from({ length: 24 }, () => client.run(deterministic, { maxCostUsd: 0 })));
    const results = await bounded(Promise.all(runs.map((run) => run.done)), 20_000, 'parallel runs');
    assert.equal(results.filter((result) => result.status === 'succeeded').length, 24);
    assert.equal(new Set(results.map((result) => result.id)).size, 24);
    realEngineRuns += results.filter((result) => result.status === 'succeeded').length;
    return { runs: 24, succeeded: 24, unique_run_ids: 24 };
  });

  await scenario('real-cancellation-race', async () => {
    const gate = await CancellationRendezvous.listen();
    try {
      const workflow = writeWorkflow('cancellable.nika.yaml', cancellationFixture(gate.url));
      gate.arm('hostile native cancellation');
      const client = new Nika({ bin: nikaBin, cwd: scratch });
      const run = await client.run(workflow, { maxCostUsd: 0 });
      const { cancellation, result, events, rendezvous } = await cancelHeldRun(client, run, gate);
      realEngineRuns += 1;
      return { cancel_status: cancellation.status, run_status: result.status, exit_code: result.exitCode,
        settlement: settlementFacts(result), same_job_terminal_matched: true,
        terminal: { kind: events.at(-1).kind, status: events.at(-1).status }, cancellation_rendezvous: rendezvous };
    } finally {
      await bounded(gate.close(), 2_000, 'native rendezvous cleanup');
    }
  });

  await scenario('remote-durable-cancellation', async () => {
    const gate = await CancellationRendezvous.listen();
    const remoteAbort = new AbortController();
    const remoteSignal = signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal;
    let server;
    try {
      const remote = path.join(scratch, 'remote-cancel');
      mkdirSync(remote);
      writeFileSync(path.join(remote, 'nika.yaml'), 'nika: hostile-remote\n');
      writeFileSync(path.join(remote, 'slow.nika.yaml'), cancellationFixture(gate.url));
      writeFileSync(path.join(remote, 'broken.nika.yaml'), readFileSync(malformed, 'utf8'));
      const token = 'hostile-remote-token-0123456789abcdef0123456789';
      const tokenFile = path.join(remote, 'serve.token');
      writeFileSync(tokenFile, `${token}\n`);
      chmodSync(tokenFile, 0o600);
      const port = await freeLoopbackPort();
      const url = `http://127.0.0.1:${port}`;
      server = start(nikaBin, [
        'serve', '--bind', `127.0.0.1:${port}`, '--workflows', remote,
        '--token-file', tokenFile, '--state-root', path.join(remote, 'state'), '--plain',
      ], { cwd: remote, env: process.env, timeoutMs: 60_000, maxBuffer: 1024 * 1024 });
      await waitForHealth(url, server, remoteSignal);
      const client = new Nika({
        url,
        token,
        allowInsecureHttp: true,
        bin: nikaBin,
        cwd: remote,
        requestTimeout: 5_000,
        fetch: (input, init) => fetch(input, { ...init,
          signal: AbortSignal.any([remoteSignal, ...(init?.signal ? [init.signal] : [])]) }),
      });
      const parseFatal = await bounded(client.check('broken.nika.yaml', { signal: remoteSignal }), 5_000, 'remote check', remoteSignal);
      assert.equal(parseFatal.clean, false);
      assert.notEqual(parseFatal.exitCode, 0);
      gate.arm('hostile remote cancellation');
      const run = await bounded(client.run('slow.nika.yaml', { idempotencyKey: 'hostile-cancel-1' }),
        5_000, 'remote admission', remoteSignal);
      const { cancellation, result, rendezvous } = await cancelHeldRun(client, run, gate, remoteSignal);
      realEngineRuns += 1;
      assert(result.receipt);
      const recovered = await bounded(client.attachRun(run.id), 5_000, 'remote attach', remoteSignal);
      const { replayed, events } = await observeHostileReplay(client, recovered, remoteSignal);
      compareSameJobResult(replayed, result, 'hostile cancellation reattach');
      compareSameJobResult(result, events.at(-1), 'hostile cancellation durable replay');
      // The durable terminal must retain the engine's actual cancellation,
      // including its cause, task tally, spend and additive settlement fields.
      assert.equal(
        isDurableCancellationTerminal(events.at(-1)),
        true,
        `cancel replay events: ${JSON.stringify(events)}`,
      );
      const trace = await bounded(client.traceVerify(result.receipt, { signal: remoteSignal }),
        5_000, 'remote trace verification', remoteSignal);
      assert.equal(trace.verified, false);
      assert.equal(trace.verdict, 'unavailable');
      assert.equal(trace.reason, 'trace_journal_unavailable');
      return {
        cancel_status: cancellation.status,
        run_status: result.status,
        settlement: settlementFacts(result),
        same_job_terminal_and_replay_matched: true,
        cancellation_rendezvous: rendezvous,
        events: events.map(({ kind, status }) => ({ kind, status })),
        durable_receipt: true,
        trace_verdict: trace.verdict,
        parse_fatal_clean: parseFatal.clean,
      };
    } finally {
      remoteAbort.abort();
      try { await bounded(gate.close(), 2_000, 'remote rendezvous cleanup'); }
      finally { await stopResident(server); }
    }
  });

  await scenario('trace-corruption-detection', async () => {
    const client = new Nika({ bin: nikaBin, cwd: scratch });
    const run = await client.run(deterministic, { maxCostUsd: 0 });
    const result = await run.done;
    realEngineRuns += 1;
    assert(result.receipt);
    const intact = await client.traceVerify(result.receipt);
    assert.equal(intact.verified, true);
    const forged = await client.traceVerify({
      ...result.receipt,
      trace_id: 'forged-trace-id',
      snapshot_digest: '0'.repeat(64),
      chain_head: '0'.repeat(64),
      chain_len: 999_999,
      sealed: false,
    });
    assert.equal(forged.verified, false);
    const source = receiptPath(result.receipt);
    const corrupted = path.join(scratch, 'corrupted-trace.ndjson');
    copyFileSync(source, corrupted);
    appendFileSync(corrupted, '{"tampered":true}\n');
    const broken = await client.traceVerify({ ...result.receipt, trace_path: corrupted });
    assert.equal(broken.verified, false);
    return {
      intact: intact.verified,
      forged_receipt: forged.verified,
      corrupted_trace: broken.verified,
    };
  });

  await scenario('secret-canary-redaction', async () => {
    const previous = process.env.NIKA_HOSTILE_SECRET_CANARY;
    process.env.NIKA_HOSTILE_SECRET_CANARY = canaryValue;
    try {
      const client = new Nika({ bin: nikaBin, cwd: scratch });
      const run = await client.run(canary, { maxCostUsd: 0 });
      const result = await run.done;
      assert.equal(result.status, 'succeeded');
      realEngineRuns += 1;
      assert(!JSON.stringify(result).includes(canaryValue));
      assert(result.receipt);
      const tracePath = receiptPath(result.receipt);
      assert(!readFileSync(tracePath, 'utf8').includes(canaryValue));
      return { result_redacted: true, trace_redacted: true };
    } finally {
      if (previous === undefined) delete process.env.NIKA_HOSTILE_SECRET_CANARY;
      else process.env.NIKA_HOSTILE_SECRET_CANARY = previous;
    }
  });

  await scenario('slow-subscriber-overflow-isolation', async () => {
    const client = new Nika({ bin: nikaBin, cwd: scratch, eventBufferSize: 4 });
    const run = await client.run(burst, { maxCostUsd: 0 });
    const observer = new AbortController();
    let iterator;
    try {
      iterator = client.events(run, { bufferSize: 2, signal: observer.signal })[Symbol.asyncIterator]();
      const result = await run.done;
      assert.equal(result.status, 'succeeded');
      realEngineRuns += 1;
      const error = await iterator.next().then(
        () => undefined,
        (cause) => cause,
      );
      assert.equal(error?.name, 'NikaEventBufferOverflowError');
      return { run_status: result.status, subscriber_error: error.name, subscriber_limit: 2 };
    } finally {
      observer.abort();
      await bounded(Promise.resolve(iterator?.return?.()), 2_000, 'slow subscriber cleanup');
    }
  });

  await scenario('sequential-soak', async () => {
    const client = new Nika({ bin: nikaBin, cwd: scratch });
    let succeeded = 0;
    for (let index = 0; index < 40; index += 1) {
      const run = await client.run(deterministic, { maxCostUsd: 0 });
      const result = await run.done;
      assert.equal(result.status, 'succeeded');
      succeeded += 1;
      realEngineRuns += 1;
    }
    return { runs: succeeded, succeeded };
  });

  return realEngineRuns;
}

export async function runHostileGauntlet() {
  const resultsRoot = process.env.NIKA_GAUNTLET_RESULTS_DIR
    ? path.resolve(process.env.NIKA_GAUNTLET_RESULTS_DIR) : path.join(root, 'gauntlet', 'results');
  const resultsPath = path.join(resultsRoot, 'hostile.json');
  mkdirSync(resultsRoot, { recursive: true });
  // An interrupted invocation must not leave a previous green authoritative.
  writeFileSync(resultsPath, `${JSON.stringify({ result: 'incomplete', pid: process.pid })}\n`);
  const nikaBin = process.env.NIKA_BIN;
  assert(nikaBin && path.isAbsolute(nikaBin), 'NIKA_BIN must name an absolute engine binary under test');
  const scratch = mkdtempSync(path.join(tmpdir(), 'nika-hostile-'));
  const owned = new OwnedProcesses();
  const handles = [];
  const abort = new AbortController();
  const start = (...args) => {
    abort.signal.throwIfAborted();
    const handle = owned.start(...args);
    handles.push(handle);
    return handle;
  };
  const stop = (reason) => { abort.abort(new Error(reason)); void owned.close().catch(() => {}); };
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => stop(`hostile runner received ${signal}`)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const deadline = setTimeout(() => stop('hostile runner exceeded 180s'), 180_000);
  const rows = [];
  let realEngineRuns = 0;
  let engine;
  let failure;
  try {
    await runOwnedProcess(start, 'npm', ['run', 'build'], { cwd: root, env: process.env, timeoutMs: 60_000 });
    engine = (await runOwnedProcess(start, nikaBin, ['--version'], { timeoutMs: 5_000 })).trim();
    const directRuns = await exerciseScenarios({ scratch, nikaBin, start, signal: abort.signal,
      scenario: async (name, body) => {
        const started = performance.now();
        try {
          abort.signal.throwIfAborted();
          let evidence;
          if (name === 'remote-durable-cancellation') evidence = await body();
          else {
            const output = await runOwnedProcess(start, process.execPath,
              [fileURLToPath(import.meta.url), '--native-scenario', name, scratch],
              { cwd: root, env: process.env, timeoutMs: name === 'sequential-soak' ? 120_000 : 60_000,
                maxBuffer: 1024 * 1024 });
            const result = JSON.parse(output);
            assert.equal(result.name, name);
            realEngineRuns += result.realEngineRuns;
            if (result.error) throw new Error(result.error);
            evidence = result.evidence;
          }
          rows.push({ name, result: 'green', duration_ms: Math.round(performance.now() - started), evidence });
        } catch (cause) {
          rows.push({ name, result: 'red', duration_ms: Math.round(performance.now() - started),
            error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) });
        }
        process.stdout.write(`hostile ${rows.length}/14 · ${name} · ${rows.at(-1).result}\n`);
      },
    });
    realEngineRuns += directRuns;
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline);
    const errors = [];
    try { await owned.close(); } catch (error) { errors.push(error); }
    for (const handle of handles) {
      if (handle.child.signalCode === 'SIGKILL') errors.push(new Error(`owned process ${handle.child.pid} required SIGKILL`));
    }
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (abort.signal.aborted) errors.push(abort.signal.reason);
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors],
      `hostile proof or cleanup failed: ${errors.map((error) => error.message).join('; ')}`);
    // Retain scratch if cleanup could not establish bounded, unforced exit.
    if (!errors.length) rmSync(scratch, { recursive: true, force: true });
    else process.stderr.write(`hostile cleanup retained scratch: ${scratch}\n`);
  }
  const report = {
    schema_version: 1, generated_at: new Date().toISOString(), engine, scenarios: rows,
    summary: { total: rows.length, green: rows.filter((row) => row.result === 'green').length,
      red: rows.filter((row) => row.result === 'red').length, real_engine_runs: realEngineRuns },
    ...(failure ? { supervision_error: String(failure) } : {}),
    result: !failure && rows.length === 14 && rows.every((row) => row.result === 'green') ? 'green' : 'red',
  };
  writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== 'green') {
    for (const row of rows.filter((entry) => entry.result === 'red')) process.stderr.write(`${row.name} · ${row.error}\n`);
    if (failure) process.stderr.write(`${failure}\n`);
    process.stderr.write(`hostile proof red · ${resultsPath}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${report.summary.green}/${report.summary.total} hostile scenarios green · ${resultsPath}\n`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv[2] === '--native-scenario') {
    const name = process.argv[3];
    assert(name !== 'remote-durable-cancellation', 'resident must stay directly owned by the parent supervisor');
    let evidence;
    let error;
    let matched = false;
    const realEngineRuns = await exerciseScenarios({ scratch: process.argv[4], nikaBin: process.env.NIKA_BIN,
      scenario: async (candidate, body) => {
        if (candidate === name) {
          matched = true;
          try { evidence = await body(); }
          catch (cause) { error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause); }
        }
      },
    });
    assert(matched, `unknown hostile scenario: ${name}`);
    // Even a failed assertion must retain the count of actual engine runs.
    // The parent rejects error before it can record this scenario as green.
    process.stdout.write(`${JSON.stringify({ name, evidence, error, realEngineRuns })}\n`);
  } else await runHostileGauntlet();
}
