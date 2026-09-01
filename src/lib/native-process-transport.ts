import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  NikaCompatibilityError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../errors.js';
import type {
  NikaCancelResult,
  NikaAttachRunOptions,
  NikaCheckOptions,
  NikaCheckResult,
  NikaEvent,
  NikaReceipt,
  NikaRunId,
  NikaRunOptions,
  NikaRunResult,
  NikaRunStatus,
  NikaScheduleApplyResult,
  NikaScheduleOptions,
  NikaScheduleStatus,
  NikaTraceVerifyOptions,
  NikaTraceVerifyResult,
  NikaTransportKind,
  NikaWorkflowMetadata,
} from '../types.js';
import {
  eventError,
  eventOutputs,
  eventReceipt,
  eventStatus,
  machineObject,
  parseMachineObject,
  receiptTraceLocator,
} from './machine.js';
import { verifyNikaEngine, type ResolvedNikaEngine } from './binary/index.js';
import type { Transport, TransportRun } from './transport.js';

interface Captured {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeProcessTransportOptions {
  engine: ResolvedNikaEngine;
  cwd?: string;
  machineBufferBytes: number;
}

export class NativeProcessTransport implements Transport {
  readonly kind = 'native-process' as const;
  private ready?: Promise<void>;

  constructor(private readonly options: NativeProcessTransportOptions) {}

  async check(workflow: string, options: NikaCheckOptions): Promise<NikaCheckResult> {
    await this.ensureReady();
    const args = ['check', workflow, '--json'];
    if (options.model) args.push('--model', options.model);
    if (options.nativeStrict) args.push('--native-strict');
    const captured = await this.capture(args, options.signal);
    // The engine routes some reports (a missing file, a parse-fatal read) to
    // stderr behind a `nika: ` prefix. That is still the engine judging these
    // bytes, so read it rather than blaming the engine for incompatibility.
    const report = reportObject(captured.stdout)
      ?? reportObject(stripEnginePrefix(captured.stderr));
    if (!report) {
      const excerpt = diagnosticExcerpt(captured.stderr);
      throw new NikaCompatibilityError(
        'check',
        this.kind,
        `This engine did not emit the required JSON check report (exit ${captured.exitCode})`
        + (excerpt ? `: ${excerpt}` : ''),
      );
    }
    return { ...report, exitCode: captured.exitCode } as NikaCheckResult;
  }

  async startRun(workflow: string, options: NikaRunOptions): Promise<TransportRun> {
    await this.ensureReady();
    if (options.idempotencyKey !== undefined) {
      throw new NikaCompatibilityError(
        'idempotencyKey',
        this.kind,
        'idempotencyKey is an HTTP admission option',
      );
    }
    const args = ['run', workflow, '--json', ...runFlags(options)];
    const child = spawn(this.options.engine.bin, args, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    return this.processRun(randomUUID() as NikaRunId, child);
  }

  async attachRun(_id: string, _options: NikaAttachRunOptions): Promise<TransportRun> {
    throw new NikaCompatibilityError(
      'attachRun',
      this.kind,
      'Only a resident nika serve authority owns durable jobs across client processes',
    );
  }

  async listWorkflows(): Promise<readonly string[]> {
    throw new NikaCompatibilityError(
      'workflowCatalog',
      this.kind,
      'The contained workflow catalog belongs to a resident nika serve authority',
    );
  }

  async workflow(_name: string): Promise<NikaWorkflowMetadata> {
    throw new NikaCompatibilityError(
      'workflowCatalog',
      this.kind,
      'The contained workflow catalog belongs to a resident nika serve authority',
    );
  }

  async schedule(
    _workflow: string,
    _options: NikaScheduleOptions,
  ): Promise<NikaScheduleApplyResult> {
    throw new NikaCompatibilityError(
      'schedule',
      this.kind,
      'A direct native process is not a proven resident schedule authority; connect to nika serve',
    );
  }

  async scheduleStatus(_id: string): Promise<NikaScheduleStatus> {
    throw new NikaCompatibilityError(
      'schedule',
      this.kind,
      'A direct native process is not a proven resident schedule authority; connect to nika serve',
    );
  }

  async traceVerify(
    receipt: NikaReceipt,
    options: NikaTraceVerifyOptions,
  ): Promise<NikaTraceVerifyResult> {
    await this.ensureReady();
    const locator = receiptTraceLocator(receipt);
    if (!locator) {
      throw new NikaCompatibilityError(
        'traceVerify',
        this.kind,
        'The engine receipt does not carry a native trace locator',
      );
    }
    const captured = await this.capture(['trace', 'verify', locator, '--plain'], options.signal);
    if (captured.exitCode !== 0) {
      return {
        verified: false,
        exitCode: captured.exitCode,
        output: captured.stdout + captured.stderr,
      };
    }
    const evidence = await this.capture(
      ['trace', 'evidence', locator, '--json', '--plain'],
      options.signal,
    );
    let manifest: Record<string, unknown>;
    try {
      manifest = parseMachineObject(evidence.stdout.trim(), this.kind);
    } catch (cause) {
      throw new NikaCompatibilityError(
        'traceVerify',
        this.kind,
        `This engine did not emit the required evidence manifest (exit ${evidence.exitCode})`,
      );
    }
    const mismatch = receiptMismatch(receipt, manifest);
    return {
      verified: mismatch === undefined,
      exitCode: mismatch === undefined ? 0 : 2,
      output: captured.stdout + captured.stderr
        + (mismatch === undefined ? '' : `\nRECEIPT MISMATCH: ${mismatch}\n`),
    };
  }

  private processRun(id: NikaRunId, child: ChildProcessByStdio<null, Readable, Readable>): TransportRun {
    let settled = false;
    let lastEvent: NikaEvent | undefined;
    let receipt: NikaReceipt | undefined;
    let outputs: Record<string, unknown> | undefined;
    let machineError: ReturnType<typeof eventError>;
    let streamError: Error | undefined;
    let refusal: EngineRefusal | undefined;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = boundedAppend(stderr, chunk, this.options.machineBufferBytes);
    });

