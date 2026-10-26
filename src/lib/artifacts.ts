import { createHash, type Hash } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import { NikaConfigurationError, NikaProtocolError, NikaTransportError } from '../errors.js';
import type { NikaArtifact, NikaTransportKind } from '../types.js';
import { machineObject } from './machine.js';

/**
 * A settled server job's artifacts (engine nika#1834): the byte streams its
 * sealed journal records with their SHA-256, listed by
 * `GET /v1/jobs/{id}/artifacts` and downloaded by
 * `GET /v1/jobs/{id}/artifacts/{name}`. The server checks every byte it sends
 * against the journal; this module checks them again on arrival, and resolves
 * nothing it has not proven. It reads no journal and derives no artifact: the
 * server's manifest is the only list, and a local run has none.
 */

/** The capability `/health` lists once the server serves artifacts. */
export const ARTIFACTS_CAPABILITY = 'artifacts';

/** The response header that carries a downloaded artifact's recorded SHA-256. */
export const ARTIFACT_SHA256_HEADER = 'Nika-Artifact-Sha256';

/**
 * How many more times a download whose body ended early is requested. The
 * server has no range requests, so each retry is the whole artifact again;
 * a file that really changed answers 409 `artifact_changed` instead.
 */
export const ARTIFACT_RETRIES = 3;

/** The default bound of `readArtifact()`: the bytes it holds at once. */
export const DEFAULT_ARTIFACT_READ_BYTES = 16 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A response body as a fetch hands it over: only its reader is used, so the
 * global stream of `fetch` and Node's own web stream both fit.
 */
export interface ArtifactBody {
  getReader(): ArtifactBodyReader;
}

interface ArtifactBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/** What one download is proven against. */
export interface ArtifactExpectation {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** The artifact a caller asked for: its name, and the entry when one was given. */
export interface RequestedArtifact {
  readonly name: string;
  readonly entry?: NikaArtifact;
}

/** A manifest whose shape holds; its receipt is bound to the job by the caller. */
export interface ArtifactManifestShape {
  readonly object: Record<string, unknown>;
  readonly receipt: Record<string, unknown>;
  readonly truncated: boolean;
  readonly artifacts: NikaArtifact[];
}

/**
 * The manifest a server answered. Every field the contract names is checked
 * by type; any other key rides through, read open, so an additive key of a
 * later engine is not a refusal. Names are unique, sizes are byte counts and
 * digests are SHA-256, as the journal records them, and a file's path is a
 * contained relative path: the SDK refuses anything else, quoting no value.
 */
export function checkedArtifactManifest(
  value: Record<string, unknown>,
  transport: NikaTransportKind,
): ArtifactManifestShape {
  const fault = (what: string) => new NikaProtocolError(transport, `Artifact manifest ${what}`);
  const receipt = machineObject(value.receipt);
  if (!receipt) throw fault('omitted its receipt');
  if (typeof value.verdict !== 'string' || value.verdict.length === 0) throw fault('verdict was not a word');
  if (!Number.isSafeInteger(value.max_artifact_bytes) || (value.max_artifact_bytes as number) < 1) {
    throw fault('max_artifact_bytes was not a positive integer');
  }
  if (typeof value.truncated !== 'boolean') throw fault('truncated was not a boolean');
  if (!Array.isArray(value.artifacts)) throw fault('artifacts was not an array');
  const names = new Set<string>();
  const artifacts = value.artifacts.map((item, index) => {
    const entry = artifactEntry(item, transport, index);
    if (names.has(entry.name)) throw fault('named one artifact twice');
    names.add(entry.name);
    return entry;
  });
  return { object: value, receipt, truncated: value.truncated, artifacts };
}

function artifactEntry(value: unknown, transport: NikaTransportKind, index: number): NikaArtifact {
  const fault = (what: string) => new NikaProtocolError(
    transport,
    `Artifact manifest entry ${index} ${what}`,
  );
  const entry = machineObject(value);
  if (!entry) throw fault('was not an object');
  if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.includes('\0')) {
    throw fault('name was not a non-empty string');
  }
  if (typeof entry.kind !== 'string' || entry.kind.length === 0) throw fault('kind was not a word');
  if (entry.kind === 'file' && entry.path === undefined) throw fault('is a file without its path');
  if (entry.kind === 'agent_image' && entry.path !== undefined) throw fault('is an agent image with a path');
  if (entry.path !== undefined && !isContainedPath(entry.path)) {
    throw fault('path was not a contained relative path');
  }
  if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw fault('size was not a byte count');
  if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
    throw fault('sha256 was not 64 lowercase hexadecimal digits');
  }
  if (typeof entry.mime !== 'string' || entry.mime.length === 0) throw fault('mime was not a media type');
  if (entry.task !== undefined && typeof entry.task !== 'string') throw fault('task was not a string');
  if (typeof entry.event_id !== 'string' || entry.event_id.length === 0) {
    throw fault('event_id was not an identifier');
  }
  return { ...entry } as NikaArtifact;
}

