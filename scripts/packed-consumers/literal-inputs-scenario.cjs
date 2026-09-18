'use strict';

// One scenario, run by an ESM consumer and by a CommonJS consumer of the PACKED
// package (scripts/verify-packed-module-surfaces.mjs). Each consumer passes the
// SDK namespace its own module system loaded, so every `instanceof` below is
// judged against that build's classes. CommonJS on purpose: both systems can
// load this file, and neither gets a second copy of the SDK through it.

const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const INPUTS = {
  ticket: '@env:SERVER_SECRET',
  expression: '${{ tasks.x.output }}',
  numeral: '42',
  count: 42,
  tags: ['é', '東京'],
  record: { name: '🦋', nothing: null },
};
const TOKEN = 'p'.repeat(32);
const RECEIPT = {
  job_id: 'job-1',
  execution_id: 'execution-1',
  trace_id: 'trace-1',
  snapshot_digest: 'f'.repeat(64),
  origin: { kind: 'manual' },
};

function argvLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function refusal(sdk, action) {
  try {
    await action();
  } catch (error) {
    return {
      name: error.name,
      capability: error.capability,
      transport: error.transport,
      message: error.message,
      compatibility: error instanceof sdk.NikaCompatibilityError,
      configuration: error instanceof sdk.NikaConfigurationError,
      nikaError: error instanceof sdk.NikaError,
    };
  }
  return { admitted: true };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A resident that records every request; `capabilities` is what /health advertises. */
function resident(capabilities) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    requests.push({ path: pathname, method: init.method ?? 'GET', body: init.body ?? null });
    if (pathname === '/health') {
      return json({
        status: 'ok',
        service: 'nika-serve',
        engineVersion: '0.120.0',
        machineProtocolVersion: 1,
        snapshotFormatVersion: 1,
        checkReportVersion: 1,
        eventFormatVersion: 1,
        traceFormatVersion: 2,
        supportedCapabilities: capabilities,
      });
    }
    if (pathname === '/v1/jobs') return json({ id: 'job-1', status: 'queued' }, 202);
    if (pathname === '/v1/jobs/job-1/events') {
      const settled = { sequence: 1, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT };
      return new Response(`id: 1\ndata: ${JSON.stringify(settled)}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected request ${pathname}`);
  };
  return { fetch, requests };
}

module.exports = async function literalInputsScenario(sdk, engines) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nika-packed-inputs-'));
  const report = {};
  try {
    // Native: the map rides stdin of an engine that advertises inputsLiteral.
    const nativeLog = path.join(scratch, 'native.argv');
    process.env.NIKA_FAKE_ARGV_LOG = nativeLog;
    const native = new sdk.Nika({ bin: engines.literal });
    const settled = await (await native.run('echo-packed.nika.yaml', { inputs: INPUTS })).result();
    report.native = {
      status: settled.status,
      succeeded: sdk.isNikaRunSucceeded(settled),
      argv: argvLog(nativeLog),
      stdin: settled.outputs.stdin,
    };

    // Native: an engine from before the channel is refused before any run.
    const oldLog = path.join(scratch, 'old.argv');
    process.env.NIKA_FAKE_ARGV_LOG = oldLog;
    report.oldEngine = await refusal(sdk, () => new sdk.Nika({ bin: engines.old })
      .run('ok.nika.yaml', { inputs: INPUTS }));
    report.oldEngine.argv = argvLog(oldLog);

    // The caller's mistakes need no engine at all.
    const silentLog = path.join(scratch, 'silent.argv');
    process.env.NIKA_FAKE_ARGV_LOG = silentLog;
    report.conflict = await refusal(sdk, () => native.run('echo.nika.yaml', {
      inputs: { a: 1 },
      vars: { a: 1 },
    }));
    report.undefinedValue = await refusal(sdk, () => native.run('echo.nika.yaml', {
      inputs: { a: { b: undefined } },
    }));
    report.bigint = await refusal(sdk, () => native.run('echo.nika.yaml', { inputs: { a: 1n } }));
    report.silentArgv = argvLog(silentLog);

    // HTTP: the same bytes ride JobByName.inputs once jobInputs is advertised.
    const current = resident(['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs']);
    const remote = new sdk.Nika({ url: 'https://nika.example', token: TOKEN, fetch: current.fetch });
    const job = await (await remote.run('triage.nika.yaml', {
      inputs: INPUTS,
      idempotencyKey: 'packed-1',
    })).result();
    report.http = { status: job.status, requests: current.requests };

    // HTTP: a resident from before the envelope is refused after /health alone.
    const old = resident(['check', 'executionSnapshot', 'eventStream', 'cancel']);
    report.oldResident = await refusal(sdk, () => new sdk.Nika({
      url: 'https://nika.example',
      token: TOKEN,
      fetch: old.fetch,
    }).run('triage.nika.yaml', { inputs: INPUTS, idempotencyKey: 'packed-2' }));
    report.oldResident.requests = old.requests;

    // HTTP: a snapshot takes no overlay; nothing is captured or sent.
    const untouched = resident([]);
    report.snapshot = await refusal(sdk, () => new sdk.Nika({
      url: 'https://nika.example',
      token: TOKEN,
      fetch: untouched.fetch,
    }).run('./local.nika.yaml', { inputs: {}, idempotencyKey: 'packed-3' }));
    report.snapshot.requests = untouched.requests;
    return report;
  } finally {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    rmSync(scratch, { recursive: true, force: true });
  }
};

module.exports.INPUTS = INPUTS;
