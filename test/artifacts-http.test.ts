import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Nika,
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaOperationError,
  NikaProtocolError,
  NikaTransportError,
} from '../src/index.js';
import type { NikaArtifact, NikaArtifactDownload, NikaRemoteConfig, NikaRun } from '../src/index.js';

// run.artifacts(), run.downloadArtifact() and run.readArtifact() against a
// fake `nika serve` on loopback that answers the two routes of engine nika#1834
// (NIK-265) as its OpenAPI document declares them, through the client's own
// unbounded fetch. The few answers no server can put on the wire (more bytes
// than its Content-Length, a clean early end, a body held open at its last
// byte) come from an injected fetch at the end of the file.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_FIXTURE = path.join(HERE, 'fixtures', 'fake-nika.mjs');
const posix = process.platform !== 'win32';

const TOKEN = 'artifact-test-token-0123456789-abcdef';
const JOB = 'c5e07851-3029-4b34-8ea8-e79208d50560';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="4" height="4"/>'.repeat(120)}</svg>`,
);
/** Larger than one socket read, so it crosses several chunks. */
const PNG = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7) % 251));
const EMPTY = Buffer.alloc(0);

const RECEIPT = {
  job_id: JOB,
  execution_id: 'exe-01a17452-e5d9-7775-ac85-c8a58f71e259',
  trace_id: '01a17452e5d97775ac85c8a58f71e259',
  snapshot_digest: 'c0b3b80e85a7aa8b6954186015afd7a3f86cbf7d063660c4aede409cd14208cb',
  origin: { kind: 'manual' },
  chain_head: '33d69ad643f212cfe7a1f952e6fa77adb22f21801a72bee5a0f41854afdc48e9',
};

const CHART: NikaArtifact = {
  name: 'file/out/totals.svg',
  kind: 'file',
  path: 'out/totals.svg',
  size: SVG.length,
  sha256: sha256(SVG),
  mime: 'image/svg+xml',
  task: 'draw',
  event_id: '01a1755b-ee95-7656-9150-74791d69672a',
};
const IMAGE: NikaArtifact = {
  name: 'agent_image/1.png',
  kind: 'agent_image',
  size: PNG.length,
  sha256: sha256(PNG),
  mime: 'image/png',
  task: 'draw',
  event_id: '01a17453-93be-75a0-bbdc-d0f9da805b6a',
};
const BLANK: NikaArtifact = {
  name: 'file/out/blank.txt',
  kind: 'file',
  path: 'out/blank.txt',
  size: 0,
  sha256: sha256(EMPTY),
  mime: 'application/octet-stream',
  event_id: '01a17453-93be-75a0-bbdc-d0f9da805b6b',
};
/** What the fake server holds, by artifact name. */
const FILES = new Map<string, { bytes: Buffer; mime: string }>([
  [CHART.name, { bytes: SVG, mime: CHART.mime }],
  [IMAGE.name, { bytes: PNG, mime: IMAGE.mime }],
  [BLANK.name, { bytes: EMPTY, mime: BLANK.mime }],
  // Served, never listed: a name past a truncated manifest, or a contradiction.
  ['file/out/unlisted.svg', { bytes: SVG, mime: 'image/svg+xml' }],
]);

function manifestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt: RECEIPT,
    verdict: 'sealed',
    max_artifact_bytes: 268_435_456,
    truncated: false,
    artifacts: [CHART, IMAGE],
    ...overrides,
  };
}

const MANIFEST_REFUSALS = [
  [401, 'unauthorized'],
  [404, 'job_not_found'],
  [408, 'request_timeout'],
  [409, 'job_not_settled'],
  [409, 'artifact_journal_unavailable'],
  [409, 'artifact_journal_unverified'],
  [500, 'internal_error'],
  [503, 'store_busy'],
  [503, 'artifact_capacity'],
] as const;

const DOWNLOAD_REFUSALS = [
  [401, 'unauthorized'],
  [403, 'artifact_too_large'],
  [404, 'job_not_found'],
  [404, 'artifact_not_found'],
  [409, 'job_not_settled'],
  [409, 'artifact_journal_unavailable'],
  [409, 'artifact_journal_unverified'],
  [409, 'artifact_changed'],
  [500, 'internal_error'],
  [503, 'store_busy'],
  [503, 'artifact_capacity'],
] as const;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface Seen {
  method: string;
  url: string;
  authorization?: string;
  acceptEncoding?: string;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers,
  });
  response.end(text);
}

