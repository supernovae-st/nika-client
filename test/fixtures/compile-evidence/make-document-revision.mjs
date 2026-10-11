// Generator of test/fixtures/compile-evidence/document-revision.json:
//   node test/fixtures/compile-evidence/make-document-revision.mjs test/fixtures/compile-evidence/document-revision.json
// Shapes transcribed from engine carrier 7d98023f9 producers; VALUES are synthetic.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const out = process.argv[2];

const base = [
  '# Stock watch: revision base A (SDK fixture, synthetic)',
  '# Unicode kept as written: café · 雪 · ✓ · 🦋',
  'nika: stock-watch',
  'model: deepseek/deepseek-flash',
  'const:',
  '  window_hours: 48 # hours kept\r',
  '  label: "Relevé — semaine"\t',
  '  max_age_hours: 48',
  'permits:',
  '  tools: ["nika:jq"]',
  'tasks:',
  '  totals:',
  '    invoke:',
  '      tool: nika:jq',
  '      args: {input: "${{ const.window_hours }}", expression: "."}',
  'outputs:',
  '  window: ${{ tasks.totals.output }}',
  '',
].join('\n');
const candidate = base
  .replace('window_hours: 48 # hours kept', 'window_hours: 72 # hours kept')
  .replace('max_age_hours: 48', 'max_age_hours: 72')
  .replace('outputs:\n', [
    '  notify_digest:',
    '    invoke:',
    '      workflow: children/notify-digest.nika',
    'outputs:',
    '',
  ].join('\n'));
const originalIntent = 'Watch the stock pages and keep two days of history';
const change = 'evidence-revision';
const intentSha = sha(`${originalIntent}\nChange: keep three days`);
const base64 = sha(base);
const cand64 = sha(candidate);
const node = (name) => sha(`{"node":"${name}"}`);
const release = { version: 'foundry-2026.10.08', snapshot_sha256: sha('release manifest'), profile: 'nika-release@2' };
const earlier = sha('the candidate the block was first expanded on');

