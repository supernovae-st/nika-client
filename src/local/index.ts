// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2026 SuperNovae Studio <contact@supernovae.studio>

/**
 * `LocalNika` — the typed driver for the SHIPPED engine binary.
 *
 * The main module targets the future `nika serve` HTTP surface; THIS
 * module works the day it ships, by driving the machine-stable CLI
 * contracts the engine already carries: `check --json`
 * (report_version-guarded) · `run --json` (NDJSON event stream) ·
 * `run --dry-run --json` (the plan object) · `test` · `trace verify`.
 *
 * Zero dependencies. Process spawning is deliberately `spawn` with an
 * ARGV ARRAY and no shell (`exec`/shell-string forms are banned here —
 * the workflow path is attacker-adjacent input, and argv+no-shell is
 * the injection-safe form). Exit codes are the engine CLI exit-code
 * contract (locked · additive-only): 0 ok · 1 workflow failed · 2 file
 * findings · 3 environment · 4 paused, mapped, never guessed.
 */

import { spawn } from 'node:child_process';
import type {
  CheckOptions,
  GoldenVerdict,
  LocalCheckReport,
  LocalCost,
  LocalFinding,
  LocalNikaOptions,
  LocalPermits,
  LocalPlan,
  LocalRunOutcome,
  NikaEvent,
  RunOptions,
  TraceVerdict,
} from './types.js';

export type * from './types.js';

/** The report_version this driver was written against. */
const KNOWN_REPORT_VERSION = 1;
/** The plan_version this driver was written against (#370). */
const KNOWN_PLAN_VERSION = 1;

interface Spawned {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A run handle: the event stream plus its settled outcome. */
export interface RunHandle extends AsyncIterable<NikaEvent> {
  outcome: Promise<LocalRunOutcome>;
}

/** The typed driver for a locally installed `nika` binary. */
export class LocalNika {
  readonly bin: string;
  readonly cwd: string | undefined;

  constructor(opts: LocalNikaOptions = {}) {
    // The resolution ladder: explicit → NIKA_BIN → PATH.
    this.bin = opts.bin ?? process.env['NIKA_BIN'] ?? 'nika';
    this.cwd = opts.cwd;
  }

  /** `nika --version` — the probe. Rejects when the binary is absent. */
  async version(): Promise<string> {
    const r = await this.capture(['--version']);
    if (r.exitCode !== 0) {
      throw new Error(`nika --version exited ${r.exitCode}: ${r.stderr.trim()}`);
    }
    return r.stdout.trim();
  }

  /**
   * `nika check <file> --json` — the audit, typed. Never throws on
   * findings (they ARE the result); throws only when the binary is
   * unreachable.
   */
  async check(file: string, opts: CheckOptions = {}): Promise<LocalCheckReport> {
    const args = ['check', file, '--json'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.nativeStrict) args.push('--native-strict');
    const r = await this.capture(args);
    return parseCheck(r);
  }

  /**
   * `nika run <file> --json` — the event stream, folded lazily. Each
   * yielded value is one NDJSON journal line; `handle.outcome` settles
   * when the stream closes. Diagnostics ride stderr by the engine's
   * machine-mode contract and are never parsed as events.
   */
  run(file: string, opts: RunOptions = {}): RunHandle {
    const args = ['run', file, '--json', ...runFlags(opts)];
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    });
    const events: NikaEvent[] = [];
    let settle!: (o: LocalRunOutcome) => void;
    let fail!: (e: Error) => void;
    const outcome = new Promise<LocalRunOutcome>((res, rej) => {
      settle = res;
      fail = rej;
    });
    // A consumer may never await the outcome (pure-stream use) — an
    // engine failure exit must not become an unhandled rejection.
    outcome.catch(() => {});

