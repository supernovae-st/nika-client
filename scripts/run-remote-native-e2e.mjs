#!/usr/bin/env node
/** Real Serve + public built SDK + controlled provider. No paid calls or workflow Run.
 * Requires Node >=22 and an operator-supplied, SHA-pinned binary with compileNativeV2.
 * The scripted candidate is a transport fixture, never a model-intelligence claim.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Nika, NikaOperationError } from '../dist/index.js';

const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert(['--bin', '--sha256', '--source', '--out'].includes(args[i]) && args[i + 1] && !flags.has(args[i]),
    'Usage: node scripts/run-remote-native-e2e.mjs --bin ABSOLUTE_BINARY --sha256 SHA256 --source SOURCE_COMMIT --out NEW_DIRECTORY');
  flags.set(args[i], args[i + 1]);
}
assert.equal(flags.size, 4, 'All four flags are required; no ambient engine or provider is selected');
const binary = flags.get('--bin');
assert(path.isAbsolute(binary), '--bin must be absolute');
assert(/^[a-f0-9]{64}$/.test(flags.get('--sha256')), 'Expected lowercase SHA256');
assert(/^[a-f0-9]{40}$/.test(flags.get('--source')), 'Expected full source commit from the binary receipt');
const out = path.resolve(flags.get('--out'));
await mkdir(out); // Refuse overwriting an earlier attempt.
const world = path.join(out, 'world');
const bearer = randomBytes(32).toString('hex');
const tokens = new Set([bearer]);
const sha = data => createHash('sha256').update(data).digest('hex');
const digest = async file => sha(await readFile(file));
const receipt = {
  evidenceKind: 'CONTROLLED_PROVIDER_REAL_SERVER_PUBLIC_SDK',
  intelligenceQualification: false, runAttempted: false, passed: false,
  contractSource: 'fc6f324119fd900b7952bd893f39630ed6371d0a',
  binarySourceClaim: flags.get('--source'), expectedBinarySha256: flags.get('--sha256'),
  node: process.version, providerCalls: [], sdkRequests: [], startedAt: new Date().toISOString(),
};
const redact = value => {
  let text = String(value);
  for (const token of tokens) text = text.split(token).join('[REDACTED]');
  return text;
};
const publicOutcome = value => {
  if (value.replayToken) tokens.add(value.replayToken);
  const { replayToken, ...outcome } = value;
  return { ...outcome, replayAvailable: replayToken !== undefined };
};
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
});
const close = async server => {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
};
// The model placeholder deliberately requires a typed human answer on replay.
const candidate = [
  'nika: clever-rewrite', 'model: mock/echo', 'permits:',
  '  tools: ["nika:read", "nika:write"]', '  fs:',
  '    read: ["./a.md"]', '    write: ["./b.md"]', 'tasks:',
  '  read_source:', '    invoke:', '      tool: "nika:read"', '      args: { path: "./a.md" }',
  '  transform:', '    with: { text: "${{ tasks.read_source.output }}" }', '    infer:',
  '      max_tokens: 600', '      prompt: "Rewrite this text in a clever way, inventing nothing: ${{ with.text }}"',
  '  write_result:', '    with: { content: "${{ tasks.transform.output }}" }', '    invoke:',
  '      tool: "nika:write"', '      args: { path: "./b.md", content: "${{ with.content }}" }', '',
].join('\n');
const answer = JSON.stringify({ candidate, questions: [], gaps: [], notes: 'controlled SDK wire fixture' });
let providerFailure;
const provider = createServer(async (req, res) => {
  const call = { method: req.method, route: req.url };
  receipt.providerCalls.push(call);
  try {
    assert.equal(receipt.providerCalls.length, 1, 'No unexpected repair or replay call');
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined, 'The clean local provider needs no credential');
    let bytes = 0; const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length; assert(bytes <= 2 * 1024 * 1024, 'Provider request bound'); chunks.push(chunk);
    }
    const body = Buffer.concat(chunks); const parsed = JSON.parse(body);
    Object.assign(call, { sha256: sha(body), bytes, model: parsed.model, maxTokens: parsed.max_tokens });
    assert.equal(parsed.model, 'sdk-controlled-seat'); assert.equal(parsed.max_tokens, 2048);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'controlled-sdk-replay', object: 'chat.completion',
      model: 'sdk-controlled-seat', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      // These are synthetic fixture values, not metered usage or a bill.
      usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } }));
  } catch (error) {
    providerFailure = error;
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"controlled provider assertion"}');
  }
});
let child, childExit, childError, stderr = '', watchdog;
const portProbe = createServer();
try {
  receipt.binarySha256Before = await digest(binary);
  assert.equal(receipt.binarySha256Before, receipt.expectedBinarySha256, 'Binary identity before starting');
  receipt.sdkEntrySha256 = await digest(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
  receipt.scriptSha256 = await digest(fileURLToPath(import.meta.url));
  receipt.sdkVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  await mkdir(path.join(world, 'home'), { recursive: true });
  await mkdir(path.join(world, 'workflows'));
  await writeFile(path.join(world, 'nika.yaml'), 'nika: sdk-controlled-compile\narm: []\n');
  await writeFile(path.join(world, 'a.md'), 'Synthetic input; no workflow is executed.\n');
  await writeFile(path.join(world, 'token'), bearer, { mode: 0o600 });
  const providerPort = await listen(provider);
  const servePort = await listen(portProbe); await close(portProbe);
  const base = `http://127.0.0.1:${servePort}`;
  const childArgs = ['serve', '--bind', `127.0.0.1:${servePort}`, '--workflows', 'workflows', '--token-file', 'token',
    '--authoring-model', 'vllm/sdk-controlled-seat', '--authoring-repairs', '0',
    '--authoring-max-tokens', '2048', '--authoring-timeout', '5', '--authoring-deadline', '10'];
  child = spawn(binary, childArgs, { cwd: world, stdio: ['ignore', 'ignore', 'pipe'], env: {
    PATH: '/usr/bin:/bin', HOME: path.join(world, 'home'), XDG_CONFIG_HOME: path.join(world, 'home', '.config'),
    NIKA_KEYCHAIN: 'off', NIKA_VLLM_BASE_URL: `127.0.0.1:${providerPort}`,
  } });
  child.on('error', error => { childError = error; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
  childExit = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ spawnError: true })); });
  watchdog = setTimeout(() => child.kill('SIGKILL'), 60000);
  const healthDeadline = Date.now() + 20000;
  while (true) {
    if (childError) throw childError;
    assert(child.exitCode === null && child.signalCode === null, 'Serve exited before health');
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok) { receipt.health = await response.json(); break; }
    } catch { /* bounded startup polling only; no compile retry */ }
    assert(Date.now() < healthDeadline, 'Serve health deadline'); await delay(50);
  }
  assert(receipt.health.supportedCapabilities.includes('compileNativeV2'), 'Pinned binary lacks native contract');
  // Real fetch instrumentation counts SDK requests without keeping headers or tokens.
  const observedFetch = async (url, init) => {
    const route = new URL(url).pathname;
    assert.equal(new URL(url).origin, base, 'SDK stays on this server');
    assert(['/health', '/v1/compile'].includes(route), 'No Run, jobs, approval or other endpoint');
    receipt.sdkRequests.push({ route, method: init?.method ?? 'GET',
      ...(init?.body ? { cognition: JSON.parse(init.body).cognition ?? 'v1', bytes: Buffer.byteLength(init.body) } : {}) });
    return fetch(url, init);
  };
  const nika = new Nika({ url: base, token: bearer, fetch: observedFetch,
    allowInsecureHttp: true, // Explicit isolated loopback transport; never an external endpoint.
    machineBufferBytes: 2 * 1024 * 1024, requestTimeout: 15000 });
  const legacy = await nika.compile('hello');
  assert.equal(legacy.compile_version, 1); assert.equal(receipt.providerCalls.length, 0);
  receipt.legacy = publicOutcome(legacy);
  const request = { intent: 'Read ./a.md and do something clever with it, then write ./b.md' };
  const fresh = await nika.compile(request, { remoteAuthoring: { cognition: 'explicitProvider',
    limits: { repairs: 0, maxTokens: 2048, callTimeoutMs: 5000, deadlineMs: 10000 } }, timeoutMs: 15000 });
  receipt.fresh = publicOutcome(fresh);
  assert.equal(fresh.compile_version, 2); assert.equal(fresh.provenance.authoring.calls, 1);
  assert.equal(fresh.provenance.authoring.model, 'vllm/sdk-controlled-seat');
  assert.equal(fresh.status, 'incomplete'); assert(fresh.questions.some(q => q.key === 'model'));
  assert(fresh.replayToken, 'Server must keep this small native plan');
  assert.equal(receipt.providerCalls.length, 1);
  const replayOptions = { remoteAuthoring: { cognition: 'deterministicOnly', replayToken: fresh.replayToken } };
  const replayed = await nika.compile({ ...request, answers: { model: 'mistral/mistral-small-latest' } }, replayOptions);
  receipt.replay = publicOutcome(replayed);
  assert.equal(replayed.status, 'ready'); assert.equal(replayed.compile_version, 1);
  assert.equal(replayed.provenance.cognition, 'deterministicOnly'); assert(replayed.candidate);
  assert.equal(receipt.providerCalls.length, 1, 'Replay must make zero provider calls');
  await assert.rejects(nika.compile({ intent: request.intent + ' changed' }, replayOptions), error => {
    assert(error instanceof NikaOperationError); assert.equal(error.status, 409);
    assert.equal(error.machineCode, 'compile_replay_input_changed');
    receipt.changedInputRefusal = { status: error.status, machineCode: error.machineCode }; return true;
  });
  assert.equal(receipt.providerCalls.length, 1, 'Rejected replay makes zero provider calls');
  if (providerFailure) throw providerFailure;
  assert.deepEqual(await readdir(path.join(world, 'workflows')), [], 'No candidate materialized');
  const names = await readdir(world);
  assert(!names.includes('b.md') && !names.includes('clever-rewrite.nika'), 'No workflow effect');
  await assert.rejects(readdir(path.join(world, '.nika', 'traces')), { code: 'ENOENT' });
  receipt.passed = true;
} catch (error) {
  receipt.failure = { name: error.name, code: error.code, message: redact(error.message) };
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (child && child.pid) {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    receipt.serverExit = await childExit; clearTimeout(killTimer);
    if (receipt.serverExit.code !== 0) { receipt.passed = false; process.exitCode = 1; }
  }
  await close(provider); await close(portProbe);
  receipt.binarySha256After = await digest(binary).catch(() => null);
  if (receipt.binarySha256After !== receipt.expectedBinarySha256) { receipt.passed = false; process.exitCode = 1; }
  await rm(path.join(world, 'token'), { force: true });
  receipt.finishedAt = new Date().toISOString();
  await writeFile(path.join(out, 'receipt.json'), redact(JSON.stringify(receipt, null, 2)) + '\n');
  await writeFile(path.join(out, 'server-stderr.log'), redact(stderr));
  console.log(JSON.stringify({ passed: receipt.passed, evidenceKind: receipt.evidenceKind,
    providerCalls: receipt.providerCalls.length, receipt: path.join(out, 'receipt.json'), failure: receipt.failure }));
}