function envelope(code: string): { error: { code: string; message: string } } {
  return { error: { code, message: `the server's ${code} refusal` } };
}

function refuse(status: number, code: string): Handler {
  return (_request, response) => json(response, status, envelope(code));
}

/** The headers `nika serve` sends with an artifact's bytes. */
function artifactHeaders(bytes: Uint8Array, mime: string, overrides: Record<string, string> = {}) {
  return {
    'Content-Type': mime,
    'Content-Length': String(bytes.length),
    'Nika-Artifact-Sha256': sha256(bytes),
    'Content-Disposition': 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-store',
    ...overrides,
  };
}

/** The artifact a download path names (its rest decoded once, as the server does). */
function addressed(request: IncomingMessage): { bytes: Buffer; mime: string } | undefined {
  const raw = (request.url ?? '').slice(`/v1/jobs/${JOB}/artifacts/`.length);
  return FILES.get(decodeURIComponent(raw));
}

/** The recorded bytes, as recorded, or the server's 404. */
const recorded: Handler = (request, response) => {
  const file = addressed(request);
  if (!file) {
    json(response, 404, envelope('artifact_not_found'));
    return;
  }
  response.writeHead(200, artifactHeaders(file.bytes, file.mime));
  response.end(file.bytes);
};

/** The recorded headers, then the first `sent` bytes only, then the connection drops. */
function cutShort(sent: number): Handler {
  return (request, response) => {
    const file = addressed(request)!;
    response.writeHead(200, artifactHeaders(file.bytes, file.mime));
    response.write(file.bytes.subarray(0, sent), () => {
      setTimeout(() => response.socket?.destroy(), 20);
    });
  };
}

/** The recorded headers over other bytes of the same length. */
const tampered: Handler = (request, response) => {
  const file = addressed(request)!;
  const other = Buffer.from(file.bytes);
  other[other.length - 1]! ^= 0xff;
  response.writeHead(200, artifactHeaders(file.bytes, file.mime));
  response.end(other);
};

/** The recorded bytes under headers changed by `overrides`. */
function headed(overrides: Record<string, string>, omit: string[] = []): Handler {
  return (request, response) => {
    const file = addressed(request)!;
    const headers: Record<string, string> = artifactHeaders(file.bytes, file.mime, overrides);
    for (const name of omit) delete headers[name];
    response.writeHead(200, headers);
    response.end(file.bytes);
  };
}

function healthBody(capabilities: string[]): Record<string, unknown> {
  return {
    status: 'ok',
    service: 'nika-serve',
    engineVersion: '0.123.1',
    machineProtocolVersion: 2,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 2,
    supportedCapabilities: capabilities,
  };
}

function settledJob(): Record<string, unknown> {
  return {
    id: JOB,
    status: 'succeeded',
    execution_id: RECEIPT.execution_id,
    trace_id: RECEIPT.trace_id,
    outputs: {},
    receipt: RECEIPT,
  };
}

function started(): string {
  return `id: 1\ndata: ${JSON.stringify({ sequence: 1, kind: 'execution.started', status: 'running' })}\n\n`;
}

function settledFrame(): string {
  return `id: 2\ndata: ${JSON.stringify({
    sequence: 2, kind: 'execution.settled', status: 'succeeded', receipt: RECEIPT,
  })}\n\n`;
}