const expanded = {
  law: 'expanded: an admitted component\'s exact bytes, bound at its holes by literal edits the parser proved, merged into the document; its permits, model and name are not inherited',
  component: {
    id: 'block:stock-window', release, row_sha256: sha('row block:stock-window'),
    file: 'blocks/stock-window.nika', file_sha256: sha('blocks/stock-window.nika bytes'),
    status: 'QUALIFIED', proof_level: 'CHECKED',
  },
  bindings: [
    { path: 'const.max_age_hours', hole: 'const.max_age_hours', owner: 'human', component_literal: 48, bound: 72 },
    { path: 'const.label', hole: null, owner: null, component_literal: null, bound: 'Relevé — semaine' },
  ],
  open: [],
  not_inherited: { nika: 'stock-window', model: null, permits: { tools: ['nika:jq'] } },
  authority: {
    inherited: false,
    component_declares: { effects: [], authority: ['permits.tools'], callables: ['nika:jq'] },
    document_needs: { tools: ['nika:jq'] },
  },
  nodes: { const: { max_age_hours: node('const.max_age_hours'), window_hours: null }, tasks: { totals: node('tasks.totals') } },
  candidate_sha256: cand64,
  check: { ready: true, findings: [], diagnostics: [] },
  revises: earlier,
  future_receipt_member: { additive: true },
};
const invoked = {
  law: 'invoked: an admitted component\'s exact bytes, bound at its holes, kept behind a child-workflow boundary the document calls; the child carries the person\'s boundary, never the component\'s permits, model or name',
  component: {
    id: 'block:notify-digest', release, row_sha256: sha('row block:notify-digest'),
    file: 'blocks/notify-digest.nika', file_sha256: sha('blocks/notify-digest.nika bytes'),
    status: 'EXPERIMENTAL', proof_level: 'CHECKED',
  },
  bindings: [{ path: 'const.channel', hole: 'const.channel', owner: 'human', component_literal: 'email', bound: 'webhook' }],
  open: [],
  not_inherited: { nika: 'notify-digest', model: null, permits: null },
  authority: {
    inherited: false,
    child_carries: 'the parent\'s own permits; the effective boundary is the parent\'s and the child\'s together',
    child_needs: { tools: ['nika:notify'] },
  },
  invocation: { task: 'notify_digest', workflow: 'children/notify-digest.nika' },
  nodes: { tasks: { notify_digest: node('tasks.notify_digest') } },
  candidate_sha256: cand64,
  check: { ready: true, findings: [], diagnostics: [] },
  child: {
    component: { id: 'block:notify-digest' },
    nodes: { const: { channel: node('child const.channel') }, tasks: { send: node('child tasks.send') } },
    bindings: [{ path: 'const.channel', hole: 'const.channel', owner: 'human', component_literal: 'email', bound: 'webhook' }],
    candidate_sha256: sha('the child program bytes'),
    check: { ready: true, findings: [{ code: 'NIKA-HINT-001', message: 'synthetic hint' }], diagnostics: [] },
  },
};
const documentRevision = {
  route: 'edit: document revision over the complete base',
  mode: 'operations',
  base_sha256: base64,
  candidate_sha256: cand64,
  changed: ['const.window_hours', 'const.max_age_hours', 'component block:notify-digest'],
  preservation: 'edits verified byte by byte; each component\'s entries inserted or rebound by construction',
  components: [expanded, invoked],
  future_lineage: { parents: [base64] },
};
const witnessExpanded = {
  component: 'block:stock-window', release, verdict: 'expanded', workflow: null,
  candidate_sha256: cand64, receipt_candidate_sha256: cand64,
  nodes: { kept: ['const.max_age_hours', 'tasks.totals'], changed: [], missing: [] },
  bindings_not_held: [], future_witness_member: 1,
};
const witnessInvoked = {
  component: 'block:notify-digest', release, verdict: 'invoked', workflow: 'children/notify-digest.nika',
  candidate_sha256: cand64, receipt_candidate_sha256: cand64,
  nodes: { kept: ['tasks.notify_digest'], changed: [], missing: [] }, bindings_not_held: [],
};
const reuse = {
  law: 'reuse: a component is expanded (or invoked) when every node its receipt names is re-derived, digest for digest, from the candidate\'s own bytes, and every bound literal holds; a shown reference no receipt names is consulted; lexical overlap never decides',
  expanded: 1, invoked: 1, revised: 0, absent: 1, consulted: 1,
  references: [
    { id: 'pattern:paginated-read', kind: 'pattern', use: 'consulted' },
    { id: 'block:stock-window', kind: 'block', use: 'expanded', witness: witnessExpanded },
    { id: 'block:notify-digest', kind: 'block', use: 'invoked', witness: witnessInvoked },
    { id: 'block:legacy-copy', kind: 'block', use: 'absent', witness: { component: 'block:legacy-copy', verdict: 'absent' } },
    { id: null, kind: 'block', use: 'unreadable', witness: { component: null, verdict: 'unreadable' } },
  ],
};
const backend = {
  kind: 'direct_api', provider: 'deepseek', requested_model: 'deepseek/deepseek-flash',
  host: 'api.deepseek.com', base_url_overridden: false, endpoint_basis: 'operator_configuration',
  cost_basis: 'unpriced; billing_unverified', usage_complete: false,
  observed_models: ['deepseek-v4-flash'], unreported_models: 1,
  served_model: null, billed_cost_usd: null,
  authority: {
    max_calls: null, source: 'default: no request bound',
    invocations: { sent: 3, refused: 0 }, http_requests: { sent: 4, refused: 0, unknown: null },
    configured: { max_tokens: 65536 }, decision_seat: 'outside this authority: its own single-attempt client',
  },
  decision_model: 'typesafe/jev',
  selection: { role: 'author', scope: 'round', future: 'access-owner additive evidence' },
};
const document = {
  compile_version: 2,
  status: 'ready',
  candidate,
  questions: [],
  diagnostics: [{ kind: 'applied', target: 'change_request', message: 'The change was stated as operations over the complete base.' }],
  requested_boundary: { declared: { tools: ['nika:jq'] }, needed: { tools: ['nika:jq', 'nika:notify'] } },
  requested_trigger: null,
  check_preview: { scope: 'sourceOnly', report: { report_version: 1, findings: [] } },
  provenance: {
    compiler_version: '0.122.0',
    spec_pin: '4b6eaadde483bcc9db9c05b022afbedfb107f37e',
    skeleton: null,
    cognition: 'explicitProvider',
    suggested_file: 'stock-watch.nika',
    strategy: 'native',
    plan: {
      source_revision: { candidate_sha256: cand64, resolved: `${originalIntent}\nChange: keep three days`, base_sha256: base64 },
      intent_sha256: intentSha,
      document_revision: documentRevision,
    },
    decision: {
      document_revision: documentRevision,
      knowledge_qualification: {
        by: null, why: 'a revision: components are composed by operations, none is qualified here',
        reuse, lexical_overlap: { references: [] },
      },
      native: { accepted: true, rounds: [{ round: 0, phase: 'revision', document: { operations: 3, replaced: false } }] },
      route: ['edit: document revision over the complete base'],
    },
    authoring: {
      model: 'deepseek/deepseek-flash', calls: 3, input_tokens: 5120, output_tokens: 731, elapsed_ms: 8421,
      sampling: { temperature: null, seed: null, effective: 'providerDefaultUnknown' },
      context: [
        { role: 'revision', instruction_sha256: sha('revision instruction'), message_bytes: 9123,
          result: { usage_reported: true } },
        { role: 'judge_request', instruction_sha256: sha('judge instruction'), message_bytes: 4410,
          result: { usage_reported: false, failure_kind: null } },
      ],
      backend,
    },
    future_provenance_member: 'kept',
  },
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({
  note: 'SYNTHETIC values in the shapes engine carrier 7d98023f9 writes (nika-compile-seats foundry/document.rs, instance.rs, invoke.rs, witness.rs, foundry.rs::reused; authoring backend of nika-providers/nika-cli-host/nika-serve). Decoder evidence only: no engine produced these bytes.',
  base, original_intent: originalIntent, change, document,
}, null, 2)}\n`);
console.log(out, base64, cand64);
