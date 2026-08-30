import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { NikaCompatibilityError } from '../../errors.js';
import type { ResolvedNikaEngine } from './resolve.js';

const MACHINE_PROTOCOL_VERSION = 1;
const IDENTITY_BUFFER_BYTES = 16 * 1024;

export interface NikaEngineIdentity {
  engineVersion: string;
  machineProtocolVersion: number;
  snapshotFormatVersion?: number;
  checkReportVersion?: number;
  eventFormatVersion?: number;
  traceFormatVersion?: number;
  supportedCapabilities?: string[];
  [key: string]: unknown;
}

interface PayloadIntegrity {
  algorithm: string;
  executable: {
    file: string;
    sha256: string;
  };
}

/** Verify package bytes and negotiate the engine contract before any workflow effect. */
export async function verifyNikaEngine(
  engine: ResolvedNikaEngine,
): Promise<NikaEngineIdentity> {
  const expectedVersion = engine.packageRoot
    ? await verifyManagedPayload(engine)
    : undefined;
  const identity = await probeIdentity(engine.bin);

  if (identity.machineProtocolVersion !== MACHINE_PROTOCOL_VERSION) {
    throw incompatible(
      `Engine machine protocol ${String(identity.machineProtocolVersion)} is incompatible with SDK protocol ${MACHINE_PROTOCOL_VERSION}`,
    );
  }
  if (expectedVersion !== undefined && identity.engineVersion !== expectedVersion) {
    throw incompatible(
      `Packaged engine version ${identity.engineVersion} does not match payload version ${expectedVersion}`,
    );
  }
  return identity;
}

async function verifyManagedPayload(engine: ResolvedNikaEngine): Promise<string> {
  const packageRoot = engine.packageRoot;
  if (!packageRoot || !engine.packageName) {
    throw incompatible('Managed engine resolution is missing package identity');
  }
  const manifest = await readJson(path.join(packageRoot, 'package.json'), 'payload manifest');
  if (manifest.name !== engine.packageName || typeof manifest.version !== 'string') {
    throw incompatible(`Invalid manifest for ${engine.packageName}`);
  }

  const integrity = await readJson(
    path.join(packageRoot, 'INTEGRITY.json'),
    'payload integrity metadata',
  ) as unknown as PayloadIntegrity;
  if (
    integrity.algorithm !== 'sha256'
    || integrity.executable?.file !== 'bin/nika'
    || !isSha256(integrity.executable?.sha256)
  ) {
    throw incompatible(`Invalid INTEGRITY.json for ${engine.packageName}`);
  }

  let metadata;
  try {
    metadata = await stat(engine.bin);
  } catch (cause) {
    throw incompatible(`Cannot read packaged engine ${engine.bin}`, cause);
  }
  if (!metadata.isFile()) {
    throw incompatible(`Packaged engine is not a file: ${engine.bin}`);
  }
  const actual = await sha256(engine.bin);
  if (actual !== integrity.executable.sha256) {
    throw incompatible(`Packaged engine checksum mismatch for ${engine.packageName}`);
  }
  return manifest.version;
}

async function probeIdentity(bin: string): Promise<NikaEngineIdentity> {
  const captured = await capture(bin, ['--sdk-identity']);
  if (captured.exitCode !== 0) {
    throw incompatible(`Engine identity probe exited with code ${captured.exitCode}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(captured.stdout.trim());
  } catch (cause) {
    throw incompatible('Engine identity probe did not emit one JSON object', cause);
  }
  if (!isRecord(value)) throw incompatible('Engine identity probe did not emit an object');
  if (typeof value.engineVersion !== 'string' || value.engineVersion.length === 0) {
    throw incompatible('Engine identity is missing engineVersion');
  }
  if (!Number.isSafeInteger(value.machineProtocolVersion)) {
    throw incompatible('Engine identity is missing machineProtocolVersion');
  }
  return value as NikaEngineIdentity;
}

function capture(
  bin: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      overflow ||= Buffer.byteLength(stdout) > IDENTITY_BUFFER_BYTES;
      if (overflow) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      overflow ||= Buffer.byteLength(stderr) > IDENTITY_BUFFER_BYTES;
      if (overflow) child.kill('SIGTERM');
    });
    child.once('error', (cause) => reject(incompatible(`Cannot spawn ${bin}`, cause)));
    child.once('close', (code) => {
      if (overflow) {
        reject(incompatible(`Engine identity probe exceeded ${IDENTITY_BUFFER_BYTES} bytes`));
        return;
      }
      if (stderr.trim()) {
        reject(incompatible('Engine identity probe wrote unexpected diagnostics'));
        return;
      }
      resolve({ exitCode: code ?? 3, stdout });
    });
  });
}

async function readJson(file: string, label: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) throw new TypeError(`${label} is not an object`);
    return parsed;
  } catch (cause) {
    throw incompatible(`Cannot verify ${label} at ${file}`, cause);
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function incompatible(message: string, cause?: unknown): NikaCompatibilityError {
  return new NikaCompatibilityError(
    'engineIdentity',
    'native-process',
    cause instanceof Error ? `${message}: ${cause.message}` : message,
  );
}