    async function* stream(): AsyncGenerator<NikaEvent> {
      let buf = '';
      child.stderr.on('data', () => {
        /* progress/diagnostics — the machine contract keeps stdout pure */
      });
      const done: Promise<number> = new Promise((res, rej) => {
        child.on('error', rej);
        child.on('close', (code) => res(code ?? 3));
      });
      try {
        for await (const chunk of child.stdout) {
          buf += String(chunk);
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = tryJson(line);
            if (ev && typeof ev === 'object') {
              const event = ev as NikaEvent;
              events.push(event);
              yield event;
            }
          }
        }
        const exitCode = await done;
        settle({ exitCode, ok: exitCode === 0, events });
      } catch (e) {
        fail(e as Error);
        throw e;
      }
    }

    const it = stream();
    return { [Symbol.asyncIterator]: () => it, outcome };
  }

  /** Run to completion, buffering the stream — the one-call form. */
  async runToEnd(file: string, opts: RunOptions = {}): Promise<LocalRunOutcome> {
    const handle = this.run(file, opts);
    for await (const _ev of handle) {
      /* drain — events accumulate on the outcome */
    }
    return handle.outcome;
  }

  /**
   * `nika run <file> --dry-run --json` — the #370 plan object
   * (`plan_version: 1`). A DIRTY file answers the check report on the
   * refusal path — surfaced as a typed rejection carrying that report.
   *
   * Min engine: the first release after 0.99.0 (engine #370). An older
   * binary's clap refusal is translated into a teaching error naming
   * the probed version — never the raw flag-pair message.
   */
  async dryRunPlan(file: string): Promise<LocalPlan> {
    const r = await this.capture(['run', file, '--dry-run', '--json']);
    const raw = tryJson(r.stdout) as Record<string, unknown> | null;
    if (!raw) {
      // The released-binary skew (#12): engines tagged ≤0.99.0 predate the
      // machine dry-run (engine #370) and clap refuses the flag pair. Teach
      // the floor instead of relaying the raw refusal.
      if (r.stderr.includes('cannot be used with')) {
        const version = await this.version().catch(() => 'unknown');
        throw new Error(
          `dryRunPlan() needs the engine's machine dry-run (run --dry-run --json, ` +
            `first released AFTER 0.99.0) — this binary is ${version}. ` +
            `Upgrade the engine (brew upgrade supernovae-st/tap/nika) or use check() ` +
            `for the audit surface it already ships.`,
        );
      }
      throw new Error(`dry-run emitted no JSON (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }
    if (!('plan_version' in raw)) {
      // The engine's own contract: report_version vs plan_version keys.
      throw Object.assign(
        new Error('dry-run refused: the audit found findings (check report returned)'),
        { report: parseCheck(r) },
      );
    }
    const warnings: string[] = [];
    const planVersion = num(raw['plan_version']) ?? 0;
    if (planVersion !== KNOWN_PLAN_VERSION) {
      warnings.push(`unknown plan_version ${planVersion} — parsed the v${KNOWN_PLAN_VERSION} subset`);
    }
    return {
      planVersion,
      workflow: typeof raw['workflow'] === 'string' ? raw['workflow'] : null,
      waves: Array.isArray(raw['waves']) ? (raw['waves'] as string[][]) : [],
      tasks: Array.isArray(raw['tasks']) ? (raw['tasks'] as { id: string; verb: string }[]) : [],
      cost: (raw['cost'] as LocalCost) ?? null,
      permits: (raw['permits'] as LocalPermits) ?? null,
      requirements: (raw['requirements'] as Record<string, unknown>) ?? null,
      warnings,
      raw,
    };
  }

  /** `nika test <file>` — the offline mock golden. */
  async test(file: string, opts: { update?: boolean } = {}): Promise<GoldenVerdict> {
    const args = ['test', file];
    if (opts.update) args.push('--update');
    const r = await this.capture(args);
    return { passed: r.exitCode === 0, exitCode: r.exitCode, output: r.stdout + r.stderr };
  }

  /**
   * `nika trace verify [path]` — bare form reads the workspace latest
   * (engines past 2026-07-10); pass a path for older releases.
   */
  async traceVerify(path?: string): Promise<TraceVerdict> {
    const args = ['trace', 'verify'];
    if (path) args.push(path);
    const r = await this.capture(args);
    const head = /head ([0-9a-f]{64})/.exec(r.stdout)?.[1] ?? null;
    return { intact: r.exitCode === 0, head, exitCode: r.exitCode, output: r.stdout + r.stderr };
  }

  /** Spawn + buffer — argv array, no shell, both pipes captured. */
  private capture(args: string[]): Promise<Spawned> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('error', (e) =>
        reject(
          new Error(
            `cannot spawn ${this.bin}: ${e.message} — install nika (brew install supernovae-st/tap/nika) or set NIKA_BIN`,
          ),
        ),
      );
      child.on('close', (code) => resolve({ exitCode: code ?? 3, stdout, stderr }));
    });
  }
}

/** `--var`/flag folding for run forms. */
function runFlags(opts: RunOptions): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(opts.vars ?? {})) {
    args.push('--var', `${k}=${String(v)}`);
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.maxCostUsd !== undefined) args.push('--max-cost-usd', String(opts.maxCostUsd));
  if (opts.resume) args.push('--resume', opts.resume);
  return args;
}

/** The check parser — BOTH engine voices (design law #4). */
function parseCheck(r: Spawned): LocalCheckReport {
  const warnings: string[] = [];
  const raw = tryJson(r.stdout) as Record<string, unknown> | null;

  if (!raw) {
    // The released-binary parse-fatal voice: plain text `PARSE ✗ [CODE] …`.
    const text = (r.stdout + r.stderr).trim();
    const code = /\[(NIKA-[A-Z0-9-]+)\]/.exec(text)?.[1];
    const finding: LocalFinding = {
      kind: 'parse',
      gate: 'PARSE',
      severity: 'error',
      message: text.split('\n')[0] ?? 'parse-fatal',
      ...(code ? { code, docs_url: `https://nika.sh/errors/${code}` } : {}),
    };
    return {
      reportVersion: 0,
      clean: false,
      parseFatal: true,
      cost: null,
      waves: [],
      requirements: null,
      findings: [finding],
      permits: null,
      exitCode: r.exitCode,
      warnings: [
        'non-JSON check output (pre-2026-07 engine parse-fatal voice) — synthesized the PARSE finding',
      ],
      raw: null,
    };
  }

  const reportVersion = num(raw['report_version']) ?? 0;
  if (reportVersion !== KNOWN_REPORT_VERSION) {
    warnings.push(`unknown report_version ${reportVersion} — parsed the v${KNOWN_REPORT_VERSION} subset`);
  }
  const parseFatal = raw['parse_fatal'] === true;
  const findings = Array.isArray(raw['findings']) ? (raw['findings'] as LocalFinding[]) : [];
  if (!('findings' in raw) && raw['clean'] === false) {
    warnings.push('engine predates the unified findings[] — per-class keys only (read .raw)');
  }
  return {
    reportVersion,
    clean: raw['clean'] === true,
    parseFatal,
    cost: (raw['cost'] as LocalCost) ?? null,
    waves: Array.isArray(raw['waves']) ? (raw['waves'] as unknown[]) : [],
    requirements: (raw['requirements'] as Record<string, unknown>) ?? null,
    findings,
    permits: (raw['permits'] as LocalPermits) ?? null,
    exitCode: r.exitCode,
    warnings,
    raw,
  };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
