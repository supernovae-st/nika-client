import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NikaEvent, NikaScheduleStatus } from '../../src/index.js';

export const HTTP_DEPTH_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-nika.mjs',
);

export const TOKEN_A = 'a'.repeat(32);
export const TOKEN_B = 'b'.repeat(32);

export function healthResponse(
  overrides: Record<string, unknown> = {},
  init: ResponseInit = {},
): Response {
  return jsonResponse({
    status: 'ok',
    service: 'nika-serve',
    engineVersion: '0.114.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 1,
    supportedCapabilities: [
      'check',
      'executionSnapshot',
      'eventStream',
      'trace',
      'cancel',
    ],
    ...overrides,
  }, init.status ?? 200, init.headers);
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function sseResponse(events: NikaEvent[]): Response {
  return sseText(events.map(sseFrame).join(''));
}

export function sseText(text: string, reset = false): Response {
  const bytes = new TextEncoder().encode(text);
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        if (!reset) controller.close();
        return;
      }
      controller.error(new TypeError('connection reset'));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

export function sseFrame(event: NikaEvent): string {
  return `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function controlledByteStream(): {
  response: Response;
  enqueue(text: string): void;
  close(): void;
  fail(error?: Error): void;
} {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    enqueue(text) {
      streamController.enqueue(new TextEncoder().encode(text));
    },
    close() {
      streamController.close();
    },
    fail(error = new TypeError('connection reset')) {
      streamController.error(error);
    },
  };
}

export function delayedJsonResponse(body: unknown, delayMilliseconds: number): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(bytes);
        controller.close();
      }, delayMilliseconds);
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function collect(events: AsyncIterable<NikaEvent>): Promise<NikaEvent[]> {
  const collected: NikaEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function scheduleStatus(
  revision: string,
  overrides: Record<string, unknown> = {},
): NikaScheduleStatus {
  return {
    definition: {
      id: 'daily',
      workflow: 'flow.nika.yaml',
      when: { kind: 'cadence', expression: 'daily at 09:00 Europe/Paris' },
      maxCostUsd: 0.25,
      missed: 'catch-up-once',
      maxLatenessSeconds: 3600,
      overlap: 'skip',
      afterSkip: 'next_slot',
      jitter: null,
      tolerance: null,
      active: true,
      pauseReason: null,
      pauseUntil: null,
    },
    origin: 'api',
    revision,
    active: true,
    pause: null,
    due: { kind: 'not_due' },
    next: [],
    earliestWakeHint: null,
    lastDecision: null,
    ...overrides,
  };
}

export function makeSnapshotFixture(fill: string): { bin: string; cleanup(): void } {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-sdk-http-depth-'));
  const bin = path.join(root, 'fake-nika.mjs');
  const digest = fill.repeat(64);
  const snapshot = JSON.stringify({
    format_version: 1,
    root: `${fill}.nika.yaml`,
    digest,
    units: [{ path: `${fill}.nika.yaml`, kind: 0, digest, bytes_hex: '00' }],
  });
  const script = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === '--sdk-identity') {
  console.log(JSON.stringify({engineVersion:'0.114.0',machineProtocolVersion:1,snapshotFormatVersion:1,checkReportVersion:1,eventFormatVersion:1,traceFormatVersion:1,supportedCapabilities:['check','executionSnapshot','eventStream','trace']}));
  process.exit(0);
}
if (argv[0] === 'check' && argv.includes('--sdk-snapshot')) {
  console.log(JSON.stringify({report_version:1,clean:true,engineVersion:'0.114.0',machineProtocolVersion:1,snapshotFormatVersion:1,checkReportVersion:1,eventFormatVersion:1,traceFormatVersion:1,supportedCapabilities:['check','executionSnapshot','eventStream','trace'],execution_snapshot:${JSON.stringify(snapshot)}}));
  process.exit(0);
}
process.exit(3);
`;
  writeFileSync(bin, script, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return {
    bin,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
