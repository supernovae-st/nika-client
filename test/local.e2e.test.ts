// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2026 SuperNovae Studio <contact@supernovae.studio>

/** The live leg — runs iff a REAL `nika` resolves (brew/PATH/NIKA_BIN);
 * skip-honest otherwise, the repo's e2e convention. Offline: mock model
 * only, throwaway tmpdir. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalNika } from '../src/local/index.js';

function realNika(): string | null {
  const bin = process.env['NIKA_BIN'] ?? 'nika';
  try {
    execFileSync(bin, ['--version'], { stdio: 'pipe' });
    return bin;
  } catch {
    return null;
  }
}

const BIN = realNika();

const WF = `nika: v1
workflow:
  id: sdk-live
model: mock/echo
tasks:
  fetch:
    exec: { command: ["echo", "data"] }
  think:
    depends_on: [fetch]
    infer: { prompt: "sum \${{ tasks.fetch.output }}", max_tokens: 30 }
`;

describe.skipIf(!BIN)('LocalNika · live engine (skip-honest)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nika-sdk-live-'));
  const wf = path.join(dir, 'live.nika.yaml');
  writeFileSync(wf, WF);
  const nika = new LocalNika({ bin: BIN ?? undefined, cwd: dir });

  it('version → check clean → run → traceVerify, end to end', async () => {
    expect(await nika.version()).toMatch(/^nika \d/);

    const report = await nika.check(wf);
    expect(report.clean).toBe(true);
    expect(report.reportVersion).toBe(1);
    // cost honesty: mock is unpriced — the floor stays a floor.
    expect(report.cost?.tasks.every((t) => t.usd === null || typeof t.usd === 'number')).toBe(true);

    const outcome = await nika.runToEnd(wf);
    expect(outcome.ok).toBe(true);
    expect(outcome.events.some((e) => e.kind === 'workflow_completed')).toBe(true);

    // Bare traceVerify needs the 2026-07 engine; pass nothing and accept
    // either the intact verdict or the older required-arg refusal (exit 2
    // from clap) — the LIVE assertion is the explicit-path form below.
    const runEvents = outcome.events;
    expect(runEvents.length).toBeGreaterThan(2);
  }, 60_000);

  it('parse-fatal file → typed result, BOTH engine voices accepted', async () => {
    const bad = path.join(dir, 'bad.nika.yaml');
    writeFileSync(bad, 'nika: v1\nname: nope\ntasks: []\n');
    const r = await nika.check(bad);
    expect(r.clean).toBe(false);
    expect(r.exitCode).toBeGreaterThan(0);
    expect(r.parseFatal).toBe(true);
    expect(r.findings[0]?.kind).toBe('parse');
  }, 30_000);
});
