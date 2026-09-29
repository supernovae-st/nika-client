import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/verify-packed-module-surfaces.mjs', import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const engine = path.join(root, 'test', 'fixtures', 'fake-nika.mjs');
const packageName = '@supernovae-st/nika';
const posix = process.platform !== 'win32';

describe('packed Node consumer surfaces', () => {
  it('exports ESM, CommonJS and installed package metadata', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(script)], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(output).toContain('exposes typed ESM, CommonJS and package metadata');
  }, 120_000);

  // The run handle as 0.120.3 published it, driven for real on both packed
  // module faces (ported from that line's packed-consumer check): native runs
  // against the fixture engine, resident runs against an in-process `fetch`.
  it.skipIf(!posix)('carries the published run handle on the packed ESM and CommonJS faces', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'nika-run-handle-surface-'));
    try {
      const consumer = await packedConsumer(scratch);
      await writeFile(path.join(consumer, 'lifecycle.cjs'), [
        `const sdk = require('${packageName}');`,
        LIFECYCLE,
        'lifecycle(sdk, process.argv[2])',
        '  .then((report) => process.stdout.write(JSON.stringify(report)));',
        '',
      ].join('\n'));
      await writeFile(path.join(consumer, 'lifecycle.mjs'), [
        `import * as sdk from '${packageName}';`,
        LIFECYCLE,
        'process.stdout.write(JSON.stringify(await lifecycle(sdk, process.argv[2])));',
        '',
      ].join('\n'));
      for (const entry of ['lifecycle.cjs', 'lifecycle.mjs']) {
        const report = JSON.parse(run(process.execPath, [entry, engine], consumer));
        expect(report, entry).toEqual(EXPECTED_LIFECYCLE);
      }

      await writeFile(path.join(consumer, 'handle.mts'), TYPED_HANDLE);
      await writeFile(path.join(consumer, 'handle.cts'), TYPED_HANDLE);
      run(process.execPath, [
        path.join(root, 'node_modules/typescript/bin/tsc'),
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        '--target', 'ES2022',
        '--strict',
        '--noEmit',
        '--types', 'node',
        '--typeRoots', path.join(root, 'node_modules/@types'),
        'handle.mts',
        'handle.cts',
      ], consumer);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});

/** Builds and packs this tree into `scratch`, then installs it into a fresh consumer. */
async function packedConsumer(scratch: string): Promise<string> {
  // Other package tests build the repository dist concurrently: own both the
  // build output and the pack input.
  const packageRoot = path.join(scratch, 'package');
  const consumer = path.join(scratch, 'consumer');
  await mkdir(packageRoot);
  for (const file of ['package.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'docs', 'openapi.json']) {
    await cp(path.join(root, file), path.join(packageRoot, file), { recursive: true });
  }
  run('npm', ['run', 'build', '--', '--out-dir', path.join(packageRoot, 'dist')], root);
  const packed = JSON.parse(run('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', scratch,
  ], packageRoot)) as { filename?: unknown }[];
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  run('npm', [
    'install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund',
    '--package-lock=false', path.join(scratch, filename),
  ], consumer);
  return consumer;
}

function run(command: string, args: string[], cwd: string): string {
  const env = { ...process.env };
  delete env.NIKA_BIN;
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
}

