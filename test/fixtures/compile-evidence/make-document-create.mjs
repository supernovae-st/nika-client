// Generator of test/fixtures/compile-evidence/document-create.json:
//   node test/fixtures/compile-evidence/make-document-create.mjs test/fixtures/compile-evidence/document-create.json
// Shapes transcribed from the 0.123 complete-document creation (`nika-compile-cognition`
// `document_create.rs::record` and `::bind`, read over engine carrier 09234bce8 whose readers
// admit `plan.document`), with its owner's stated presence and nullability; VALUES are synthetic.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const out = process.argv[2];

const ROUTE = 'native: document';
const REUSE = 'reuse: a component is expanded (or invoked) when every node its receipt names is re-derived, digest for digest, from the candidate\'s own bytes, and every bound literal holds; a shown reference no receipt names is consulted; lexical overlap never decides';
const WRITTEN = 'none claimed: the author wrote the whole document';
const node = (name) => sha(`{"node":"${name}"}`);
const release = { version: 'foundry-2026.10.08', snapshot_sha256: sha('release manifest'), profile: 'nika-release@2' };
const empty = { law: REUSE, expanded: 0, invoked: 0, revised: 0, absent: 0, consulted: 0, references: [] };

const backend = {
  kind: 'acp_harness', provider: 'claude-code', requested_model: 'claude-code/opus', forwarded_model: 'opus',
  decision_model: 'typesafe/jev', observed: [{ call: 1, model: 'claude-opus', usage_reported: false }],
  observed_models: ['claude-opus'], unreported_models: 1, served_model: null,
  usage_complete: false, numeric_usage_reported: false, cost_basis: 'subscription-backed/unknown',
  authority: {
    max_calls: null, source: 'default: no request bound',
    invocations: { sent: 2, refused: 0 },
    http_requests: { sent: null, refused: null, unknown: 'the harness makes its own requests' },
    configured: {}, decision_seat: 'outside this authority: its own single-attempt client',
  },
  selection: { role: 'author', scope: 'round', future: 'access-owner additive evidence' },
};
const authoring = (calls) => ({
  model: 'claude-code/opus', calls, input_tokens: null, output_tokens: null, elapsed_ms: 61234,
  sampling: { temperature: null, seed: null, effective: 'providerDefaultUnknown' },
  context: [
    { role: 'document', instruction_sha256: sha('document instruction'), message_bytes: 48211,
      result: { usage_reported: false } },
    { role: 'judge_request', instruction_sha256: sha('judge instruction'), message_bytes: 9120,
      result: { usage_reported: false, failure_kind: null } },
  ].slice(0, calls),
  backend,
});
const provenance = (file, plan, decision, calls) => ({
  compiler_version: '0.123.0',
  spec_pin: 'a88d3c6e400d9f79fcbbbc4604a03ab22e2d46f0',
  skeleton: null,
  cognition: 'explicitProvider',
  suggested_file: file,
  strategy: 'native',
  plan,
  decision,
  authoring: authoring(calls),
  future_provenance_member: 'kept',
});
const preview = { scope: 'sourceOnly', report: { report_version: 1, findings: [] } };

// READY, composed: the author's own document, one component expanded into it, then edits.
const intent = 'Create a new workflow named stale-tickets. Read ./in/tickets.json, keep the tickets older than '
  + '48 hours in their input order, and write their count and ids to ./out/report.json, labelled '
  + '« Relevé — semaine ». Use an admitted Foundry component when the catalogue has one.';