/** A fake `nika serve` with the one job `JOB`, settled and sealed. */
class FakeServe {
  readonly seen: Seen[] = [];
  capabilities = ['check', 'executionSnapshot', 'eventStream', 'cancel', 'jobInputs', 'artifacts'];
  manifest: Handler = (_request, response) => json(response, 200, manifestBody());
  /** One handler per download request, in order; past them, `recorded`. */
  downloads: Handler[] = [];
  job: Handler = (_request, response) => json(response, 200, settledJob());
  events: Handler = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(started() + settledFrame());
  };
  url = '';
  private server?: Server;

  async start(): Promise<this> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** Every request for the manifest or a download. */
  get artifactRequests(): Seen[] {
    return this.seen.filter((entry) => entry.url.includes('/artifacts'));
  }

  get downloadRequests(): Seen[] {
    return this.seen.filter((entry) => entry.url.includes('/artifacts/'));
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = request.url ?? '';
    this.seen.push({
      method: request.method ?? '',
      url,
      authorization: request.headers.authorization,
      acceptEncoding: request.headers['accept-encoding'] as string | undefined,
    });
    if (url === '/health') {
      json(response, 200, healthBody(this.capabilities));
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      json(response, 401, envelope('unauthorized'), { 'WWW-Authenticate': 'Bearer realm="nika"' });
      return;
    }
    const job = `/v1/jobs/${JOB}`;
    if (url === job) this.job(request, response);
    else if (url === `${job}/events`) this.events(request, response);
    else if (url === `${job}/artifacts`) this.manifest(request, response);
    else if (url.startsWith(`${job}/artifacts/`)) (this.downloads.shift() ?? recorded)(request, response);
    else json(response, 404, envelope('job_not_found'));
  }
}

let fake: FakeServe | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function serve(): Promise<FakeServe> {
  fake = await new FakeServe().start();
  return fake;
}

function client(overrides: Partial<NikaRemoteConfig> = {}): Nika {
  return new Nika({ url: fake!.url, token: TOKEN, allowInsecureHttp: true, ...overrides });
}

/** The settled job, through the one recovery door, its settlement already read. */
async function attached(overrides: Partial<NikaRemoteConfig> = {}): Promise<NikaRun> {
  const run = await client(overrides).attachRun(JOB);
  await run.result();
  return run;
}

async function chunks(stream: NikaArtifactDownload['stream']): Promise<Uint8Array[]> {
  const read: Uint8Array[] = [];
  for await (const chunk of stream) read.push(chunk);
  return read;
}

async function bytesOf(stream: NikaArtifactDownload['stream']): Promise<Buffer> {
  return Buffer.concat(await chunks(stream));
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a refusal');
}

