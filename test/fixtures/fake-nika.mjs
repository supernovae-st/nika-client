#!/usr/bin/env node
// The canned engine — argv-switched outputs so the local driver's unit
// suite never needs a real binary. Each scenario mirrors a REAL engine
// voice (captured 2026-07-10 against 0.99.0 + the post-#372 main).
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const file = argv[1] ?? '';

if (has('--version')) {
  console.log('nika 0.99.0');
  process.exit(0);
}

if (argv[0] === 'check') {
  if (file.includes('fatal-old')) {
    // The RELEASED parse-fatal voice: plain text on stdout, exit 2.
    console.log('PARSE ✗  [NIKA-PARSE-005] unknown field `name` in the workflow envelope (strict mode)');
    process.exit(2);
  }
  if (file.includes('fatal-new')) {
    // The post-#372 voice: ONE JSON object, parse_fatal true, exit 2.
    console.log(JSON.stringify({
      report_version: 1, parse_fatal: true, clean: false,
      findings: [{ kind: 'parse', gate: 'PARSE', severity: 'error', code: 'NIKA-PARSE-005', docs_url: 'https://nika.sh/errors/NIKA-PARSE-005', message: 'unknown field' }],
    }));
    process.exit(2);
  }
  if (file.includes('dirty')) {
    console.log(JSON.stringify({
      report_version: 1, clean: false,
      cost: { min_path_total_usd: 0, has_unbounded: false, tasks: [] },
      waves: [[0]], requirements: { models: [] },
      findings: [{ kind: 'unknown_tool', gate: 'TOOLS', severity: 'error', code: 'NIKA-BUILTIN-001', message: '`nika:raed` names no canonical builtin (task `a`) — did you mean `nika:read`?', task: 'a' }],
      permits: { source: 'floor', declared: null, needed: { exec: false }, notes: [] },
    }));
    process.exit(2);
  }
  if (file.includes('future')) {
    // A future engine: report_version 9 — the guard must warn, not throw.
    console.log(JSON.stringify({ report_version: 9, clean: true, findings: [], brand_new_key: { x: 1 } }));
    process.exit(0);
  }
  // clean — cost honesty: one UNPRICED task (usd null, floor beside flag).
  console.log(JSON.stringify({
    report_version: 1, clean: true,
    cost: { min_path_total_usd: 0, has_unbounded: true, tasks: [{ task: 'think', model: 'ollama/qwen3.5:4b', usd: null, unbounded_reason: 'NoPrice' }] },
    waves: [[0], [1]], requirements: { models: [{ model: 'ollama/qwen3.5:4b', tasks: ['think'] }] },
    findings: [],
    permits: { source: 'declared', declared: { exec: false }, needed: { exec: false }, notes: [] },
  }));
  process.exit(0);
}

if (argv[0] === 'run' && has('--dry-run') && has('--json')) {
  if (file.includes('dirty')) {
    // The refusal path answers the CHECK report (report_version key).
    console.log(JSON.stringify({ report_version: 1, clean: false, findings: [{ kind: 'unknown_tool', message: 'x' }] }));
    process.exit(2);
  }
  console.log(JSON.stringify({
    plan_version: 1, workflow: 'demo', dry_run: true, effects_executed: false,
    waves: [['fetch'], ['think']], tasks: [{ id: 'fetch', verb: 'invoke' }, { id: 'think', verb: 'infer' }],
    cost: { min_path_total_usd: 0, has_unbounded: false, tasks: [] },
    permits: { source: 'floor', declared: null, needed: {}, notes: [] },
    requirements: { models: [] },
  }));
  process.exit(0);
}

if (argv[0] === 'run' && has('--json')) {
  // NDJSON event stream + a stderr diagnostic that must NOT become an event.
  process.stderr.write('nika-cli: progress noise\n');
  console.log(JSON.stringify({ kind: 'workflow_started', fields: [{ key: 'workflow', value: 'demo' }] }));
  console.log(JSON.stringify({ kind: 'task_completed', fields: [{ key: 'task', value: 'a' }] }));
  if (file.includes('failing')) {
    console.log(JSON.stringify({ kind: 'workflow_failed', fields: [] }));
    process.exit(1);
  }
  console.log(JSON.stringify({ kind: 'workflow_completed', fields: [] }));
  process.exit(0);
}

if (argv[0] === 'test') {
  process.exit(file.includes('golden-bad') ? 2 : 0);
}

if (argv[0] === 'trace' && argv[1] === 'verify') {
  const target = argv[2] ?? '(latest)';
  if (target.includes('broken')) {
    console.log('BROKEN at line 4 — recorded chain aaaa · computed bbbb');
    process.exit(2);
  }
  console.log('OK — 5 events · chain intact · head ' + 'ab'.repeat(32));
  process.exit(0);
}

console.error('fake-nika: unknown argv ' + JSON.stringify(argv));
process.exit(3);
