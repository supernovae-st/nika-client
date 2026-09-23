/**
 * Real engine subprocess + CONTROLLED loopback provider, never live model evidence.
 * Build the SDK first. Required flags: --bin PATH --sha256 HEX --source-commit HEX
 * --report PATH. The report records the hash and checks the binary's build identity.
 * No candidate is executed; no ambient credentials/configuration enter the child.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const intent = 'Say hello in French, in one short sentence.';
// Deliberately canned source. Its only purpose is to exercise the real compiler's
// judgment, repair loop and answer replay through the SDK; it proves no intelligence.
const candidate = 'model: mock/echo\nnika: greeting\noutputs:\n  greeting: ${{ tasks.greet.output }}\npermits: {}\ntasks:\n  greet:\n    infer:\n      max_tokens: 128\n      prompt: Say hello in French, in one short sentence.\n';

if (process.argv[2] === '--consumer') {
  const { Nika } = await import('../dist/index.js');
  const [bin, cwd] = process.argv.slice(3);
  const nika = new Nika({ bin, cwd });
  const options = { timeoutMs: 30_000, authoring: { model: 'openai/controlled-authoring',
    strategy: 'only', repairs: 1, maxTokens: 8192, timeoutSeconds: 5,
    knowledge: { pack: './request-pack.json' } } };
  const deterministic = await nika.compile('hello');
  const first = await nika.compile({ intent }, options);
  const answered = await nika.compile({ intent, answers: { model: 'openai/gpt-5-mini' } }, options);
  const revision = answered.candidate === null ? null : await nika.compile({
    workflow: answered.candidate, originalIntent: intent,
    change: 'Say hello in English, in one short sentence.',
  }, options);
  process.stdout.write(JSON.stringify({ deterministic, first, answered, revision }));
} else {
  const { values } = parseArgs({ options: {
    bin: { type: 'string' }, sha256: { type: 'string' }, 'source-commit': { type: 'string' }, report: { type: 'string' },
  } });
  for (const key of ['bin', 'sha256', 'source-commit', 'report']) assert.ok(values[key], `--${key} is required`);
  assert.match(values.sha256, /^[a-f0-9]{64}$/);
  assert.match(values['source-commit'], /^[a-f0-9]{40}$/);
  const bin = path.resolve(values.bin);
  const binarySha256 = createHash('sha256').update(await readFile(bin)).digest('hex');
  assert.equal(binarySha256, values.sha256, 'native binary hash mismatch');
  const env = { PATH: process.env.PATH, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  const identity = JSON.parse(execFileSync(bin, ['--sdk-identity'], { env, encoding: 'utf8', timeout: 10_000 }));
  const buildSha = identity.buildSha ?? identity.build_sha;
  assert.equal(typeof buildSha, 'string');
  assert.ok(buildSha.length >= 7 && values['source-commit'].startsWith(buildSha), 'binary build identity disagrees with supplied source');
  const cwd = await mkdtemp(path.join(tmpdir(), 'nika-native-authoring-proof-'));
  const calls = [];
  let providerFailure;
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        assert.ok(Buffer.byteLength(body) <= 8 * 1024 * 1024, 'provider request exceeded bound');
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const request = JSON.parse(body);
      calls.push({ model: request.model, max_completion_tokens: request.max_completion_tokens,
        max_tokens: request.max_tokens, requestSha256: createHash('sha256').update(body).digest('hex'),
        hasOriginalIntent: body.includes(intent), hasRevision: body.includes('Say hello in English'),
        hasKnowledgeReference: body.includes('Controlled knowledge reference') });
      const source = calls.length === 1 ? 'invalid candidate for the controlled repair round'
        : calls.length === 2 ? candidate : candidate.replaceAll('French', 'English').replace('mock/echo', 'openai/gpt-5-mini');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'controlled-response', object: 'chat.completion', model: 'controlled-reported-model',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
          candidate: source, questions: [], gaps: [], notes: 'Controlled canned provider response; not live generation.',
        }) }, finish_reason: 'stop' }] }));
    } catch (error) { providerFailure = error; res.writeHead(500); res.end(); }
  });
  const report = { evidence: 'controlled-provider-real-engine-subprocess', liveModelGeneration: false,
    releaseQualification: false, node: process.version, binarySha256,
    sourceCommit: values['source-commit'], identity, calls, outcome: 'failed' };
  try {
    await writeFile(path.join(cwd, 'request-pack.json'), JSON.stringify({
      identity: { version: 'controlled-proof-v1', digest: 'controlled-fixture', builder: 'sdk-proof' },
      selection: [{ id: 'controlled-reference', reason: 'explicit test input' }],
      references: [{ kind: 'guide', id: 'controlled-reference', text: 'Controlled knowledge reference: return a short greeting.' }], repairs: {},
    }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--consumer', bin, cwd], {
        env: { ...env, NIKA_OPENAI_BASE_URL: endpoint, NIKA_OPENAI_API_KEY: 'controlled-not-a-secret' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 100_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`consumer exit ${code}/${signal}: ${stderr}`));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
    report.results = output;
    if (providerFailure) throw providerFailure;
    assert.equal(output.deterministic.compile_version, 1);
    assert.equal(output.deterministic.ready, true);
    assert.equal(output.first.compile_version, 2);
    assert.equal(output.first.provenance.strategy, 'native');
    assert.equal(output.first.provenance.authoring.calls, 2);
    assert.equal(output.first.provenance.authoring.input_tokens, null, 'missing provider usage must remain unknown');
    assert.equal(output.first.provenance.authoring.output_tokens, null);
    assert.deepEqual(output.first.questions.map((q) => q.key), ['model']);
    assert.equal(output.answered.ready, true);
    assert.ok(output.answered.candidate.includes('openai/gpt-5-mini'));
    assert.equal(output.answered.provenance.authoring, undefined, 'answer replay must buy no calls');
    assert.equal(output.revision?.ready, true);
    assert.equal(output.revision.provenance.authoring.calls, 1);
    assert.equal(calls.length, 3, 'two initial calls, no answer call, one revision call');
    assert.ok(calls[0].hasKnowledgeReference);
    assert.ok(calls[2].hasOriginalIntent && calls[2].hasRevision, 'revision loses original context');
    report.outcome = 'passed';
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n');
    await rm(cwd, { recursive: true, force: true });
  }
  process.stdout.write(`Controlled-provider native authoring proof: ${report.outcome}\n`);
}
