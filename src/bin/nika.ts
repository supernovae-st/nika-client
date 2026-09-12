import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NikaConfigurationError } from '../errors.js';
import {
  NikaEngineUnavailable,
  resolveNikaEngine,
  verifyNikaEngine,
} from '../lib/binary/index.js';
import type { ResolvedNikaEngine } from '../lib/binary/index.js';

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let engine: ResolvedNikaEngine;
  try {
    engine = resolveNikaEngine();
    const selected = await realpath(engine.bin).catch(() => undefined);
    if (selected === await realpath(fileURLToPath(import.meta.url))) {
      throw new NikaConfigurationError(
        'NIKA_BIN points to the npm launcher; unset NIKA_BIN to use the packaged engine, '
        + 'or set it to an absolute path to the native nika executable',
      );
    }
    await verifyNikaEngine(engine);
  } catch (cause) {
    const message = cause instanceof NikaEngineUnavailable || cause instanceof Error
      ? cause.message
      : String(cause);
    console.error(`nika: ${message}`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(engine.bin, argv, {
    shell: false,
    stdio: 'inherit',
  });
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };

  child.once('error', (cause) => {
    removeHandlers();
    console.error(`nika: Cannot spawn ${engine.bin}: ${cause.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    removeHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

await main();
