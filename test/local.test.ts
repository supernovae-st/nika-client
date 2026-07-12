// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2026 SuperNovae Studio <contact@supernovae.studio>

/** LocalNika against the canned binary — every contract branch, no
 * engine required. The fixture's payloads mirror REAL engine voices
 * (captured 2026-07-10 against 0.99.0 and the post-#372 main). */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LocalNika } from '../src/local/index.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-nika.mjs');
// spawn()ing the .mjs relies on its shebang — fine on every posix CI;
// windows (no shebang exec) skips: the driver itself is platform-plain.
const nika = new LocalNika({ bin: FAKE });
const posix = process.platform !== 'win32';

describe.skipIf(!posix)('LocalNika · canned engine', () => {
  it('version() probes the binary', async () => {
    expect(await nika.version()).toBe('nika 0.99.0');
  });

  it('check clean: cost honesty typed in — usd null stays null beside the flag', async () => {
    const r = await nika.check('ok.nika.yaml');
    expect(r.clean).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.reportVersion).toBe(1);
    expect(r.parseFatal).toBe(false);
    expect(r.cost?.has_unbounded).toBe(true);
    expect(r.cost?.tasks[0]?.usd).toBeNull(); // NEVER coerced to 0
    expect(r.permits?.source).toBe('declared');
    expect(r.findings).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('check dirty: findings[] typed, exit 2, never a throw', async () => {
    const r = await nika.check('dirty.nika.yaml');
    expect(r.clean).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.findings[0]?.kind).toBe('unknown_tool');
    expect(r.findings[0]?.code).toBe('NIKA-BUILTIN-001');
    expect(r.findings[0]?.message).toContain('did you mean');
  });

  it('parse-fatal OLD voice (released 0.99.0 plain text) → synthesized PARSE finding', async () => {
    const r = await nika.check('fatal-old.nika.yaml');
    expect(r.parseFatal).toBe(true);
    expect(r.clean).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.findings[0]?.kind).toBe('parse');
    expect(r.findings[0]?.code).toBe('NIKA-PARSE-005');
    expect(r.findings[0]?.docs_url).toContain('NIKA-PARSE-005');
    expect(r.raw).toBeNull();
    expect(r.warnings[0]).toContain('non-JSON');
  });

  it('parse-fatal NEW voice (post-#372 JSON) → same typed shape', async () => {
    const r = await nika.check('fatal-new.nika.yaml');
    expect(r.parseFatal).toBe(true);
    expect(r.findings[0]?.kind).toBe('parse');
    expect(r.raw).not.toBeNull();
  });

  it('unknown report_version → warning, never a throw (design law #3)', async () => {
    const r = await nika.check('future.nika.yaml');
    expect(r.clean).toBe(true);
    expect(r.reportVersion).toBe(9);
    expect(r.warnings[0]).toContain('unknown report_version 9');
    expect(r.raw?.['brand_new_key']).toBeDefined(); // rides through untouched
  });

  it('run: NDJSON events fold, stderr noise never becomes an event, outcome maps §4', async () => {
    const handle = nika.run('ok.nika.yaml');
    const kinds: string[] = [];
    for await (const ev of handle) kinds.push(ev.kind);
    expect(kinds).toEqual(['workflow_started', 'task_completed', 'workflow_completed']);
    const outcome = await handle.outcome;
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.events).toHaveLength(3);
  });

  it('run failing: exit 1 is a WORKFLOW failure, not a driver error', async () => {
    const outcome = await nika.runToEnd('failing.nika.yaml');
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.events.at(-1)?.kind).toBe('workflow_failed');
  });

  it('dryRunPlan: the #370 plan object, plan_version-guarded', async () => {
    const p = await nika.dryRunPlan('ok.nika.yaml');
    expect(p.planVersion).toBe(1);
    expect(p.workflow).toBe('demo');
    expect(p.waves).toEqual([['fetch'], ['think']]);
    expect(p.tasks[1]).toEqual({ id: 'think', verb: 'infer' });
    expect(p.warnings).toEqual([]);
  });

  it('dryRunPlan on a dirty file: typed rejection CARRYING the check report', async () => {
    await expect(nika.dryRunPlan('dirty.nika.yaml')).rejects.toMatchObject({
      report: { clean: false },
    });
  });

  it('dryRunPlan on a pre-#370 binary: the error teaches the floor, names the version', async () => {
    await expect(nika.dryRunPlan('pre370.nika.yaml')).rejects.toThrow(
      /needs the engine's machine dry-run.*this binary is nika 0\.99\.0.*brew upgrade/s,
    );
  });

  it('test + traceVerify map their exits', async () => {
    expect((await nika.test('golden-ok.nika.yaml')).passed).toBe(true);
    expect((await nika.test('golden-bad.nika.yaml')).passed).toBe(false);
    const ok = await nika.traceVerify();
    expect(ok.intact).toBe(true);
    expect(ok.head).toHaveLength(64);
    const broken = await nika.traceVerify('broken.ndjson');
    expect(broken.intact).toBe(false);
    expect(broken.exitCode).toBe(2);
  });

  it('absent binary: the spawn error teaches the install path', async () => {
    const ghost = new LocalNika({ bin: '/nonexistent/nika-nowhere' });
    await expect(ghost.version()).rejects.toThrow(/brew install|NIKA_BIN/);
  });
});