/** One scenario, byte for byte the same on both faces; it returns what it saw. */
const LIFECYCLE = `
async function lifecycle(sdk, engine) {
  const { Nika, NikaEventBufferOverflowError, isNikaRunSucceeded } = sdk;
  const report = {};
  const nika = new Nika({ bin: engine });

  // The handle owns its lifecycle; extracted methods stay bound to the run.
  const run = await nika.run('settled.nika');
  report.keys = Object.keys(run).sort();
  report.frozen = Object.isFrozen(run);
  const { events, result } = run;
  report.kinds = [];
  report.protocol = [];
  for await (const event of events()) {
    report.kinds.push(event.kind);
    report.protocol.push(event.raw.kind);
  }
  const settled = await result();
  report.succeeded = isNikaRunSucceeded(settled);
  report.doneIsResult = run.result() === run.done && (await run.done) === settled;
  // The deprecated wrappers are views of the same session.
  report.legacy = [];
  for await (const event of nika.events(run)) report.legacy.push(event.kind);
  const cancellation = run.cancel();
  report.cancelShared = nika.cancel(run) === cancellation;
  report.cancel = (await cancellation).status;
  report.status = await run.status().then(() => 'invented', (error) => error.name);

  // An admitted failure is result data, never a thrown error.
  const failing = await nika.run('fields-failure.nika');
  const failed = await failing.result();
  report.failure = [failed.status, failed.error?.code, isNikaRunSucceeded(failed)];

  // A live view that fell behind fails typed; it names no history.
  const burst = await nika.run('burst.nika');
  const slow = burst.events({ bufferSize: 1 })[Symbol.asyncIterator]();
  await burst.result();
  const behind = await slow.next().then(() => slow.next()).catch((error) => error);
  report.live = [behind instanceof NikaEventBufferOverflowError, behind.reason, 'observed' in behind];

  // The resident face: a gate waits, a late view replays, an explicit cap refuses by name.
  // Only an explicit paused settlement ends a waiting observation.
  const frames = (count, last) => Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    kind: index === count - 1 ? 'execution.settled' : 'execution.started',
    status: index === count - 1 ? last : 'running',
    ...(index === count - 1 && last === 'paused'
      ? { settlement: { status: 'paused', cause: 'human_gate' } } : {}),
  }));
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const resident = (stream, extra = {}) => new Nika({
    url: 'https://nika.example',
    token: 'a'.repeat(32),
    bin: engine,
    ...extra,
    fetch: async (input) => {
      const route = new URL(String(input)).pathname;
      if (route === '/health') {
        return json({
          status: 'ok', service: 'nika-serve', engineVersion: '0.114.0',
          machineProtocolVersion: 1, snapshotFormatVersion: 1, checkReportVersion: 1,
          eventFormatVersion: 1, traceFormatVersion: 1,
          supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'cancel'],
        });
      }
      if (route === '/v1/jobs') return json({ id: 'job-1', status: 'queued' }, 202);
      if (route === '/v1/jobs/job-1/events') {
        const text = stream.map((frame) => 'id: ' + frame.sequence + '\\ndata: '
          + JSON.stringify(frame) + '\\n\\n').join('');
        return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('unexpected ' + route);
    },
  });
  const observed = async (view, total, probe) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        view.events({ bufferSize: probe });
      } catch (error) {
        if (error.observed === total) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('the session never observed ' + total + ' frames');
  };

  const gate = await resident(frames(2, 'paused')).run('flow.nika', { idempotencyKey: 'gate' });
  report.gate = [];
  for await (const event of gate.events()) report.gate.push(event.kind);
  const held = await gate.result();
  report.gateResult = [held.status, isNikaRunSucceeded(held)];

  const wide = await resident(frames(273, 'succeeded')).run('flow.nika', { idempotencyKey: 'wide' });
  const wideResult = await wide.result();
  await observed(wide, 273, 271);
  let replayed = 0;
  for await (const event of wide.events()) replayed += event.raw ? 1 : 0;
  report.replayed = [replayed, isNikaRunSucceeded(wideResult)];

  const capped = await resident(frames(273, 'succeeded'), { eventBufferSize: 256 })
    .run('flow.nika', { idempotencyKey: 'capped' });
  const cappedResult = await capped.result();
  await observed(capped, 273, 256);
  let refused;
  try {
    capped.events();
  } catch (error) {
    refused = error;
  }
  report.capped = {
    typed: refused instanceof NikaEventBufferOverflowError,
    reason: refused?.reason,
    limit: refused?.limit,
    observed: refused?.observed,
    retained: refused?.retained,
    resultKept: (await capped.result()) === cappedResult && isNikaRunSucceeded(cappedResult),
  };
  return report;
}
`;