describe('run.artifacts(): the settled job manifest', () => {
  it('lists what the job produced, bound to its receipt, its unknown keys read open', async () => {
    const server = await serve();
    server.manifest = (_request, response) => json(response, 200, manifestBody({
      later: { key: 'a later engine' },
      artifacts: [{ ...CHART, width: 640 }, IMAGE],
    }));
    const run = await attached();
    const manifest = await run.artifacts();
    expect(manifest).toEqual({
      receipt: RECEIPT,
      verdict: 'sealed',
      max_artifact_bytes: 268_435_456,
      truncated: false,
      later: { key: 'a later engine' },
      artifacts: [{ ...CHART, width: 640 }, IMAGE],
    });
    expect(Object.isFrozen(manifest.receipt)).toBe(true);
    expect(server.artifactRequests).toEqual([{
      method: 'GET', url: `/v1/jobs/${JOB}/artifacts`, authorization: `Bearer ${TOKEN}`,
      acceptEncoding: expect.any(String),
    }]);
  });

  it('binds the manifest to the durable record when the handle has not seen the settlement', async () => {
    const server = await serve();
    let records = 0;
    server.job = (_request, response) => {
      records += 1;
      // Running when attached; settled when the manifest is read.
      json(response, 200, records === 1 ? { id: JOB, status: 'running' } : settledJob());
    };
    let release!: () => void;
    const settles = new Promise<void>((resolve) => { release = resolve; });
    server.events = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(started());
      void settles.then(() => response.end(settledFrame()));
    };
    const run = await client().attachRun(JOB);
    const manifest = await run.artifacts();
    expect(manifest.receipt).toEqual(RECEIPT);
    expect(records).toBe(2);
    release();
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded', receipt: RECEIPT });
  });

  it("refuses a manifest whose receipt is not the job's", async () => {
    const server = await serve();
    server.manifest = (_request, response) => json(response, 200, manifestBody({
      receipt: { ...RECEIPT, chain_head: 'e'.repeat(64) },
    }));
    const run = await attached();
    const refused = await failure(run.artifacts());
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect(refused.message).toBe("Artifact manifest receipt is not the job's receipt");
  });

  it('refuses a manifest that breaks its contract, quoting no value', async () => {
    const server = await serve();
    const run = await attached();
    const { chain_head: _head, ...headless } = RECEIPT;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ receipt: undefined }, /omitted its receipt/],
      [{ receipt: headless }, /names no chain head/],
      [{ receipt: { ...RECEIPT, extra: 1 } }, /Receipt contained unknown fields/],
      [{ receipt: { ...RECEIPT, job_id: 'another-job' } }, /Receipt job identity/],
      [{ verdict: 7 }, /verdict/],
      [{ max_artifact_bytes: 0 }, /max_artifact_bytes/],
      [{ truncated: 'no' }, /truncated/],
      [{ artifacts: {} }, /artifacts was not an array/],
      [{ artifacts: [CHART, CHART] }, /named one artifact twice/],
      [{ artifacts: [{ ...CHART, sha256: CHART.sha256.toUpperCase() }] }, /entry 0 sha256/],
      [{ artifacts: [IMAGE, { ...CHART, size: -1 }] }, /entry 1 size/],
      [{ artifacts: [{ ...CHART, size: 1.5 }] }, /size/],
      [{ artifacts: [{ ...CHART, name: '' }] }, /name/],
      [{ artifacts: [{ ...CHART, mime: '' }] }, /mime/],
      [{ artifacts: [{ ...CHART, event_id: undefined }] }, /event_id/],
      [{ artifacts: [{ ...CHART, task: 3 }] }, /task/],
      [{ artifacts: [{ ...CHART, path: undefined }] }, /a file without its path/],
      [{ artifacts: [{ ...IMAGE, path: 'out/1.png' }] }, /an agent image with a path/],
      ...['../secret', '/etc/passwd', 'out//a.svg', 'out/./a.svg', 'out\\..\\a.svg', 'out/a\0.svg']
        .map((bad) => [{ artifacts: [{ ...CHART, path: bad }] }, /contained relative path/] as [
          Record<string, unknown>, RegExp,
        ]),
    ];
    for (const [overrides, message] of cases) {
      server.manifest = (_request, response) => json(response, 200, manifestBody(overrides));
      const refused = await failure(run.artifacts());
      expect(refused, JSON.stringify(overrides)).toBeInstanceOf(NikaProtocolError);
      expect(refused.message).toMatch(message);
      expect(refused.message).not.toContain('secret');
      expect(refused.message).not.toContain('passwd');
    }
  });

  it.each(MANIFEST_REFUSALS)('types the server refusal %i %s with its code', async (status, code) => {
    const server = await serve();
    server.manifest = refuse(status, code);
    const run = await attached();
    const refused = await failure(run.artifacts());
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({
      operation: 'artifacts',
      transport: 'http',
      code,
      machineCode: code,
      status,
      message: `HTTP ${status} for /v1/jobs/${JOB}/artifacts: ${code} (the server's ${code} refusal)`,
    });
  });

  it('refuses before any request on a server that does not list artifacts', async () => {
    const server = await serve();
    server.capabilities = ['check', 'executionSnapshot', 'eventStream', 'cancel'];
    const run = await attached();
    for (const attempt of [
      () => run.artifacts(),
      () => run.downloadArtifact(CHART.name),
      () => run.downloadArtifact(CHART),
      () => run.readArtifact(IMAGE.name),
    ]) {
      const refused = await failure(attempt());
      expect(refused).toBeInstanceOf(NikaCompatibilityError);
      expect(refused).toMatchObject({ capability: 'artifacts', transport: 'http' });
      expect(refused.message).toContain('does not advertise artifacts');
      expect(refused.message).toContain('Nothing was requested');
    }
    expect(server.artifactRequests).toEqual([]);
  });

  it('stops on the caller signal, typed', async () => {
    const server = await serve();
    server.manifest = () => {
      // Never answers: only the caller's signal ends the wait.
    };
    const run = await attached();
    const controller = new AbortController();
    const pending = run.artifacts({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error('the caller stopped')), 50);
    const refused = await failure(pending);
    expect(refused).toBeInstanceOf(NikaTransportError);
    expect(refused.message).toBe('artifacts() aborted by caller');
  });
});

describe.skipIf(!posix)('a local run', () => {
  it('has no artifact manifest: every artifact method is a typed gap', async () => {
    const run = await new Nika({ bin: NATIVE_FIXTURE }).run('wire-0119-hello.nika');
    for (const attempt of [
      () => run.artifacts(),
      () => run.downloadArtifact(CHART.name),
      () => run.readArtifact(CHART),
    ]) {
      const refused = await failure(attempt());
      expect(refused).toBeInstanceOf(NikaCompatibilityError);
      expect(refused).toMatchObject({ capability: 'artifacts', transport: 'native-process' });
      expect(refused.message).toContain('the local engine serves no artifact manifest');
    }
    await expect(run.result()).resolves.toMatchObject({ status: 'succeeded' });
  });
});