/**
 * The engine's own containment law for an artifact path (nika-serve
 * `artifacts::manifest::contained`): relative, `/`-separated, normalized, no
 * backslash and no NUL. A path that holds it can be joined under a directory
 * without leaving it.
 */
function isContainedPath(value: unknown): boolean {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * The artifact a caller names: a manifest name, or an entry carrying the size
 * and digest to prove against. A misuse is a `TypeError`, before any request.
 */
export function requestedArtifact(value: unknown): RequestedArtifact {
  if (typeof value === 'string') return { name: artifactName(value) };
  const entry = machineObject(value);
  if (!entry) {
    throw new TypeError('An artifact is its manifest name or its entry from run.artifacts()');
  }
  const name = artifactName(entry.name);
  if (
    !Number.isSafeInteger(entry.size)
    || (entry.size as number) < 0
    || typeof entry.sha256 !== 'string'
    || !SHA256_HEX.test(entry.sha256)
  ) {
    throw new TypeError('An artifact entry carries the size and sha256 its manifest lists');
  }
  return { name, entry: { ...entry } as NikaArtifact };
}

function artifactName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('An artifact name must be a non-empty string');
  }
  if (value.includes('\0')) throw new TypeError('An artifact name cannot contain a NUL byte');
  // One path segment: its `/` travel as %2F. Only a dot segment would be
  // resolved away by the URL itself, and no manifest names one.
  if (value === '.' || value === '..') throw new TypeError('An artifact name is never a dot segment');
  try {
    encodeURIComponent(value);
  } catch {
    throw new TypeError('An artifact name must be valid Unicode');
  }
  return value;
}

/** The path segment that carries a name: the server decodes it once and matches it exactly. */
export function artifactSegment(name: string): string {
  return encodeURIComponent(name);
}

/** `readArtifact()`'s bound, validated: a misuse is a `RangeError`. */
export function artifactReadBound(value: unknown): number {
  const bound = value ?? DEFAULT_ARTIFACT_READ_BYTES;
  if (!Number.isSafeInteger(bound) || (bound as number) < 1) {
    throw new RangeError('readArtifact() maxBytes must be a positive safe integer');
  }
  return bound as number;
}

/** The refusal of an artifact larger than `readArtifact()` holds. */
export function artifactTooLarge(name: string, size: number, maxBytes: number): NikaConfigurationError {
  return new NikaConfigurationError(
    `Artifact ${JSON.stringify(name)} is ${size} bytes, more than readArtifact() holds `
    + `(maxBytes ${maxBytes}): set maxBytes to at least ${size}, or stream it with `
    + 'downloadArtifact(). Nothing was downloaded',
  );
}

export interface VerifiedArtifactOptions {
  readonly transport: NikaTransportKind;
  readonly expected: ArtifactExpectation;
  /** The body of the first response, whose headers already matched `expected`. */
  readonly first: ArtifactBody;
  /**
   * Request the artifact again, as attempt `attempt` (2, 3…): wait, send, and
   * resolve with a body whose headers match `expected`, or reject typed.
   */
  readonly again: (attempt: number) => Promise<ArtifactBody>;
  /** Ends every request of this download; aborted when the stream is cancelled or fails. */
  readonly controller: AbortController;
  /** Whether the caller's signal stopped the download, and the error that says so. */
  readonly aborted: () => Error | undefined;
  /** Called once, when the stream closed, failed or was cancelled. */
  readonly finished: () => void;
}

/**
 * The verified stream of one artifact download. Every chunk is hashed as it
 * arrives, and the stream never holds more than the recorded size. It closes
 * only once exactly that many bytes arrived and hash to the recorded SHA-256,
 * and its last chunk is held back until then, so a reader that stops at the
 * recorded size never has the bytes before they are proven.
 *
 * A body that ends early (shorter than its `Content-Length`, or reset before
 * its end) is requested again, up to `ARTIFACT_RETRIES` times. There is no
 * range request: a retry sends the whole artifact, and its first bytes, the
 * ones already received, must hash as they did, or the stream fails. A server
 * refusal on a retry (409 `artifact_changed` for a file that changed) fails
 * the stream with that typed error.
 */