    const closed = new Promise<number>((resolve, reject) => {
      child.once('error', (cause) => {
        streamError = new NikaTransportError(
          this.kind,
          `Cannot spawn ${this.options.engine.bin}: ${cause.message}`,
          { cause },
        );
        reject(streamError);
      });
      child.once('close', (code, signal) => {
        settled = true;
        if (code === null && signal && !streamError) resolve(130);
        else resolve(code ?? 3);
      });
    });
    closed.catch(() => {});

    const kind = this.kind;
    const machineBufferBytes = this.options.machineBufferBytes;
    // A plain `NIKA-…` line under --json is the engine refusing the run, not a
    // broken machine stream. Hold it and let run.done carry the typed verdict
    // with the real exit status; the event stream simply carried no frame.
    const lineEvent = (line: string): NikaEvent | undefined => {
      const refused = engineRefusal(line);
      if (refused) {
        refusal ??= refused;
        return undefined;
      }
      return machineLine(line, kind) as NikaEvent;
    };
    const events: AsyncIterable<NikaEvent> = {
      [Symbol.asyncIterator]: async function* () {
        let buffer = '';
        child.stdout.setEncoding('utf8');
        try {
          for await (const chunk of child.stdout) {
            buffer += String(chunk);
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              const event = lineEvent(line);
              if (!event) continue;
              lastEvent = event;
              receipt = eventReceipt(event) ?? receipt;
              outputs = eventOutputs(event) ?? outputs;
              machineError = eventError(event) ?? machineError;
              yield event;
            }
            if (Buffer.byteLength(buffer) > machineBufferBytes) {
              throw new NikaProtocolError(
                kind,
                `Native machine line exceeded ${machineBufferBytes} bytes`,
              );
            }
          }
          const tail = buffer.trim();
          if (tail) {
            const event = lineEvent(tail);
            if (event) {
              lastEvent = event;
              receipt = eventReceipt(event) ?? receipt;
              outputs = eventOutputs(event) ?? outputs;
              machineError = eventError(event) ?? machineError;
              yield event;
            }
          }
        } catch (cause) {
          streamError = cause instanceof Error ? cause : new Error(String(cause));
          if (!settled) child.kill('SIGTERM');
          throw streamError;
        } finally {
          resolveDrained();
        }
      },
    };

    const done = Promise.all([closed, drained]).then(([exitCode]): NikaRunResult => {
      if (streamError) throw streamError;
      if (refusal) {
        throw new NikaOperationError(
          'run',
          this.kind,
          refusal.code,
          refusal.line,
          { status: exitCode },
        );
      }
      const status = eventStatus(lastEvent) ?? statusForExit(exitCode, lastEvent?.kind);
      return {
        id,
        status,
        transport: this.kind,
        exitCode,
        ...(outputs ? { outputs } : {}),
        ...(receipt ? { receipt } : {}),
        ...(machineError ? { error: machineError } : {}),
        ...(stderr ? { diagnostics: stderr } : {}),
      };
    });
    done.catch(() => {});