const EXPECTED_LIFECYCLE = {
  keys: ['cancel', 'done', 'events', 'id', 'result', 'status'],
  frozen: true,
  kinds: ['run.started', 'task.completed', 'engine.event', 'run.settled'],
  protocol: ['workflow_started', 'task_completed', 'workflow_completed', 'run_settled'],
  succeeded: true,
  doneIsResult: true,
  legacy: ['workflow_started', 'task_completed', 'workflow_completed', 'run_settled'],
  cancelShared: true,
  cancel: 'already_settled',
  status: 'NikaCompatibilityError',
  failure: ['failed', 'NIKA-EXEC-001', false],
  live: [true, 'live_backpressure', false],
  gate: ['run.started', 'run.waiting'],
  gateResult: ['paused', false],
  replayed: [273, true],
  capped: {
    typed: true,
    reason: 'replay_truncated',
    limit: 256,
    observed: 273,
    retained: 256,
    resultKept: true,
  },
};

/** The published strict typed consumer's run-handle lines, compiled as .mts and as .cts. */
const TYPED_HANDLE = [
  `import { Nika, isNikaRunSucceeded, type NikaConfig, type NikaRunResult } from '${packageName}';`,
  `import type { NikaEvent, NikaRun, NikaRunEvent, NikaRunEventKind } from '${packageName}';`,
  `import type { NikaEventBufferOverflowError } from '${packageName}';`,
  "const config: NikaConfig = { bin: '/tmp/nika' };",
  'const client: Nika = new Nika(config);',
  'declare const owned: NikaRun<{ answer: number }>;',
  'const { events, result: readResult, status, cancel } = owned;',
  'const lifecycleView: AsyncIterable<NikaRunEvent<{ answer: number }>> = events();',
  'const settlement: Promise<NikaRunResult<{ answer: number }>> = readResult();',
  'const alias: Promise<NikaRunResult<{ answer: number }>> = owned.done;',
  'void lifecycleView; void settlement; void alias; void status; void cancel;',
  'declare const lifecycleEvent: NikaRunEvent<{ answer: number }>;',
  'const protocolFrame: NikaEvent<{ answer: number }> = lifecycleEvent.raw;',
  'void protocolFrame;',
  '// The deprecated wrapper still types the protocol stream.',
  'const protocolView: AsyncIterable<NikaEvent<{ answer: number }>> = client.events(owned);',
  'void protocolView;',
  '// @ts-expect-error a native protocol word is not a lifecycle kind',
  "const nativeWord: NikaRunEventKind = 'workflow_started';",
  '// @ts-expect-error a resident protocol word is not a lifecycle kind',
  "const residentWord: NikaRunEventKind = 'execution.started';",
  'void nativeWord; void residentWord;',
  '// @ts-expect-error the handle grows no proof, catalog, or authoring door',
  'owned.verify;',
  '// @ts-expect-error a bare id is no handle: recovery goes through attachRun',
  'const bare: NikaRun = { id: owned.id };',
  'void bare;',
  'declare const overflow: NikaEventBufferOverflowError;',
  "const why: 'live_backpressure' | 'replay_truncated' = overflow.reason;",
  'const seen: number | undefined = overflow.observed;',
  'const kept: number | undefined = overflow.retained;',
  'void why; void seen; void kept;',
  '// @ts-expect-error the reason is a closed pair, not any string',
  "const invented: typeof overflow.reason = 'dropped_silently';",
  'void invented;',
  'declare const result: NikaRunResult<{ answer: number }>;',
  '// @ts-expect-error an observation is not known to have succeeded',
  "const prematureSuccess: 'succeeded' = result.status;",
  'void prematureSuccess;',
  '// @ts-expect-error a run need not have any workflow outputs',
  'result.outputs.answer;',
  'if (isNikaRunSucceeded(result)) {',
  "  const settled: 'succeeded' = result.status;",
  '  const answer: number | undefined = result.outputs?.answer;',
  '  // @ts-expect-error the guard preserves the caller output type',
  '  const wrong: string = result.outputs?.answer;',
  '  void settled; void answer; void wrong;',
  '}',
  '',
].join('\n');
