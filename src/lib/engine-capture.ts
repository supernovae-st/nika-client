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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const bytes = { stdout: 0, stderr: 0 };
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
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (overflow) return;
      bytes[stream] += chunk.byteLength;
      if (bytes[stream] > options.bufferBytes) {
        overflow = true;
        stop();
        return;
      }
      (stream === 'stdout' ? stdout : stderr).push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
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
        // Bound raw bytes before decoding. Decode the complete stdout so a
        // multibyte character split across chunks is preserved and a truncated
        // final character refuses instead of silently becoming U+FFFD. Stderr
        // is diagnostic text, not the machine document, and stays permissive.
        let decoded: string;
        try {
          decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
            .decode(Buffer.concat(stdout, bytes.stdout));
        } catch {
          reject(new NikaProtocolError(options.transport, `${options.label} stdout was not valid UTF-8`));
          return;
        }
        resolve({ exitCode: code ?? 3, stdout: decoded,
          stderr: Buffer.concat(stderr, bytes.stderr).toString('utf8'), exitSignal });
      }
    });
  });
}