const authored = [
  '# Stale tickets (SDK fixture, synthetic): keeps the tickets older than two days',
  'nika: stale-tickets',
  'permits:',
  '  fs:',
  '    read: [./in/tickets.json]',
  '    write: [./out/report.json]',
  '  tools: ["nika:read", "nika:jq", "nika:write"]',
  'tasks: {}',
  '',
].join('\n');
const head = [
  '# Stale tickets (SDK fixture, synthetic): keeps the tickets older than two days',
  '# Libellé conservé tel quel : « Relevé — semaine » ✓ 🦋\t(tab kept)\r',
  'nika: stale-tickets',
  'const:',
  '  threshold_hours: 48',
  '  input_path: ./in/tickets.json',
];
const body = [
  'permits:',
  '  fs:',
  '    read: [./in/tickets.json]',
  '    write: [./out/report.json]',
  '  tools: ["nika:read", "nika:jq", "nika:write"]',
  'tasks:',
  '  read_rows:',
  '    invoke:',
  '      tool: nika:read',
  '      args: {path: "${{ const.input_path }}"}',
  '  stale:',
  '    with: {rows: "${{ tasks.read_rows.output }}"}',
  '    invoke:',
  '      tool: nika:jq',
  '      args: {input: "${{ with.rows }}", expression: "[.[] | select(.age_hours > ${{ const.threshold_hours }})]"}',
];
const tail = [
  '  report:',
  '    with: {stale: "${{ tasks.stale.output }}"}',
  '    invoke:',
  '      tool: nika:write',
  '      args: {path: ./out/report.json, content: "${{ with.stale }}"}',
  'outputs:',
  '  stale: ${{ tasks.stale.output }}',
  '',
];
// The bytes right after the expansion (the receipt's own digest), then the final bytes.
const expanded = [...head, ...body, ''].join('\n');
const candidate = [...head, '  label: "Relevé — semaine"', ...body, ...tail].join('\n');
const expandedSha = sha(expanded);
const candidateSha = sha(candidate);
const receipt = {
  law: 'expanded: an admitted component\'s exact bytes, bound at its holes by literal edits the parser proved, merged into the document; its permits, model and name are not inherited',
  component: {
    id: 'block:stale-filter', release, row_sha256: sha('row block:stale-filter'),
    file: 'blocks/stale-filter.nika', file_sha256: sha('blocks/stale-filter.nika bytes'),
    status: 'QUALIFIED', proof_level: 'CHECKED',
  },
  bindings: [
    { path: 'const.threshold_hours', hole: 'const.threshold_hours', owner: 'human', component_literal: 24, bound: 48 },
    { path: 'const.input_path', hole: 'const.input_path', owner: 'human', component_literal: './in/rows.json',
      bound: './in/tickets.json' },
  ],
  open: [],
  not_inherited: { nika: 'stale-filter', model: null, permits: { fs: { read: ['./in/rows.json'] } } },
  authority: {
    inherited: false,
    component_declares: { effects: ['fs.read'], authority: ['permits.fs', 'permits.tools'], callables: ['nika:read', 'nika:jq'] },
    document_needs: { fs: { read: ['./in/tickets.json'] }, tools: ['nika:read', 'nika:jq'] },
  },
  nodes: {
    const: { threshold_hours: node('const.threshold_hours'), input_path: node('const.input_path') },
    tasks: { read_rows: node('tasks.read_rows'), stale: node('tasks.stale') },
  },
  candidate_sha256: expandedSha,
  check: { ready: true, findings: [], diagnostics: [] },
  future_receipt_member: { additive: true },
};
// What the final bytes hold of the receipt, witnessed on them.
const witness = {
  component: 'block:stale-filter', release, verdict: 'expanded', workflow: null,
  candidate_sha256: candidateSha, receipt_candidate_sha256: expandedSha,
  nodes: { kept: ['const.input_path', 'const.threshold_hours', 'tasks.read_rows', 'tasks.stale'], changed: [], missing: [] },
  bindings_not_held: [],
};
const createReuse = { ...empty, expanded: 1, references: [{ id: 'block:stale-filter', kind: 'block', use: 'expanded', witness }] };
const qualificationReuse = { ...empty, expanded: 1, consulted: 1, references: [
  { id: 'pattern:paginated-read', kind: 'pattern', use: 'consulted' },
  { id: 'block:stale-filter', kind: 'block', use: 'expanded', witness },
] };
const changed = ['component block:stale-filter', 'const.label', 'tasks.report'];
const preservation = 'edits verified byte by byte; each component\'s entries inserted by construction';
const composed = {
  compile_version: 2,
  status: 'ready',
  candidate,
  questions: [],
  diagnostics: [{ kind: 'applied', target: 'document', message: 'The author composed the complete document.' }],
  requested_boundary: { declared: { tools: ['nika:read', 'nika:jq', 'nika:write'] }, needed: { tools: ['nika:read', 'nika:jq', 'nika:write'] } },
  requested_trigger: null,
  check_preview: preview,
  provenance: provenance('stale-tickets.nika', {
    strategy: 'native',
    intent_sha256: sha(intent),
    document_create: { route: ROUTE, mode: 'composed', resolved: intent, base_sha256: sha(authored), operations: 3,
      changed, preservation, components: [receipt] },
    document: { version: 1, candidate_sha256: candidateSha, request: intent, base_sha256: null, mode: 'composed',
      components: [receipt], future_document_member: 'kept' },
  }, {
    document_create: { route: ROUTE, mode: 'composed', base_sha256: sha(authored), operations: 3, changed, preservation,
      components: [receipt], reuse: createReuse, candidate_sha256: candidateSha, future_create_member: 1 },
    knowledge_qualification: { by: 'typesafe/jev', reuse: qualificationReuse, lexical_overlap: { references: [] } },
    native: { accepted: true, rounds: [{ round: 0, phase: 'document', operations: 3, mode: 'composed',
      candidate_sha256: candidateSha, changed, components: ['block:stale-filter'] }] },
    route: [ROUTE],
  }, 2),
};