    let cancelPromise: Promise<NikaCancelResult> | undefined;
    return {
      id,
      events,
      done,
      status: async (): Promise<NikaRunStatus> => {
        throw new NikaCompatibilityError(
          'runStatus',
          this.kind,
          'A direct native process has no independent durable status authority; await run.done',
        );
      },
      cancel: () => {
        cancelPromise ??= Promise.resolve(
          settled
            ? {
                runId: id,
                accepted: false,
                status: 'already_settled',
                transport: this.kind,
              }
            : {
                runId: id,
                accepted: child.kill('SIGTERM'),
                status: 'cancellation_requested',
                transport: this.kind,
              },
        );
        return cancelPromise;
      },
      cleanup: async () => {
        if (!settled) child.kill('SIGTERM');
        await closed.catch(() => {});
      },
    };
  }

  private capture(args: string[], signal?: AbortSignal): Promise<Captured> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new NikaTransportError(this.kind, 'Operation aborted by caller'));
        return;
      }
      const child = spawn(this.options.engine.bin, args, {
        cwd: this.options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout = boundedAppend(stdout, chunk, this.options.machineBufferBytes);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr = boundedAppend(stderr, chunk, this.options.machineBufferBytes);
      });
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (cause) => {
        signal?.removeEventListener('abort', abort);
        reject(new NikaTransportError(
          this.kind,
          `Cannot spawn ${this.options.engine.bin}: ${cause.message}`,
          { cause },
        ));
      });
      child.once('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          reject(new NikaTransportError(this.kind, 'Operation aborted by caller'));
          return;
        }
        resolve({ exitCode: code ?? 3, stdout, stderr });
      });
    });
  }

  private ensureReady(): Promise<void> {
    this.ready ??= verifyNikaEngine(this.options.engine).then(() => undefined);
    return this.ready;
  }
}

interface EngineRefusal {
  code: string;
  line: string;
}

/** The engine prefixes a stream-routed report with its own name. */
const ENGINE_PREFIX = /^nika:\s*/;
/** A refusal line opens with the engine code that owns the verdict. */
const REFUSAL_CODE = /^(NIKA-[A-Z0-9-]+)\b/;
const DIAGNOSTIC_EXCERPT_LIMIT = 240;

function reportObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return machineObject(value);
}

function stripEnginePrefix(text: string): string {
  return text.trim().replace(ENGINE_PREFIX, '');
}

/** One bounded single-line excerpt so a typed refusal still teaches. */
function diagnosticExcerpt(text: string, limit = DIAGNOSTIC_EXCERPT_LIMIT): string | undefined {
  const single = stripEnginePrefix(text).replace(/\s+/g, ' ').trim();
  if (!single) return undefined;
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/** No JSON value can open with `NIKA-`, so a match is never a machine frame. */
function engineRefusal(line: string): EngineRefusal | undefined {
  const code = REFUSAL_CODE.exec(line)?.[1];
  return code ? { code, line } : undefined;
}

/** Keep the protocol verdict, and quote the line that earned it. */
function machineLine(line: string, kind: NikaTransportKind): Record<string, unknown> {
  try {
    return parseMachineObject(line, kind);
  } catch (cause) {
    const verdict = cause instanceof Error
      ? cause.message
      : 'Engine machine output was unreadable';
    const excerpt = diagnosticExcerpt(line);
    throw new NikaProtocolError(
      kind,
      excerpt ? `${verdict}: ${excerpt}` : verdict,
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
}

function runFlags(options: NikaRunOptions): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(options.vars ?? {})) {
    flags.push('--var', `${key}=${String(value)}`);
  }
  if (options.model) flags.push('--model', options.model);
  if (options.maxCostUsd !== undefined) flags.push('--max-cost-usd', String(options.maxCostUsd));
  return flags;
}

function statusForExit(exitCode: number, kind?: string): string {
  if (kind === 'workflow_completed') return 'succeeded';
  if (kind === 'workflow_failed') return 'failed';
  switch (exitCode) {
    case 0: return 'succeeded';
    case 4: return 'paused';
    case 130: return 'interrupted';
    default: return 'failed';
  }
}

function boundedAppend(current: string, chunk: string, limit: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= limit) return combined;
  return Buffer.from(combined).subarray(-limit).toString('utf8');
}

function receiptMismatch(
  receipt: NikaReceipt,
  manifest: Record<string, unknown>,
): string | undefined {
  const trace = machineObject(manifest.trace);
  const seal = machineObject(manifest.seal);
  const covers = machineObject(seal?.covers);
  const binding = machineObject(covers?.sdk_receipt);
  if (
    trace?.chain !== 'intact'
    || seal?.present !== true
    || seal.verifies !== true
    || seal.covers_chain !== true
    || !binding
  ) return 'the evidence manifest has no verified signed SDK receipt binding';

  const claims = ['receipt_format', 'execution_id', 'trace_id', 'snapshot_digest'] as const;
  for (const claim of claims) {
    if (receipt[claim] !== binding[claim]) return `${claim} is not bound to this trace`;
  }
  if (receipt.chain_head !== trace.head) return 'chain_head is not this journal head';
  if (receipt.chain_len !== trace.events) return 'chain_len is not this journal length';
  if (receipt.sealed !== true) return 'sealed is not true for this verified seal';
  return undefined;
}
