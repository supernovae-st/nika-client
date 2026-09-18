'use strict';

// Compile scenario, run by an ESM consumer and by a CommonJS consumer of the
// PACKED package (scripts/verify-packed-module-surfaces.mjs). Same rule as the
// literal-inputs scenario: each consumer passes its own module system's SDK
// namespace, so `instanceof` judges that build's classes.

const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const TOKEN = 'p'.repeat(32);

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

/** A resident that records every request; it has no authoring door. */
function resident() {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    requests.push({ path: pathname, method: init.method ?? 'GET', body: init.body ?? null });
    if (pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'nika-serve',
        engineVersion: '0.120.0',
        machineProtocolVersion: 1,
        snapshotFormatVersion: 1,
        checkReportVersion: 1,
        eventFormatVersion: 1,
        traceFormatVersion: 2,
        supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected request ${pathname}`);
  };
  return { fetch, requests };
}

module.exports = async function compileScenario(sdk, engines) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'nika-packed-compile-'));
  const report = {};
  try {
    // Native CREATE: ready outcome, answer rides argv exactly once as KEY=JSON.
    const nativeLog = path.join(scratch, 'native.argv');
    process.env.NIKA_FAKE_ARGV_LOG = nativeLog;
    const native = new sdk.Nika({ bin: engines.compile });
    const ready = await native.compile({
      intent: 'classify-and-route',
      answers: { 'const.request': 'Reroute 雪 "quoted" tickets' },
    });
    report.ready = {
      status: ready.status,
      ready: ready.ready,
      exitCode: ready.exitCode,
      written: ready.written,
      cognition: ready.provenance.cognition,
      candidateHasAnswer: typeof ready.candidate === 'string'
        && ready.candidate.includes('const: { request: "Reroute 雪 \\"quoted\\" tickets" }'),
      argv: argvLog(nativeLog),
    };

    // Native CREATE without the answer: incomplete is DATA, not a throw.
    const incomplete = await native.compile('classify-and-route');
    report.incomplete = {
      status: incomplete.status,
      ready: incomplete.ready,
      exitCode: incomplete.exitCode,
      questionKey: incomplete.questions[0]?.key,
      mandatory: incomplete.questions[0]?.mandatory,
    };

    // Native EDIT: base bytes arrive exact; the scratch dir is gone after.
    const editLog = path.join(scratch, 'edit.argv');
    process.env.NIKA_FAKE_ARGV_LOG = editLog;
    const base = 'nika: packed\nconst: { request: "é" }\n';
    const edited = await native.compile({ workflow: base, change: 'Set const.request to "b"' });
    const editArgv = argvLog(editLog).find((entry) => entry[0] === 'compile') ?? [];
    const basePath = editArgv[editArgv.indexOf('--base') + 1];
    report.edit = {
      status: edited.status,
      candidateKeepsBase: typeof edited.candidate === 'string'
        && edited.candidate.startsWith(base),
      scratchRemoved: !existsSync(path.dirname(basePath)),
      argv: editArgv,
    };

    // Native: an engine from before the capability is refused pre-spawn.
    const oldLog = path.join(scratch, 'old.argv');
    process.env.NIKA_FAKE_ARGV_LOG = oldLog;
    report.oldEngine = await refusal(sdk, () => new sdk.Nika({ bin: engines.old })
      .compile('classify-and-route'));
    report.oldEngine.argv = argvLog(oldLog);

    // The caller's mistakes need no engine at all.
    const silentLog = path.join(scratch, 'silent.argv');
    process.env.NIKA_FAKE_ARGV_LOG = silentLog;
    report.mixed = await refusal(sdk, () => native.compile({ intent: 'x', workflow: 'w', change: 'c' }));
    report.badAnswer = await refusal(sdk, () => native.compile({
      intent: 'x',
      answers: { 'a=b': 1 },
    }));
    report.silentArgv = argvLog(silentLog);

    // HTTP: typed refusal after /health alone; nothing posted, nothing local.
    const remote = resident();
    const remoteLog = path.join(scratch, 'remote.argv');
    process.env.NIKA_FAKE_ARGV_LOG = remoteLog;
    report.http = await refusal(sdk, () => new sdk.Nika({
      url: 'https://nika.example',
      token: TOKEN,
      bin: engines.compile,
      fetch: remote.fetch,
    }).compile('classify-and-route'));
    report.http.requests = remote.requests;
    report.http.argv = argvLog(remoteLog);
    return report;
  } finally {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    rmSync(scratch, { recursive: true, force: true });
  }
};