describe('run.downloadArtifact(): one artifact, proven', () => {
  it('streams the recorded bytes by name, its slashes sent as %2F, and closes once proven', async () => {
    const server = await serve();
    const run = await attached();
    const download = await run.downloadArtifact(CHART.name);
    expect(download).toMatchObject({
      name: CHART.name,
      size: SVG.length,
      sha256: CHART.sha256,
      mime: 'image/svg+xml',
      artifact: CHART,
    });
    expect((await bytesOf(download.stream)).equals(SVG)).toBe(true);
    expect(server.downloadRequests).toEqual([{
      method: 'GET',
      url: `/v1/jobs/${JOB}/artifacts/file%2Fout%2Ftotals.svg`,
      authorization: `Bearer ${TOKEN}`,
      acceptEncoding: 'identity',
    }]);
  });

  it('downloads an entry of the manifest without reading the manifest again', async () => {
    const server = await serve();
    const run = await attached();
    const manifest = await run.artifacts();
    const download = await run.downloadArtifact(manifest.artifacts[1]!);
    expect((await bytesOf(download.stream)).equals(PNG)).toBe(true);
    expect(server.artifactRequests.map((request) => request.url)).toEqual([
      `/v1/jobs/${JOB}/artifacts`,
      `/v1/jobs/${JOB}/artifacts/agent_image%2F1.png`,
    ]);
  });

  it('errors the stream for bytes that do not hash to the record, never releasing the last chunk', async () => {
    const server = await serve();
    server.downloads = [tampered];
    const run = await attached();
    const download = await run.downloadArtifact(IMAGE);
    const reader = download.stream.getReader();
    let delivered = 0;
    let refused: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        delivered += value.byteLength;
      }
    } catch (cause) {
      refused = cause;
    }
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect((refused as Error).message).toBe(
      `Artifact "agent_image/1.png": its ${PNG.length} bytes hash to ${sha256(flipLast(PNG))}, `
      + `not the recorded ${IMAGE.sha256}`,
    );
    expect(delivered).toBeLessThan(PNG.length);
    server.downloads = [tampered];
    await expect(run.readArtifact(CHART)).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('refuses a response whose headers contradict the manifest entry, before any byte', async () => {
    const server = await serve();
    const run = await attached();
    const cases: Array<[Handler, RegExp]> = [
      [headed({ 'Content-Length': String(SVG.length - 1) }), /answered \d+ bytes with SHA-256 .* its manifest entry records/],
      [headed({ 'Nika-Artifact-Sha256': 'a'.repeat(64) }), /answered \d+ bytes with SHA-256 a{64}, not/],
      [headed({}, ['Nika-Artifact-Sha256']), /omitted its Nika-Artifact-Sha256 digest/],
      [headed({ 'Nika-Artifact-Sha256': 'XYZ' }), /omitted its Nika-Artifact-Sha256 digest/],
      [headed({ 'Content-Encoding': 'gzip' }), /encoded the artifact \(Content-Encoding gzip\)/],
    ];
    for (const [handler, message] of cases) {
      server.downloads = [handler];
      const refused = await failure(run.downloadArtifact(CHART));
      expect(refused).toBeInstanceOf(NikaProtocolError);
      expect(refused.message).toMatch(message);
    }
  });

  it('downloads a body cut short again, and proves the whole', async () => {
    const server = await serve();
    server.downloads = [cutShort(30_000)];
    const run = await attached();
    const bytes = await run.readArtifact(IMAGE.name);
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    expect(server.downloadRequests).toHaveLength(2);
  });

  it('fails the stream with artifact_changed when the retry of a short body finds the file changed', async () => {
    const server = await serve();
    server.downloads = [cutShort(30_000), refuse(409, 'artifact_changed')];
    const run = await attached();
    const download = await run.downloadArtifact(IMAGE);
    const refused = await failure(bytesOf(download.stream));
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({
      operation: 'downloadArtifact',
      code: 'artifact_changed',
      machineCode: 'artifact_changed',
      status: 409,
    });
    expect(server.downloadRequests).toHaveLength(2);
  });

  it('gives up, typed, once every retry was cut short too', async () => {
    const server = await serve();
    server.downloads = [cutShort(10_000), cutShort(20_000), cutShort(30_000), cutShort(40_000)];
    const run = await attached();
    const refused = await failure(run.readArtifact(IMAGE));
    expect(refused).toBeInstanceOf(NikaTransportError);
    expect(refused).not.toBeInstanceOf(NikaProtocolError);
    expect(refused.message).toMatch(
      /^Artifact "agent_image\/1\.png" ended before its 70000 bytes on 4 attempts \(\d+ arrived\), so nothing was proven/,
    );
    expect(server.downloadRequests).toHaveLength(4);
  });

  it.each(DOWNLOAD_REFUSALS)('types the server refusal %i %s with its code', async (status, code) => {
    const server = await serve();
    server.downloads = [refuse(status, code)];
    const run = await attached();
    const refused = await failure(run.downloadArtifact(CHART));
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({
      operation: 'downloadArtifact',
      transport: 'http',
      code,
      machineCode: code,
      status,
    });
  });

  it("leaves a name the complete manifest does not list to the server's own 404", async () => {
    await serve();
    const run = await attached();
    const refused = await failure(run.downloadArtifact('file/out/missing.svg'));
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({ code: 'artifact_not_found', status: 404, operation: 'downloadArtifact' });
  });

  it('refuses bytes served for a name the complete manifest does not list', async () => {
    await serve();
    const run = await attached();
    const refused = await failure(run.downloadArtifact('file/out/unlisted.svg'));
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect(refused.message).toMatch(/served an artifact its complete manifest does not list/);
  });

  it('proves a name past a truncated manifest against the response headers alone', async () => {
    const server = await serve();
    server.manifest = (_request, response) => json(response, 200, manifestBody({ truncated: true }));
    const run = await attached();
    const download = await run.downloadArtifact('file/out/unlisted.svg');
    expect(download.artifact).toBeUndefined();
    expect(download).toMatchObject({
      name: 'file/out/unlisted.svg', size: SVG.length, sha256: sha256(SVG), mime: 'image/svg+xml',
    });
    expect((await bytesOf(download.stream)).equals(SVG)).toBe(true);
    // The headers bound it: a body other than they say still fails.
    server.downloads = [tampered];
    await expect(run.readArtifact('file/out/unlisted.svg')).rejects.toBeInstanceOf(NikaProtocolError);
  });

  it('is bounded by neither machineBufferBytes nor requestTimeout', async () => {
    const server = await serve();
    server.downloads = [(request, response) => {
      const file = addressed(request)!;
      // Headers after the request timeout, then the body over a second.
      setTimeout(() => {
        response.writeHead(200, artifactHeaders(file.bytes, file.mime));
        let sent = 0;
        const timer = setInterval(() => {
          const next = Math.min(sent + 10_000, file.bytes.length);
          response.write(file.bytes.subarray(sent, next));
          sent = next;
          if (sent === file.bytes.length) {
            clearInterval(timer);
            response.end();
          }
        }, 150);
      }, 700);
    }];
    const run = await attached({ machineBufferBytes: 4_096, requestTimeout: 500 });
    const bytes = await run.readArtifact(IMAGE);
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
  }, 10_000);

  it('stops on the caller signal mid-stream and ends the connection', async () => {
    const server = await serve();
    let closed!: Promise<void>;
    server.downloads = [(request, response) => {
      const file = addressed(request)!;
      closed = new Promise((resolve) => response.on('close', () => resolve()));
      response.writeHead(200, artifactHeaders(file.bytes, file.mime));
      response.write(file.bytes.subarray(0, 20_000));
      // The rest never comes.
    }];
    const run = await attached();
    const controller = new AbortController();
    const download = await run.downloadArtifact(IMAGE, { signal: controller.signal });
    const reading = failure(bytesOf(download.stream));
    await delay(50);
    controller.abort(new Error('the caller stopped'));
    const refused = await reading;
    expect(refused).toBeInstanceOf(NikaTransportError);
    expect(refused.message).toBe('downloadArtifact() aborted by caller');
    await closed;
  });

  it('ends the connection when the stream is cancelled', async () => {
    const server = await serve();
    let closed!: Promise<void>;
    server.downloads = [(request, response) => {
      const file = addressed(request)!;
      closed = new Promise((resolve) => response.on('close', () => resolve()));
      response.writeHead(200, artifactHeaders(file.bytes, file.mime));
      response.write(file.bytes.subarray(0, 20_000));
    }];
    const run = await attached();
    const download = await run.downloadArtifact(IMAGE);
    await download.stream.cancel();
    await closed;
  });

  it('proves a zero-byte artifact', async () => {
    const server = await serve();
    server.manifest = (_request, response) => json(response, 200, manifestBody({ artifacts: [BLANK] }));
    const run = await attached();
    const download = await run.downloadArtifact(BLANK.name);
    expect(download).toMatchObject({ size: 0, sha256: sha256(EMPTY) });
    expect(await chunks(download.stream)).toEqual([]);
    await expect(run.readArtifact(BLANK)).resolves.toEqual(new Uint8Array(0));
  });

  it('refuses a misuse before any request', async () => {
    const server = await serve();
    const run = await attached();
    for (const name of ['', 'file/a\0b', '.', '..', 'file/\ud800.svg']) {
      await expect(run.downloadArtifact(name)).rejects.toBeInstanceOf(TypeError);
    }
    for (const entry of [42, null, { name: CHART.name }, { ...CHART, sha256: 'nope' }, { ...CHART, size: -1 }]) {
      await expect(run.downloadArtifact(entry as unknown as NikaArtifact)).rejects.toBeInstanceOf(TypeError);
    }
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(run.readArtifact(CHART, { maxBytes })).rejects.toBeInstanceOf(RangeError);
    }
    expect(server.artifactRequests).toEqual([]);
  });
});

