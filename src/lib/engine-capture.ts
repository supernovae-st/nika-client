import { spawn } from 'node:child_process';
import { NikaProtocolError, NikaTransportError } from '../errors.js';
import type { NikaTransportKind } from '../types.js';

export interface EngineCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface EngineCaptureOptions {
  cwd?: string;
  signal?: AbortSignal;
  bufferBytes: number;
  transport: NikaTransportKind;
  label: string;
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
    const append = (stream: 'stdout' | 'stderr', chunk: string) => {
      if (overflow) return;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) > options.bufferBytes
        || Buffer.byteLength(stderr) > options.bufferBytes) {
        overflow = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr.on('data', (chunk: string) => append('stderr', chunk));
    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (cause) => {
      spawnError = cause;
    });
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) {
        reject(new NikaTransportError(options.transport, `${options.label} aborted by caller`));
      } else if (spawnError) {
        reject(new NikaTransportError(
          options.transport,
          `Cannot spawn engine for ${options.label}`,
          { cause: spawnError },
        ));
      } else if (overflow) {
        reject(new NikaProtocolError(
          options.transport,
          `${options.label} exceeded ${options.bufferBytes} bytes`,
        ));
      } else {
        resolve({ exitCode: code ?? 3, stdout, stderr });
      }
    });
  });
}
