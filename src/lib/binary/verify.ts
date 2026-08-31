import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { NikaCompatibilityError } from '../../errors.js';
import { captureEngine } from '../engine-capture.js';
import {
  compatibleEngineIdentity,
  type NikaEngineIdentity,
} from '../engine-identity.js';
import type { ResolvedNikaEngine } from './resolve.js';

const IDENTITY_BUFFER_BYTES = 16 * 1024;

export type { NikaEngineIdentity } from '../engine-identity.js';

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
  const captured = await captureEngine(bin, ['--sdk-identity'], {
    bufferBytes: IDENTITY_BUFFER_BYTES,
    transport: 'native-process',
    label: 'Engine identity probe',
  }).catch((cause: unknown) => {
    throw incompatible(
      'Engine identity probe failed',
      cause,
    );
  });
  if (captured.exitCode !== 0) {
    throw incompatible(`Engine identity probe exited with code ${captured.exitCode}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(captured.stdout.trim());
  } catch (cause) {
    throw incompatible('Engine identity probe did not emit one JSON object', cause);
  }
  if (captured.stderr.trim()) {
    throw incompatible('Engine identity probe wrote unexpected diagnostics');
  }
  try {
    return compatibleEngineIdentity(value, 'native-process');
  } catch (cause) {
    if (cause instanceof NikaCompatibilityError) throw cause;
    throw incompatible('Engine identity probe was incompatible', cause);
  }
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
