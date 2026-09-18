import { spawn } from 'node:child_process';
import { NikaProtocolError, NikaTransportError } from '../errors.js';
import type { NikaTransportKind } from '../types.js';

export interface EngineCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * The signal that ended the child, when it did (an external kill — the
   * caller's own abort and overflow paths reject instead of resolving).
   */
  exitSignal: string | null;
}

interface EngineCaptureOptions {
  cwd?: string;
  signal?: AbortSignal;
  bufferBytes: number;
  transport: NikaTransportKind;
  label: string;
  /**
   * When set, a child that was asked to stop (caller abort or buffer
   * overflow) and has not exited within this grace is sent SIGKILL, so a
   * wedged producer can never keep the capture pending. Unset keeps the
   * historical SIGTERM-only behavior.
   */
  killGraceMs?: number;
}

/** Capture one bounded machine adapter invocation without a shell. */
export function captureEngine(
  bin: string,
  args: string[],
  options: EngineCaptureOptions,
): Promise<EngineCapture> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new NikaTransportError(options.transport, `${options.label} aborted by caller`));
      return;
    }
    const child = spawn(bin, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let spawnError: Error | undefined;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      if (options.killGraceMs === undefined) return;
      killTimer ??= setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, options.killGraceMs);
      killTimer.unref();
    };
    const append = (stream: 'stdout' | 'stderr', chunk: string) => {
      if (overflow) return;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) > options.bufferBytes
        || Buffer.byteLength(stderr) > options.bufferBytes) {
        overflow = true;
        stop();
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr.on('data', (chunk: string) => append('stderr', chunk));
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (cause) => {
      spawnError = cause;
    });
    child.once('close', (code, exitSignal) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) {
        reject(new NikaTransportError(options.transport, `${options.label} aborted by caller`));
      } else if (spawnError) {
        // Name the path and the errno: a wrong NIKA_BIN is the common cause.
        reject(new NikaTransportError(
          options.transport,
          `Cannot spawn ${bin} for ${options.label}: ${spawnError.message}`,
          { cause: spawnError },
        ));
      } else if (overflow) {
        reject(new NikaProtocolError(
          options.transport,
          `${options.label} exceeded ${options.bufferBytes} bytes`,
        ));
      } else {
        resolve({ exitCode: code ?? 3, stdout, stderr, exitSignal });
      }
    });
  });
}