// READY, written whole, one optional question left (a schedule binding): it still settles.
const writtenIntent = 'Create a new workflow named page-count. Every Monday at 8, count the pages of ./docs/guide.md '
  + 'and return the count as « pages ».';
const writtenCandidate = [
  'nika: page-count',
  'permits:',
  '  fs:',
  '    read: [./docs/guide.md]',
  '  tools: ["nika:read", "nika:jq"]',
  'tasks:',
  '  read_guide:',
  '    invoke:',
  '      tool: nika:read',
  '      args: {path: ./docs/guide.md}',
  '  count:',
  '    with: {guide: "${{ tasks.read_guide.output }}"}',
  '    invoke:',
  '      tool: nika:jq',
  '      args: {input: "${{ with.guide }}", expression: ".pages | length"}',
  'outputs:',
  '  pages: ${{ tasks.count.output }}',
  '',
].join('\n');
const written = {
  compile_version: 2,
  status: 'ready',
  candidate: writtenCandidate,
  questions: [{ key: 'schedule.timezone', label: 'Which timezone keeps Monday 8:00?', type: 'text',
    why: 'A schedule binding outside the program.', mandatory: false }],
  diagnostics: [],
  requested_boundary: { declared: { tools: ['nika:read', 'nika:jq'] }, needed: { tools: ['nika:read', 'nika:jq'] } },
  requested_trigger: { kind: 'schedule', status: 'requested', cadence: 'every Monday at 8' },
  check_preview: preview,
  provenance: provenance('page-count.nika', {
    strategy: 'native',
    intent_sha256: sha(writtenIntent),
    document_create: { route: ROUTE, mode: 'written', resolved: writtenIntent, base_sha256: null, operations: 0,
      changed: [], preservation: WRITTEN, components: [] },
    document: { version: 1, candidate_sha256: sha(writtenCandidate), request: writtenIntent, base_sha256: null,
      mode: 'written', components: [] },
  }, {
    document_create: { route: ROUTE, mode: 'written', base_sha256: null, operations: 0, changed: [],
      preservation: WRITTEN, components: [], reuse: empty, candidate_sha256: sha(writtenCandidate) },
    route: [ROUTE],
  }, 2),
};

// A continuation waiting on a mandatory question: no candidate, the section and the decision
// record, no `document`.
const waitingIntent = 'Create a new workflow named digest-sender that sends the weekly digest « Relevé » as a JSON '
  + 'POST to our team webhook; its address is not known yet.';
const continuation = {
  compile_version: 2,
  status: 'incomplete',
  candidate: null,
  questions: [{ key: 'const.webhook_url', label: 'Which webhook receives the digest?', type: 'text',
    why: 'The request leaves the address open.', mandatory: true }],
  diagnostics: [],
  requested_boundary: null,
  requested_trigger: null,
  check_preview: null,
  provenance: provenance('digest-sender.nika', {
    strategy: 'native',
    intent_sha256: sha(waitingIntent),
    document_create: { route: ROUTE, mode: 'written', resolved: waitingIntent, base_sha256: null, operations: 0,
      changed: [], preservation: WRITTEN, components: [] },
  }, {
    document_create: { route: ROUTE, mode: 'written', base_sha256: null, operations: 0, changed: [],
      preservation: WRITTEN, components: [], reuse: empty, candidate_sha256: null },
    route: [ROUTE],
  }, 1),
};

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({
  note: 'SYNTHETIC values in the shapes of the 0.123 complete-document creation (nika-compile-cognition document_create.rs::record and ::bind, read over engine carrier 09234bce8, presence and nullability as its owner states them). Decoder evidence only: no engine produced these bytes.',
  ready: { intent, authored, expanded, document: composed },
  written: { intent: writtenIntent, document: written },
  continuation: { intent: waitingIntent, document: continuation },
}, null, 2)}\n`);
console.log(out, candidateSha, sha(writtenCandidate));