describe('run.readArtifact(): the whole bytes, bounded', () => {
  it('refuses a listed artifact larger than maxBytes before its download starts', async () => {
    const server = await serve();
    const run = await attached();
    const refused = await failure(run.readArtifact(IMAGE.name, { maxBytes: 1_000 }));
    expect(refused).toBeInstanceOf(NikaConfigurationError);
    expect(refused.message).toBe(
      `Artifact "agent_image/1.png" is ${PNG.length} bytes, more than readArtifact() holds `
      + `(maxBytes 1000): set maxBytes to at least ${PNG.length}, or stream it with `
      + 'downloadArtifact(). Nothing was downloaded',
    );
    expect(server.downloadRequests).toEqual([]);
  });

  it('holds 16 MiB by default', async () => {
    const server = await serve();
    const big = { ...IMAGE, name: 'agent_image/2.png', size: 16 * 1024 * 1024 + 1 };
    server.manifest = (_request, response) => json(response, 200, manifestBody({ artifacts: [big] }));
    const run = await attached();
    const refused = await failure(run.readArtifact(big.name));
    expect(refused).toBeInstanceOf(NikaConfigurationError);
    expect(refused.message).toContain('(maxBytes 16777216)');
    expect(server.downloadRequests).toEqual([]);
  });

  it('refuses an unlisted artifact past maxBytes from its Content-Length, before its body', async () => {
    const server = await serve();
    server.manifest = (_request, response) => json(response, 200, manifestBody({ truncated: true, artifacts: [] }));
    const run = await attached();
    const refused = await failure(run.readArtifact(IMAGE.name, { maxBytes: 1_000 }));
    expect(refused).toBeInstanceOf(NikaConfigurationError);
    expect(server.downloadRequests).toHaveLength(1);
  });
});

