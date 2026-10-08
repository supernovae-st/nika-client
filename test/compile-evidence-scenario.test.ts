import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { isNikaCompileHeld } from '../src/index.js';

// The provider phase's evidence law (scripts/packed-consumers/compile-evidence.cjs),
// judged on in-memory outcomes: a leg that targets a revision but states none is
// not exercised, and the runner withholds its qualification; a HELD leg whose
// revision only the decision keeps is valid evidence.

const require = createRequire(import.meta.url);
type Row = (sdk: unknown, door: string, outcome: unknown, config: unknown, wallMs: number) => Record<string, any>;
const { evidenceRow, creationRow } = require('../scripts/packed-consumers/compile-evidence.cjs') as {
  evidenceRow: Row;
  creationRow: Row;
};
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const BASE = 'nika: base\nconst: {window_hours: 48}\n';
const CANDIDATE = 'nika: base\nconst: {window_hours: 72}\n';
const config = { base: BASE, keptLines: ['nika: base'] };
const sdk = { isNikaCompileHeld };

function outcome(status: string, provenance: Record<string, unknown>, held = false) {
  return {
    compile_version: 2, status, ready: status === 'ready', candidate: CANDIDATE, questions: [],
    diagnostics: held ? [{ kind: 'applied', target: 'verify_held', message: 'held' }] : [],
    requested_boundary: null, check_preview: null,
    provenance: {
      compiler_version: '0.122.0', spec_pin: 'x', skeleton: null, cognition: 'explicitProvider',
      authoring: { model: 'm/n', calls: 1, input_tokens: 1, output_tokens: 1, elapsed_ms: 1, sampling: {}, context: [],
        backend: null },
      ...provenance,
    },
  };
}
const revision = (base = BASE) => ({ route: 'r', mode: 'operations', base_sha256: sha256(base),
  candidate_sha256: sha256(CANDIDATE), changed: ['const.window_hours'], preservation: 'p', components: [] });

describe('provider evidence law', () => {
  it('holds back a ready leg whose plan states no revision', () => {
    expect(() => evidenceRow(sdk, 'native', outcome('ready', { plan: {} }), config, 1))
      .toThrow(/a ready revision keeps its plan and states it there/);
  });

  it('marks a leg on which no revision was stated as not exercised', () => {
    const row = evidenceRow(sdk, 'http', outcome('incomplete', { decision: {} }, true), config, 1);
    expect(row.exercised).toBe(false);
    expect(row.revision).toBeNull();
  });

  it('accepts a held leg whose revision only the decision keeps', () => {
    const row = evidenceRow(sdk, 'native', outcome('incomplete', { decision: { document_revision: revision() } }, true),
      config, 1);
    expect(row).toMatchObject({ exercised: true, held: true, plan_kept: false,
      revision_in: { plan: false, decision: true } });
  });

  it('accepts a ready leg whose kept plan and decision state one revision', () => {
    const row = evidenceRow(sdk, 'http', outcome('ready', { plan: { document_revision: revision() },
      decision: { document_revision: revision() } }), config, 1);
    expect(row.exercised).toBe(true);
  });

  it('refuses a revision that binds another base than the one sent', () => {
    expect(() => evidenceRow(sdk, 'native', outcome('incomplete',
      { decision: { document_revision: revision('another base') } }, true), config, 1))
      .toThrow(/binds the exact base sent/);
  });
});

describe('provider creation law', () => {
  const INTENT = 'Create a new workflow named weekly-digest.';
  const created = { createIntent: INTENT };
  const receipt = { component: { id: 'block:stale-filter' }, bindings: [{ path: 'const.threshold_hours', bound: 48 }],
    nodes: {}, candidate_sha256: sha256(CANDIDATE) };
  const settled = (overrides: Record<string, unknown> = {}) => ({ version: 1, candidate_sha256: sha256(CANDIDATE),
    request: INTENT, base_sha256: null, mode: 'composed', components: [receipt], ...overrides });
  const section = { route: 'native: document', mode: 'composed', resolved: INTENT, components: [receipt] };
  const made = { route: 'native: document', mode: 'composed', base_sha256: null, operations: 1, changed: [],
    components: [receipt], candidate_sha256: sha256(CANDIDATE) };

  it('accepts a ready creation whose settled record binds the exact bytes received', () => {
    const row = creationRow(sdk, 'native', outcome('ready', { plan: { document: settled(), document_create: section },
      decision: { document_create: made } }), created, 1);
    expect(row).toMatchObject({ leg: 'create', exercised: true, status: 'ready',
      settled: { version: 1, base_sha256: null, request_is_the_sent_intent: true },
      made: { same_receipts_as_settled: true } });
    expect(row.settled.components[0].bindings).toEqual([{ path: 'const.threshold_hours', hole: null,
      component_literal: null, bound: 48 }]);
  });

  it('holds back a ready creation that settled no record', () => {
    expect(() => creationRow(sdk, 'http', outcome('ready', { plan: { document_create: section } }), created, 1))
      .toThrow(/a ready creation settles plan\.document/);
  });

  it('marks a creation still waiting on a mandatory question as not exercised', () => {
    const row = creationRow(sdk, 'native', outcome('incomplete', { plan: { document_create: section },
      decision: { document_create: made } }), created, 1);
    expect(row).toMatchObject({ exercised: false, settled: null, made: { same_receipts_as_settled: null } });
  });

  it('refuses a settled record that binds other bytes, a program base or an unready round', () => {
    expect(() => creationRow(sdk, 'native', outcome('ready', { plan: { document: settled({
      candidate_sha256: sha256('other bytes') }) } }), created, 1)).toThrow(/binds the exact candidate received/);
    expect(() => creationRow(sdk, 'native', outcome('ready', { plan: { document: settled({
      base_sha256: sha256(BASE) }) } }), created, 1)).toThrow(/a creation revises no program/);
    expect(() => creationRow(sdk, 'http', outcome('incomplete', { plan: { document: settled() } }), created, 1))
      .toThrow(/only a ready creation settles its record/);
  });

  it('refuses a ready door record that names another candidate than the one received', () => {
    expect(() => creationRow(sdk, 'http', outcome('ready', { plan: { document: settled() }, decision: { document_create: {
      ...made, candidate_sha256: sha256('before the answers') } } }), created, 1))
      .toThrow(/names the exact candidate received/);
  });

  it('reports, never corrects, what an unready door record names', () => {
    const row = creationRow(sdk, 'http', outcome('incomplete', { decision: { document_create: {
      ...made, candidate_sha256: null } } }), created, 1);
    expect(row).toMatchObject({ exercised: false, made: { candidate_sha256: null, names_the_candidate_received: false } });
  });
});