export function verifiedArtifactStream(options: VerifiedArtifactOptions): ReadableStream<Uint8Array> {
  const { expected, transport } = options;
  const label = JSON.stringify(expected.name);
  const hash = createHash('sha256');
  let reader = options.first.getReader();
  let attempt = 1;
  let received = 0;
  let held: Uint8Array | undefined;
  /** Bytes of a retry's body still to skip: the ones already received. */
  let skip = 0;
  let resent: Hash | undefined;
  let prefix: string | undefined;
  let ended = false;

  const finish = () => {
    if (ended) return;
    ended = true;
    options.finished();
  };
  const whole = () => received === expected.size && skip === 0;
  /** A retry that answered after the stream was cancelled: release its body. */
  const stop = () => {
    void reader.cancel().catch(() => {});
  };

  const requestAgain = async (cause?: unknown) => {
    void reader.cancel().catch(() => {});
    if (attempt > ARTIFACT_RETRIES) {
      throw new NikaTransportError(
        transport,
        `Artifact ${label} ended before its ${expected.size} bytes on ${attempt} attempts `
        + `(${received} arrived), so nothing was proven. Download it again later: a file that `
        + 'changed answers 409 artifact_changed',
        cause instanceof Error ? { cause } : undefined,
      );
    }
    prefix = received > 0 ? hash.copy().digest('hex') : undefined;
    attempt += 1;
    const body = await options.again(attempt);
    reader = body.getReader();
    skip = received;
    resent = received > 0 ? createHash('sha256') : undefined;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          let step: { done: boolean; value?: Uint8Array };
          try {
            step = await reader.read();
          } catch (cause) {
            if (ended || options.aborted()) throw cause;
            // Every byte arrived and only the end was lost: the digest decides.
            if (!whole()) {
              await requestAgain(cause);
              if (ended) return stop();
              continue;
            }
            step = { done: true, value: undefined };
          }
          if (ended) return;
          if (step.done) {
            if (!whole()) {
              await requestAgain();
              if (ended) return stop();
              continue;
            }
            const digest = hash.digest('hex');
            if (digest !== expected.sha256) {
              throw new NikaProtocolError(
                transport,
                `Artifact ${label}: its ${expected.size} bytes hash to ${digest}, not the recorded `
                + `${expected.sha256}`,
              );
            }
            if (held) controller.enqueue(held);
            held = undefined;
            controller.close();
            finish();
            return;
          }
          let chunk = step.value ?? new Uint8Array(0);
          if (!(chunk instanceof Uint8Array)) {
            throw new NikaProtocolError(transport, `Artifact ${label} arrived as something other than bytes`);
          }
          if (skip > 0 && resent) {
            const take = Math.min(skip, chunk.byteLength);
            resent.update(chunk.subarray(0, take));
            skip -= take;
            chunk = chunk.subarray(take);
            if (skip === 0) {
              const digest = resent.digest('hex');
              resent = undefined;
              if (digest !== prefix) {
                throw new NikaProtocolError(
                  transport,
                  `Artifact ${label}: attempt ${attempt} sent other bytes for the first ${received} `
                  + 'bytes than the attempt before it',
                );
              }
            }
          }
          if (chunk.byteLength === 0) continue;
          if (received + chunk.byteLength > expected.size) {
            throw new NikaProtocolError(
              transport,
              `Artifact ${label} sent more than its recorded ${expected.size} bytes`,
            );
          }
          hash.update(chunk);
          received += chunk.byteLength;
          const release = held;
          held = chunk;
          if (release) {
            controller.enqueue(release);
            return;
          }
        }
      } catch (cause) {
        if (ended) return;
        const failure = options.aborted() ?? cause;
        finish();
        held = undefined;
        options.controller.abort();
        void reader.cancel().catch(() => {});
        throw failure;
      }
    },
    cancel(reason) {
      finish();
      held = undefined;
      options.controller.abort(reason);
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** An artifact's proven bytes, read whole: `size` bytes once the stream closed. */
export async function collectArtifact(
  stream: ReadableStream<Uint8Array>,
  size: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // The stream never passes the recorded size, so the buffer always holds it.
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes;
}

/** An empty body, for a response that carried none. */
export function emptyBody(): ArtifactBody {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Canonical JSON of a machine value: equal values, equal text, whatever the key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = machineObject(value);
  if (object) {
    return `{${Object.keys(object).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
