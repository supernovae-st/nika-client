import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsRoot = process.env.NIKA_GAUNTLET_RESULTS_DIR
  ? path.resolve(process.env.NIKA_GAUNTLET_RESULTS_DIR)
  : path.join(root, 'gauntlet', 'results');
const resultsPath = path.join(resultsRoot, 'hostile.json');
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-hostile-'));
const nikaBin = process.env.NIKA_BIN;
const rows = [];

if (!nikaBin) throw new Error('NIKA_BIN must name the engine binary under test');

execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
const { Nika, NikaError } = await import('../dist/index.js');

async function scenario(name, body) {
  const started = performance.now();
  try {
    const evidence = await body();
    rows.push({ name, result: 'green', duration_ms: Math.round(performance.now() - started), evidence });
    process.stdout.write(`hostile ${rows.length}/14 · ${name} · green\n`);
  } catch (cause) {
    rows.push({
      name,
      result: 'red',
      duration_ms: Math.round(performance.now() - started),
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    });
    process.stdout.write(`hostile ${rows.length}/14 · ${name} · red\n`);
  }
}

function writeWorkflow(name, source) {
  const target = path.join(scratch, name);
  writeFileSync(target, source);
  return target;
}

function bounded(promise, milliseconds, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
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

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not become healthy at ${url}`);
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

const cancellable = writeWorkflow('cancellable.nika.yaml', `
nika: hostile-cancellable
permits:
  exec: ["sleep"]
tasks:
  wait:
    exec:
      command: ["sleep", "10"]
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
  return { runs: 24, succeeded: 24, unique_run_ids: 24 };
});

await scenario('real-cancellation-race', async () => {
  const client = new Nika({ bin: nikaBin, cwd: scratch });
  const run = await client.run(cancellable, { maxCostUsd: 0 });
  let terminalBeforeRequest;
  let terminalAt;
  void run.done.then((result) => {
    terminalBeforeRequest = result;
    terminalAt = performance.now();
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const requestedAt = performance.now();
  const first = client.cancel(run);
  assert.equal(client.cancel(run), first);
  const [cancelled, result] = await bounded(Promise.all([first, run.done]), 4_000, 'cancellation');
  assert.equal(cancelled.accepted, true, JSON.stringify({
    cancelled,
    terminal_before_request: terminalAt !== undefined && terminalAt <= requestedAt,
    terminal: terminalBeforeRequest,
    result,
  }));
  assert.equal(result.status, 'interrupted');
  return { cancel_status: cancelled.status, run_status: result.status, exit_code: result.exitCode };
});

await scenario('remote-durable-cancellation', async () => {
  const remote = path.join(scratch, 'remote-cancel');
  mkdirSync(remote);
  writeFileSync(path.join(remote, 'nika.yaml'), 'nika: hostile-remote\n');
  writeFileSync(path.join(remote, 'slow.nika.yaml'), readFileSync(cancellable, 'utf8'));
  writeFileSync(path.join(remote, 'broken.nika.yaml'), readFileSync(malformed, 'utf8'));
  const token = 'hostile-remote-token-0123456789abcdef0123456789';
  const tokenFile = path.join(remote, 'serve.token');
  writeFileSync(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o600);
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(nikaBin, [
    'serve', '--bind', `127.0.0.1:${port}`, '--workflows', remote,
    '--token-file', tokenFile, '--state-root', path.join(remote, 'state'), '--plain',
  ], { cwd: remote, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { diagnostics += chunk; });
  try {
    await waitForHealth(url);
    const client = new Nika({
      url,
      token,
      allowInsecureHttp: true,
      bin: nikaBin,
      cwd: remote,
    });
    const parseFatal = await client.check('broken.nika.yaml');
    assert.equal(parseFatal.clean, false);
    assert.notEqual(parseFatal.exitCode, 0);
    const run = await client.run('slow.nika.yaml', { idempotencyKey: 'hostile-cancel-1' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const statusBeforeCancellation = await client.status(run);
    const cancellation = await client.cancel(run);
    const result = await bounded(run.done, 5_000, 'remote cancellation');
    assert.equal(cancellation.accepted, true, JSON.stringify({
      cancellation,
      status_before_cancellation: statusBeforeCancellation,
      result,
    }));
    assert.equal(result.status, 'cancelled');
    assert(result.receipt);
    const recovered = await client.attachRun(run.id);
    const events = [];
    for await (const event of client.events(recovered)) events.push(event.kind);
    await bounded(recovered.done, 5_000, 'cancel replay settlement');
    assert(events.includes('execution.cancelled'), `cancel replay kinds: ${JSON.stringify(events)}`);
    const trace = await client.traceVerify(result.receipt);
    assert.equal(trace.verified, false);
    assert.equal(trace.verdict, 'unavailable');
    assert.equal(trace.reason, 'trace_journal_unavailable');
    return {
      cancel_status: cancellation.status,
      run_status: result.status,
      events,
      durable_receipt: true,
      trace_verdict: trace.verdict,
      parse_fatal_clean: parseFatal.clean,
    };
  } finally {
    server.kill('SIGINT');
    await bounded(new Promise((resolve) => server.once('close', resolve)), 5_000, 'server shutdown')
      .catch(() => server.kill('SIGTERM'));
    if (server.exitCode && server.exitCode !== 130) {
      throw new Error(`server exited ${server.exitCode}: ${diagnostics.slice(-500)}`);
    }
  }
});

await scenario('trace-corruption-detection', async () => {
  const client = new Nika({ bin: nikaBin, cwd: scratch });
  const run = await client.run(deterministic, { maxCostUsd: 0 });
  const result = await run.done;
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
  const iterator = client.events(run, { bufferSize: 2 })[Symbol.asyncIterator]();
  const result = await run.done;
  assert.equal(result.status, 'succeeded');
  const error = await iterator.next().then(
    () => undefined,
    (cause) => cause,
  );
  assert.equal(error?.name, 'NikaEventBufferOverflowError');
  return { run_status: result.status, subscriber_error: error.name, subscriber_limit: 2 };
});

await scenario('sequential-soak', async () => {
  const client = new Nika({ bin: nikaBin, cwd: scratch });
  for (let index = 0; index < 40; index += 1) {
    const run = await client.run(deterministic, { maxCostUsd: 0 });
    const result = await run.done;
    assert.equal(result.status, 'succeeded');
  }
  return { runs: 40, succeeded: 40 };
});

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  engine: execFileSync(nikaBin, ['--version'], { encoding: 'utf8' }).trim(),
  scenarios: rows,
  summary: {
    total: rows.length,
    green: rows.filter((row) => row.result === 'green').length,
    red: rows.filter((row) => row.result === 'red').length,
    real_engine_runs: 70,
  },
  result: rows.every((row) => row.result === 'green') ? 'green' : 'red',
};
mkdirSync(resultsRoot, { recursive: true });
writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });

if (report.result !== 'green') {
  for (const row of rows.filter((entry) => entry.result === 'red')) {
    process.stderr.write(`${row.name} · ${row.error}\n`);
  }
  process.stderr.write(`${report.summary.red}/${report.summary.total} hostile scenarios red · ${resultsPath}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${report.summary.green}/${report.summary.total} hostile scenarios green · ${resultsPath}\n`);
}
