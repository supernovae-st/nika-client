import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'nika-package-surface-'));
const consumer = path.join(scratch, 'consumer');
// The strict lifecycle application (issues #117 and #120) and the replaying
// engine the unit suite already drives it with. The app is compiled against
// the packed types; the packed faces then run the same lifecycle for real.
const lifecycleApp = path.join(root, 'test', 'fixtures', 'lifecycle-app.ts');
const replayEngine = path.join(root, 'test', 'fixtures', 'fake-nika.mjs');

try {
  run('npm', ['run', 'build'], { cwd: root });
  const packed = JSON.parse(run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    scratch,
  ], { cwd: root }).stdout);
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack returned no filename');

  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), '{"private":true}\n');
  run('npm', [
    'install',
    '--ignore-scripts',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    path.join(scratch, filename),
  ], { cwd: consumer });

  const expectedVersion = packed[0]?.version;
  if (typeof expectedVersion !== 'string') throw new Error('npm pack returned no version');
  const packageName = '@supernovae-st/nika';
  const commonJs = [
    `const sdk = require('${packageName}');`,
    `const manifest = require('${packageName}/package.json');`,
    `if (!sdk.Nika || typeof sdk.isNikaRunSucceeded !== 'function' || manifest.version !== '${expectedVersion}') process.exit(1);`,
  ].join(' ');
  run(process.execPath, ['--eval', commonJs], { cwd: consumer });

  const esm = [
    `import { Nika, isNikaRunSucceeded } from '${packageName}';`,
    `const manifest = await import('${packageName}/package.json', { with: { type: 'json' } });`,
    `if (!Nika || typeof isNikaRunSucceeded !== 'function' || manifest.default.version !== '${expectedVersion}') process.exit(1);`,
  ].join(' ');
  run(process.execPath, ['--input-type=module', '--eval', esm], { cwd: consumer });

  // The Run owns its lifecycle on both packed faces: extracted methods, the
  // lifecycle vocabulary with its protocol frame on `raw`, the `done` alias,
  // the deprecated protocol wrapper, and a human gate that waits. The engine
  // is the replaying fixture (measured wire bytes), so this needs POSIX exec.
  if (process.platform !== 'win32') {
    const lifecycle = [
      'async function lifecycle(Nika, isNikaRunSucceeded) {',
      `  const nika = new Nika({ bin: ${JSON.stringify(replayEngine)} });`,
      "  const run = await nika.run('wire-0119-hello.nika');",
      '  const { events, result } = run;',
      '  const kinds = [];',
      '  const protocol = [];',
      '  for await (const event of events()) {',
      '    kinds.push(event.kind);',
      '    protocol.push(event.raw.kind);',
      '  }',
      '  const settled = await result();',
      "  const lifecycleWords = 'run.started,task.scheduled,task.started,task.completed,engine.event,run.settled';",
      "  const protocolWords = 'workflow_started,task_scheduled,task_started,task_completed,workflow_completed,run_settled';",
      "  if (kinds.join() !== lifecycleWords) throw new Error('lifecycle kinds: ' + kinds.join());",
      "  if (protocol.join() !== protocolWords) throw new Error('raw kinds: ' + protocol.join());",
      "  if (!isNikaRunSucceeded(settled) || (await run.done) !== settled) throw new Error('result alias');",
      '  const legacy = [];',
      '  for await (const event of nika.events(run)) legacy.push(event.kind);',
      "  if (legacy.join() !== protocolWords) throw new Error('deprecated wrapper: ' + legacy.join());",
      "  const gate = await nika.run('wire-0118-human-gate.nika');",
      '  const gateKinds = [];',
      '  for await (const event of gate.events()) gateKinds.push(event.kind);',
      '  const held = await gate.result();',
      "  if (gateKinds.at(-1) !== 'run.waiting' || gateKinds.includes('run.settled')) {",
      "    throw new Error('waiting kinds: ' + gateKinds.join());",
      '  }',
      "  if (held.status !== 'paused' || isNikaRunSucceeded(held)) throw new Error('waiting result');",
      // Issue #122: the packed default replays the measured 90-task shape (273
      // frames) observed only after its result, and an explicit 256 keeps its
      // cap with a refusal that names the history, never a slow subscriber.
      "  const wide = await nika.run('wide90.nika.yaml');",
      '  const wideResult = await wide.result();',
      '  let replayed = 0;',
      '  for await (const event of wide.events()) replayed += event.raw ? 1 : 0;',
      "  if (replayed !== 3 * 90 + 3) throw new Error('late replay frames: ' + replayed);",
      "  if (!isNikaRunSucceeded(wideResult)) throw new Error('late replay result');",
      `  const capped = new Nika({ bin: ${JSON.stringify(replayEngine)}, eventBufferSize: 256 });`,
      "  const cappedRun = await capped.run('wide90.nika.yaml');",
      '  const cappedResult = await cappedRun.result();',
      '  let refused;',
      '  try { cappedRun.events(); } catch (cause) { refused = cause; }',
      "  if (refused?.name !== 'NikaEventBufferOverflowError' || refused.reason !== 'replay_truncated'",
      '    || refused.limit !== 256 || refused.observed !== 273 || refused.retained !== 256) {',
      "    throw new Error('explicit cap: ' + JSON.stringify({ ...refused, message: refused?.message }));",
      '  }',
      "  if (!isNikaRunSucceeded(cappedResult) || (await cappedRun.result()) !== cappedResult) {",
      "    throw new Error('a refused replay poisoned the result');",
      '  }',
      '}',
    ].join('\n');
    await writeFile(path.join(consumer, 'lifecycle.cjs'), [
      `const { Nika, isNikaRunSucceeded } = require('${packageName}');`,
      lifecycle,
      'lifecycle(Nika, isNikaRunSucceeded).catch((cause) => { console.error(cause); process.exit(1); });',
      '',
    ].join('\n'));
    await writeFile(path.join(consumer, 'lifecycle.mjs'), [
      `import { Nika, isNikaRunSucceeded } from '${packageName}';`,
      lifecycle,
      'await lifecycle(Nika, isNikaRunSucceeded);',
      '',
    ].join('\n'));
    run(process.execPath, ['lifecycle.cjs'], { cwd: consumer });
    run(process.execPath, ['lifecycle.mjs'], { cwd: consumer });
  }

  // The strict application itself, compiled against the packed types on both
  // module faces: only its import specifier changes.
  const appSource = (await readFile(lifecycleApp, 'utf8'))
    .replace("'../../src/index.js'", `'${packageName}'`);
  if (!appSource.includes(`from '${packageName}'`)) {
    throw new Error('lifecycle-app.ts no longer imports the SDK from ../../src/index.js');
  }
  await writeFile(path.join(consumer, 'lifecycle-app.mts'), appSource);
  await writeFile(path.join(consumer, 'lifecycle-app.cts'), appSource);

  const typedConsumer = [
    `import { Nika, isNikaRunSucceeded, type NikaConfig, type NikaRunResult } from '${packageName}';`,
    `import type { NikaEvent, NikaRun, NikaRunEvent, NikaRunEventKind } from '${packageName}';`,
    `import type { NikaEventBufferOverflowError } from '${packageName}';`,
    "const config: NikaConfig = { bin: '/tmp/nika' };",
    'const client: Nika = new Nika(config);',
    'void client;',
    'declare const owned: NikaRun<{ answer: number }>;',
    'const { events, result: readResult, status, cancel } = owned;',
    'const lifecycleView: AsyncIterable<NikaRunEvent<{ answer: number }>> = events();',
    'const settlement: Promise<NikaRunResult<{ answer: number }>> = readResult();',
    'const alias: Promise<NikaRunResult<{ answer: number }>> = owned.done;',
    'void lifecycleView; void settlement; void alias; void status; void cancel;',
    'declare const lifecycleEvent: NikaRunEvent<{ answer: number }>;',
    'const protocolFrame: NikaEvent<{ answer: number }> = lifecycleEvent.raw;',
    'void protocolFrame;',
    '// The deprecated wrapper still types the protocol stream for one train.',
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
    "const bare: NikaRun = { id: owned.id };",
    'void bare;',
    '// Issue #122: one overflow error, two refusals a strict consumer can tell apart.',
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
    '// @ts-expect-error a run need not have any workflow outputs',
    'result.outputs.answer;',
    'if (isNikaRunSucceeded(result)) {',
    "  const status: 'succeeded' = result.status;",
    '  const answer: number | undefined = result.outputs?.answer;',
    '  // @ts-expect-error the guard preserves the caller output type',
    '  const wrong: string = result.outputs?.answer;',
    '  // @ts-expect-error success does not fabricate an output map',
    '  result.outputs.answer;',
    '  void status; void answer; void wrong;',
    '}',
    "if (result.status === 'succeeded') {",
    '  const answer: number | undefined = result.outputs?.answer;',
    '  void answer;',
    '}',
    '',
  ].join('\n');
  await writeFile(path.join(consumer, 'consumer.mts'), typedConsumer);
  await writeFile(path.join(consumer, 'consumer.cts'), typedConsumer);
  run(process.execPath, [
    path.join(root, 'node_modules/typescript/bin/tsc'),
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--strict',
    '--noEmit',
    '--types',
    'node',
    '--typeRoots',
    path.join(root, 'node_modules/@types'),
    'consumer.mts',
    'consumer.cts',
    'lifecycle-app.mts',
    'lifecycle-app.cts',
  ], { cwd: consumer });

  process.stdout.write(
    `Packed ${packageName}@${expectedVersion} exposes typed ESM, CommonJS and package metadata\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function run(command, args, options) {
  const result = execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
  return { stdout: result };
}
