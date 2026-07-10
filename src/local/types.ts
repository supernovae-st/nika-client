// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2026 SuperNovae Studio <contact@supernovae.studio>

/**
 * The stable subset of `nika check --json` (report_version 1) the local
 * driver guarantees. Unknown fields ride through untouched; an unknown
 * `report_version` parses this subset and appends to `warnings` instead
 * of throwing (design law #3 — consumers survive engine releases).
 */

/** One task's cost row — honesty typed in: `usd: null` is UNPRICED
 * (sovereign/local models), never coerced to 0. */
export interface LocalCostTask {
  task: string;
  model: string | null;
  /** null = unpriced — absence is not zero. */
  usd: number | null;
  unbounded_reason?: string | null;
  [k: string]: unknown;
}

/** The static cost envelope. `min_path_total_usd` is a FLOOR — the
 * `has_unbounded` flag lives BESIDE it so no consumer can read the
 * floor as a ceiling (design law #2). */
export interface LocalCost {
  min_path_total_usd: number;
  has_unbounded: boolean;
  tasks: LocalCostTask[];
  [k: string]: unknown;
}

/** One class-erased finding (engines past 2026-07-10 · the unified
 * findings[] list). Older engines: reconstructed from `clean` only. */
export interface LocalFinding {
  kind: string;
  gate?: string;
  severity?: string;
  code?: string;
  docs_url?: string;
  message: string;
  task?: string;
  [k: string]: unknown;
}

/** The affirmative permits contract (engines past 2026-07-10). */
export interface LocalPermits {
  source: 'declared' | 'floor' | string;
  declared?: unknown;
  needed?: unknown;
  notes?: string[];
  [k: string]: unknown;
}

/** The check verdict, driver-shaped. */
export interface LocalCheckReport {
  /** The engine's own contract version (1 today). */
  reportVersion: number;
  clean: boolean;
  /** True when the FILE never parsed — `findings` carries the one
   * PARSE row. Covers BOTH engine voices: the 0.99.0 plain-text
   * refusal and the later parse_fatal JSON (design law #4). */
  parseFatal: boolean;
  cost: LocalCost | null;
  /** Wave membership — task indices (or ids on newer engines). */
  waves: unknown[];
  requirements: Record<string, unknown> | null;
  /** Present on engines that ship the unified list; on a parse-fatal
   * plain-text voice the driver synthesizes the one row. */
  findings: LocalFinding[];
  permits: LocalPermits | null;
  /** Spec §4: 0 ok · 2 file findings · 3 environment. */
  exitCode: number;
  /** Driver-level honesty notes (unknown report_version · missing
   * sections) — never exceptions. */
  warnings: string[];
  /** The full parsed payload, untouched — the escape hatch. */
  raw: Record<string, unknown> | null;
}

/** One run event — `nika run --json` NDJSON line (same schema as the
 * trace file). The shape is engine-owned and open; `kind` is the
 * discriminator every release keeps. */
export interface NikaEvent {
  kind: string;
  [k: string]: unknown;
}

/** The run outcome after the stream closes. */
export interface LocalRunOutcome {
  /** Spec §4: 0 ok · 1 workflow failed · 2 findings · 3 environment. */
  exitCode: number;
  ok: boolean;
  events: NikaEvent[];
}

/** `nika trace verify` — exit 0 intact · 2 broken · 3 unchained. */
export interface TraceVerdict {
  intact: boolean;
  /** The 64-hex chain head when the verify printed one. */
  head: string | null;
  exitCode: number;
  output: string;
}

/** `nika test` (mock golden · offline). Exit 0 pass · others per §4. */
export interface GoldenVerdict {
  passed: boolean;
  exitCode: number;
  output: string;
}

/** The #370 machine plan (`run --dry-run --json` · plan_version 1). */
export interface LocalPlan {
  planVersion: number;
  workflow: string | null;
  waves: string[][];
  tasks: { id: string; verb: string }[];
  cost: LocalCost | null;
  permits: LocalPermits | null;
  requirements: Record<string, unknown> | null;
  warnings: string[];
  raw: Record<string, unknown>;
}

/** Options shared by every driver call. */
export interface LocalNikaOptions {
  /** Binary resolution ladder: this → `NIKA_BIN` env → `nika` on PATH. */
  bin?: string;
  /** Working directory for the spawned engine (trace store lives here). */
  cwd?: string;
}

export interface CheckOptions {
  /** `--model <provider/name>` — the static preview of the run override. */
  model?: string;
  /** `--native-strict` — promote native-first hints to failures. */
  nativeStrict?: boolean;
}

export interface RunOptions {
  /** Repeatable `--var KEY=VALUE` overrides. */
  vars?: Record<string, string | number | boolean>;
  /** `--model <provider/name>` override. */
  model?: string;
  /** `--max-cost-usd` — refuse to start past the static floor. */
  maxCostUsd?: number;
  /** `--resume <trace>` (ADR-099). */
  resume?: string;
  /** Abort the spawned run. */
  signal?: AbortSignal;
}
