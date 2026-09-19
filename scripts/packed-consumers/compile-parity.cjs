'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { lstatSync, readdirSync, readFileSync, readlinkSync } = require('node:fs');
const path = require('node:path');

module.exports = async function compileParity(sdk, config) {
  const native = new sdk.Nika({ bin: config.bin, cwd: config.project });
  // If compile ever attempts local fallback, this path cannot resolve an engine.
  const http = new sdk.Nika({ url: config.url, token: config.token,
    bin: path.join(config.project, 'there-is-no-local-engine'), allowInsecureHttp: true });
  const source = 'nika: literal-edit\nconst: {payload: 0}\npermits: {tools: ["nika:jq"]}\ntasks:\n  echo:\n    invoke:\n      tool: nika:jq\n      args: {input: "${{ const.payload }}", expression: "."}\n';
  const cases = [
    ['hello', 'hello', 'ready'],
    ['unknown-intent', 'Route support tickets and ask before refunds', 'incomplete'],
    ['pending-question', 'classify-and-route', 'incomplete'],
    ['answered-question', { intent: 'classify-and-route', answers: { 'const.request': 'An outage affects support customers.' } }, 'ready'],
    ['text-edit', { workflow: source, change: 'Set const.payload to 42' }, 'ready'],
    ['invalid-base', { workflow: 'nika: [bad', change: 'Set const.payload to 1' }, 'incomplete'],
    ['expression-island', { workflow: source, change: { set_constant: { name: 'payload', value: '${{ secrets.X }}' } } }, 'refused'],
    ...[null, true, 1.2345678901234567, 1.23e100, '雪 "quoted"\nline', ['é', false, null], { nested: { x: [1, 2] } }]
      .map((value, index) => [`constant-${index}`, { workflow: source, change: { set_constant: { name: 'payload', value } } }, 'ready']),
  ];
  const tree = () => readdirSync(config.project, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const filename = path.join(entry.parentPath, entry.name);
      const stat = lstatSync(filename);
      return { path: path.relative(config.project, filename), mode: stat.mode,
        kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        content: entry.isFile() ? createHash('sha256').update(readFileSync(filename)).digest('hex')
          : entry.isSymbolicLink() ? readlinkSync(filename) : null };
    }).sort((a, b) => a.path.localeCompare(b.path));
  const before = tree();
  const rows = [];
  for (const [name, request, status] of cases) {
    const a = await native.compile(request, { timeoutMs: 15000 });
    const b = await http.compile(request, { timeoutMs: 15000 });
    assert.equal(a.status, status, `${name}: expected foundation status`);
    assert.deepEqual(b, a, `${name}: exact common outcome parity`);
    assert.equal(a.ready, status === 'ready');
    assert(!('written' in a) && !('exitCode' in a));
    assert(a.candidate === null || typeof a.candidate === 'string');
    assert.equal(a.provenance.cognition, 'deterministicOnly');
    rows.push({ name, status, candidate_sha256: a.candidate === null ? null
      : createHash('sha256').update(a.candidate).digest('hex'), questions: a.questions.map((q) => q.key),
    preview_scope: a.check_preview?.scope ?? null });
  }
  assert.deepEqual(tree(), before, 'compile must not create or mutate project files');
  await assert.rejects(new sdk.Nika({ url: config.url, token: 'invalid-compile-token-0123456789',
    allowInsecureHttp: true }).compile('hello'), (error) => error instanceof sdk.NikaOperationError && error.status === 401);
  return { module_system: config.moduleSystem, rows, project_file_effects: 0, unauthorized_status: 401,
    http_local_engine: 'nonexistent', outcome_parity: 'exact' };
};
