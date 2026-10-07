'use strict';

// Compile scenario, run by an ESM consumer and by a CommonJS consumer of the
// PACKED package (scripts/verify-packed-module-surfaces.mjs). Same rule as the
// literal-inputs scenario: each consumer passes its own module system's SDK
// namespace, so `instanceof` judges that build's classes.

const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

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
      protocol: error instanceof sdk.NikaProtocolError,
      credentialVisible: inspect(error).includes(TOKEN),
      nikaError: error instanceof sdk.NikaError,
    };
  }
  return { admitted: true };
}

/** A resident that records every request; it has no authoring door. */
function resident(candidate) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    requests.push({ path: pathname, method: init.method ?? 'GET', body: init.body ?? null });
    if (pathname === '/v1/compile' && candidate) {
      if (init.headers.get('Authorization') !== `Bearer ${TOKEN}`) throw new Error('compile lacked bearer');
      return Response.json(candidate);
    }
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
        supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', ...(candidate ? ['compile'] : [])],
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
      processFieldsAbsent: !('exitCode' in ready) && !('written' in ready),
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
      scratchName: path.basename(basePath),
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
    const capable = resident(ready);
    const result = await new sdk.Nika({ url: 'https://nika.example', token: TOKEN,
      bin: engines.compile, fetch: capable.fetch }).compile({ workflow: base,
      change: { set_constant: { name: 'request', value: ['雪', null, true, 1.25] } } });
    report.httpSuccess = { sameOutcome: JSON.stringify(result) === JSON.stringify(ready),
      request: JSON.parse(capable.requests[1].body), argv: argvLog(remoteLog) };

    // Independent review R1/R2: exercise the actual packed module's exported
    // error classes and full error/cause representation on both transport doors.
    report.hostileVersions = [];
    for (const [intent, compile_version] of [
      ['hostile-token-version', TOKEN], ['hostile-object-version', { toString: null }],
    ]) {
      const nativeError = await refusal(sdk, () => native.compile(intent));
      const remote = resident({ ...ready, compile_version });
      const httpError = await refusal(sdk, () => new sdk.Nika({
        url: 'https://nika.example', token: TOKEN, bin: '/missing-packed-review-engine', fetch: remote.fetch,
      }).compile('hello'));
      for (const error of [nativeError, httpError]) {
        assert.equal(error.protocol, true, `malformed ${intent} must be a typed protocol error`);
        assert.equal(error.credentialVisible, false, 'full error representation reflects bearer token');
      }
      assert.deepEqual(remote.requests.map(({ path }) => path), ['/health', '/v1/compile']);
      report.hostileVersions.push({ intent, nativeError, httpError });
    }
    const signalLog = path.join(scratch, 'signal.argv');
    process.env.NIKA_FAKE_ARGV_LOG = signalLog;
    report.signalOverrides = [];
    for (const door of ['native', 'http']) {
      for (const key of ['aborted', 'reason', 'addEventListener', 'removeEventListener']) {
        let calls = 0;
        const controller = new AbortController();
        if (key === 'reason') controller.abort();
        Object.defineProperty(controller.signal, key, { get() { calls++; throw new Error('caller signal getter ran'); } });
        const remote = resident(ready);
        const client = door === 'native' ? native : new sdk.Nika({
          url: 'https://nika.example', token: TOKEN, bin: engines.compile, fetch: remote.fetch,
        });
        const error = await refusal(sdk, () => client.compile('hello', { signal: controller.signal }));
        assert.equal(error.configuration, true, `${door} ${key} must be a configuration refusal`);
        assert.equal(calls, 0, 'caller signal getter executed');
        assert.equal(remote.requests.length, 0, 'signal refusal started HTTP work');
        assert.deepEqual(argvLog(signalLog), [], 'signal refusal spawned an engine');
        report.signalOverrides.push({ door, key, calls, error });
      }
    }

    // Generation 2 over HTTP: a provider round on a seated resident answers
    // its replay token, and the answer round replays it with zero calls.
    const REPLAY = '0123456789abcdef'.repeat(4);
    const receipt = { model: 'mistral/mistral-small-latest', calls: 2, input_tokens: 10, output_tokens: 20,
      elapsed_ms: 30, sampling: { temperature: null, seed: null, effective: 'providerDefaultUnknown' },
      context: [{ role: 'author' }], backend: null };
    const question = { key: 'const.audience', label: 'Who reads it?', type: 'choice', why: 'w', mandatory: true,
      options: [{ key: 'team', label: 'The team' }] };
    const seatedRequests = [];
    const seated = async (url, init = {}) => {
      const { pathname } = new URL(String(url));
      seatedRequests.push({ path: pathname, body: init.body ?? null });
      if (pathname === '/health') {
        return Response.json({ status: 'ok', service: 'nika-serve', engineVersion: '0.122.0',
          machineProtocolVersion: 1, snapshotFormatVersion: 1, checkReportVersion: 1, eventFormatVersion: 1,
          traceFormatVersion: 2, supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'compile', 'compileNativeV2'] });
      }
      const body = JSON.parse(init.body);
      const provenance = { ...ready.provenance, cognition: 'explicitProvider', strategy: 'native' };
      const noStore = { 'Cache-Control': 'no-store' };
      if (body.cognition === 'deterministicOnly') {
        // As the engine's own test pins a replay: the answers bound, no call, no
        // verifier asked, so the candidate stays a preview with its judgment pending.
        return Response.json({ ...ready, status: 'incomplete', requested_trigger: null,
          diagnostics: [{ kind: 'unknown', target: 'semantic_verification', message: 'pending' }],
          provenance: { ...provenance, cognition: 'deterministicOnly', decision: { pending: { open: ['request'] } } } },
        { headers: noStore });
      }
      if (body.answers === undefined) {
        return Response.json({ ...ready, compile_version: 2, status: 'incomplete', candidate: null,
          questions: [question], requested_trigger: null, provenance: { ...provenance, authoring: receipt } },
        { headers: { ...noStore, 'Nika-Compile-Replay': REPLAY } });
      }
      return Response.json({ ...ready, compile_version: 2, requested_trigger: null,
        provenance: { ...provenance, authoring: receipt } }, { headers: noStore });
    };
    const generation2 = new sdk.Nika({ url: 'https://nika.example', token: TOKEN, bin: '/missing-packed-v2-engine', fetch: seated });
    const first = { intent: 'Every morning, summarize ./inbox', cognition: 'explicitProvider', limits: { max_calls: 6 } };
    const round1 = await generation2.compile(first);
    const round2 = await generation2.compile(sdk.nextCompileRequest(first, round1, { 'const.audience': 'team' }));
    const round3 = await generation2.compile({ ...first, answers: { 'const.audience': 'team' } });
    report.generation2 = {
      round1: { version: round1.compile_version, status: round1.status, token: round1.replay_token === REPLAY,
        calls: round1.provenance.authoring.calls, held: sdk.isNikaCompileHeld(round1) },
      round2: { version: round2.compile_version, status: round2.status, token: 'replay_token' in round2 },
      round3: { version: round3.compile_version, ready: round3.ready, calls: round3.provenance.authoring.calls },
      bodies: seatedRequests.filter(({ path }) => path === '/v1/compile').map(({ body }) => JSON.parse(body)),
    };
    report.generation2Unseated = await refusal(sdk, () => new sdk.Nika({
      url: 'https://nika.example', token: TOKEN, bin: '/missing-packed-v2-engine', fetch: resident(ready).fetch,
    }).compile(first));
    return report;
  } finally {
    delete process.env.NIKA_FAKE_ARGV_LOG;
    rmSync(scratch, { recursive: true, force: true });
  }
};