// ── Answers no server puts on the wire ─────────────────────────────────────

const REMOTE = 'https://nika.example';

/** A body that yields `parts`, then ends: closes, errors, or stays open until `close()`. */
function body(parts: Uint8Array[], end: 'close' | 'error' | 'hold' = 'close') {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts[index++];
      if (part) {
        controller.enqueue(part);
        return;
      }
      if (end === 'error') controller.error(new TypeError('terminated'));
      else if (end === 'hold') {
        await released;
        controller.close();
      } else controller.close();
    },
  });
  return { stream, release };
}

function artifactResponse(stream: ReadableStream<Uint8Array>, recordedBytes: Uint8Array): Response {
  return new Response(stream, { status: 200, headers: artifactHeaders(recordedBytes, 'image/png') });
}

/** An in-process server for the one job, whose downloads answer `downloads` in order. */
function injected(downloads: Response[]): { nika: Nika; downloads: () => number } {
  let served = 0;
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const job = `/v1/jobs/${JOB}`;
    if (url.pathname === '/health') {
      return Response.json(healthBody(['check', 'executionSnapshot', 'eventStream', 'artifacts']));
    }
    if (url.pathname === job) return Response.json(settledJob());
    if (url.pathname === `${job}/events`) {
      return new Response(started() + settledFrame(), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.pathname === `${job}/artifacts`) return Response.json(manifestBody());
    if (url.pathname.startsWith(`${job}/artifacts/`)) {
      served += 1;
      const next = downloads.shift();
      if (next) return next;
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return {
    nika: new Nika({ url: REMOTE, token: TOKEN, fetch: fetch as typeof globalThis.fetch }),
    downloads: () => served,
  };
}

describe('a verified stream, on answers no server puts on the wire', () => {
  it('holds the last chunk back until the body ends and the bytes are proven', async () => {
    const tail = body([PNG.subarray(0, 40_000), PNG.subarray(40_000)], 'hold');
    const { nika } = injected([artifactResponse(tail.stream, PNG)]);
    const run = await nika.attachRun(JOB);
    const download = await run.downloadArtifact(IMAGE);
    const reader = download.stream.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(40_000);
    // Every byte has arrived, but the body has not ended: nothing more is released.
    const last = reader.read();
    const early = await Promise.race([last.then(() => 'released'), delay(100).then(() => 'held')]);
    expect(early).toBe('held');
    tail.release();
    expect((await last).value?.byteLength).toBe(PNG.length - 40_000);
    expect((await reader.read()).done).toBe(true);
  });

  it('refuses a body that yields something other than bytes', async () => {
    const text = body(['not bytes' as unknown as Uint8Array]);
    const { nika } = injected([artifactResponse(text.stream, PNG)]);
    const run = await nika.attachRun(JOB);
    const refused = await failure(run.readArtifact(IMAGE));
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect(refused.message).toBe('Artifact "agent_image/1.png" arrived as something other than bytes');
  });

  it('refuses more bytes than the record', async () => {
    const longer = body([PNG, Buffer.from([1])]);
    const { nika } = injected([artifactResponse(longer.stream, PNG)]);
    const run = await nika.attachRun(JOB);
    const refused = await failure(run.readArtifact(IMAGE));
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect(refused.message).toBe(`Artifact "agent_image/1.png" sent more than its recorded ${PNG.length} bytes`);
  });

  it('treats a clean end before the recorded size as incomplete, and retries', async () => {
    const short = body([PNG.subarray(0, 30_000)]);
    const whole = body([PNG]);
    const served = injected([artifactResponse(short.stream, PNG), artifactResponse(whole.stream, PNG)]);
    const run = await served.nika.attachRun(JOB);
    expect(Buffer.from(await run.readArtifact(IMAGE)).equals(PNG)).toBe(true);
    expect(served.downloads()).toBe(2);
  });

  it('refuses a retry that resends other first bytes', async () => {
    const reset = body([PNG.subarray(0, 20_000), PNG.subarray(20_000, 30_000)], 'error');
    const other = Buffer.from(PNG);
    other[10]! ^= 0xff;
    const served = injected([
      artifactResponse(reset.stream, PNG),
      artifactResponse(body([other]).stream, PNG),
    ]);
    const run = await served.nika.attachRun(JOB);
    const refused = await failure(run.readArtifact(IMAGE));
    expect(refused).toBeInstanceOf(NikaProtocolError);
    expect(refused.message).toBe(
      'Artifact "agent_image/1.png": attempt 2 sent other bytes for the first 30000 bytes than '
      + 'the attempt before it',
    );
  });

  it('proves the bytes when only the end of a whole body was lost', async () => {
    const lost = body([PNG], 'error');
    const served = injected([artifactResponse(lost.stream, PNG)]);
    const run = await served.nika.attachRun(JOB);
    expect(Buffer.from(await run.readArtifact(IMAGE)).equals(PNG)).toBe(true);
    expect(served.downloads()).toBe(1);
  });
});

/** `bytes` with its last byte flipped, as `tampered` serves it. */
function flipLast(bytes: Buffer): Buffer {
  const other = Buffer.from(bytes);
  other[other.length - 1]! ^= 0xff;
  return other;
}
