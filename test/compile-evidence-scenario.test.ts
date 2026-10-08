import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { isNikaCompileHeld } from '../src/index.js';

// The provider phase's evidence law (scripts/packed-consumers/compile-evidence.cjs),
// judged on in-memory outcomes: a leg that targets a revision but states none is
// not exercised, and the runner withholds its qualification; a HELD leg whose
// revision only the decision keeps is valid evidence.

const require = createRequire(import.meta.url);
const { evidenceRow } = require('../scripts/packed-consumers/compile-evidence.cjs') as {
  evidenceRow: (sdk: unknown, door: string, outcome: unknown, config: unknown, wallMs: number) => Record<string, any>;
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
