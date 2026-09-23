import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const LITERAL_INPUTS_SCENARIO = 'literal-inputs-scenario.cjs';
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
      "  const wide = await nika.run('wide90.nika');",
      '  const wideResult = await wide.result();',
      '  let replayed = 0;',
      '  for await (const event of wide.events()) replayed += event.raw ? 1 : 0;',
      "  if (replayed !== 3 * 90 + 3) throw new Error('late replay frames: ' + replayed);",
      "  if (!isNikaRunSucceeded(wideResult)) throw new Error('late replay result');",
      `  const capped = new Nika({ bin: ${JSON.stringify(replayEngine)}, eventBufferSize: 256 });`,
      "  const cappedRun = await capped.run('wide90.nika');",
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

  // Issue #116: literal inputs from the packed package, once per module system.
  // The engines are fixtures: one advertises the literal channel, one predates it.
  const engines = JSON.stringify({
    literal: path.join(root, 'test/fixtures/fake-nika-inputs.mjs'),
    old: path.join(root, 'test/fixtures/fake-nika.mjs'),
  });
  await copyFile(
    path.join(root, 'scripts/packed-consumers', LITERAL_INPUTS_SCENARIO),
    path.join(consumer, LITERAL_INPUTS_SCENARIO),
  );
  await writeFile(path.join(consumer, 'literal-inputs.cjs'), [
    `const sdk = require('${packageName}');`,
    `const scenario = require('./${LITERAL_INPUTS_SCENARIO}');`,
    'scenario(sdk, JSON.parse(process.argv[2]))',
    '  .then((report) => process.stdout.write(JSON.stringify(report)));',
    '',
  ].join('\n'));
  await writeFile(path.join(consumer, 'literal-inputs.mjs'), [
    `import * as sdk from '${packageName}';`,
    `import scenario from './${LITERAL_INPUTS_SCENARIO}';`,
    'process.stdout.write(JSON.stringify(await scenario(sdk, JSON.parse(process.argv[2]))));',
    '',
  ].join('\n'));
  const consumerEnv = { ...process.env };
  delete consumerEnv.NIKA_BIN;
  delete consumerEnv.NIKA_FAKE_ARGV_LOG;
  for (const [moduleSystem, entry] of [['CommonJS', 'literal-inputs.cjs'], ['ESM', 'literal-inputs.mjs']]) {
    const report = JSON.parse(
      run(process.execPath, [entry, engines], { cwd: consumer, env: consumerEnv }).stdout,
    );
    assertLiteralInputs(report, moduleSystem);
    process.stdout.write(
      `Packed ${packageName}@${expectedVersion} binds literal inputs from ${moduleSystem} `
      + 'over native stdin and HTTP\n',
    );
  }

  // Issue #128: compile from the packed package, once per module system. The
  // engines are fixtures: one advertises the compile capability, one predates
  // it. The resident has no authoring door (engine nika#1670).
  const COMPILE_SCENARIO = 'compile-scenario.cjs';
  const compileEngines = JSON.stringify({
    compile: path.join(root, 'test/fixtures/fake-nika-compile.mjs'),
    old: path.join(root, 'test/fixtures/fake-nika.mjs'),
  });
  await copyFile(
    path.join(root, 'scripts/packed-consumers', COMPILE_SCENARIO),
    path.join(consumer, COMPILE_SCENARIO),
  );
  await writeFile(path.join(consumer, 'compile.cjs'), [
    `const sdk = require('${packageName}');`,
    `const scenario = require('./${COMPILE_SCENARIO}');`,
    'scenario(sdk, JSON.parse(process.argv[2]))',
    '  .then((report) => process.stdout.write(JSON.stringify(report)));',
    '',
  ].join('\n'));
  await writeFile(path.join(consumer, 'compile.mjs'), [
    `import * as sdk from '${packageName}';`,
    `import scenario from './${COMPILE_SCENARIO}';`,
    'process.stdout.write(JSON.stringify(await scenario(sdk, JSON.parse(process.argv[2]))));',
    '',
  ].join('\n'));
  for (const [moduleSystem, entry] of [['CommonJS', 'compile.cjs'], ['ESM', 'compile.mjs']]) {
    const report = JSON.parse(
      run(process.execPath, [entry, compileEngines], { cwd: consumer, env: consumerEnv }).stdout,
    );
    assertCompile(report, moduleSystem);
    process.stdout.write(
      `Packed ${packageName}@${expectedVersion} compiles from ${moduleSystem} `
      + 'over native and authenticated HTTP compile; old doors refuse typed\n',
    );
  }

  const typedConsumer = [
    `import { Nika, isNikaRunSucceeded, type NikaConfig, type NikaRunOptions, type NikaRunResult } from '${packageName}';`,
    `import type { NikaCompileOutcome, NikaCompileRequest } from '${packageName}';`,
    `import type { NikaCompileAuthoringOptions, NikaCompileAuthoringReceipt, NikaCompileKnowledge, NikaCompileTrigger } from '${packageName}';`,
    `import type { NikaEvent, NikaJournalEvidence, NikaRun, NikaRunEvent, NikaRunEventKind } from '${packageName}';`,
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
    "const literal: NikaRunOptions = { inputs: { ticketId: '42', count: 42, tags: ['a'], record: { name: null } } };",
    "const legacy: NikaRunOptions = { vars: { locale: 'fr-FR' } };",
    '// @ts-expect-error inputs is a map of declared input names, never a scalar',
    "const scalar: NikaRunOptions = { inputs: 'ticketId=42' };",
    '// @ts-expect-error a present null is not an absent map',
    'const absent: NikaRunOptions = { inputs: null };',
    '// @ts-expect-error the deprecated vars alias carries scalars only',
    "const nested: NikaRunOptions = { vars: { record: { name: 'x' } } };",
    'void literal; void legacy; void scalar; void absent; void nested;',
    'declare const result: NikaRunResult<{ answer: number }>;',
    '// Journal evidence is the engine\'s closed contract, and optional on a result.',
    'const lost: NikaJournalEvidence | undefined = result.evidence;',
    "const known: NikaJournalEvidence = { status: 'mirror_lost', reason: 'record_refused' };",
    '// @ts-expect-error the contract closes the vocabulary: an unknown reason is no evidence',
    "const unknownReason: NikaJournalEvidence = { status: 'mirror_lost', reason: 'disk_full' };",
    '// @ts-expect-error and an unknown status is none either',
    "const unknownStatus: NikaJournalEvidence = { status: 'mirror_ok', reason: 'write_failed' };",
    'void lost; void known; void unknownReason; void unknownStatus;',
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
    '// Issue #128: the compile surface is typed, narrow and source-only.',
    'declare const compileOutcome: NikaCompileOutcome;',
    'const compileReady: boolean = compileOutcome.ready;',
    'const compileSource: string | null = compileOutcome.candidate;',
    '// @ts-expect-error compile has no process-only fields',
    'compileOutcome.written;',
    '// @ts-expect-error compile has no process-only fields',
    'compileOutcome.exitCode;',
    'void compileReady; void compileSource;',
    `const compileCreate: NikaCompileRequest = { intent: 'x', answers: { 'const.request': 42 } };`,
    `const compileEdit: NikaCompileRequest = { workflow: 'src', change: 'c' };`,
    `const compileConstant: NikaCompileRequest = { workflow: 'src', change: { set_constant: { name: 'request', value: null } } };`,
    'void compileCreate; void compileEdit; void compileConstant;',
    '// @ts-expect-error create and edit never mix in one request',
    `const compileMixed: NikaCompileRequest = { intent: 'x', workflow: 'w', change: 'c' };`,
    'void compileMixed;',
    '// @ts-expect-error the first slice has no destination/materialization field',
    `const compileDest: NikaCompileRequest = { intent: 'x', dest: 'f.nika' };`,
    'void compileDest;',
    `const compilePromise: Promise<NikaCompileOutcome> = client.compile('x');`,
    'void compilePromise;',
    "const knowledge: NikaCompileKnowledge = { snapshot: './knowledge', excludeCorpus: 'held-out' };",
    "const authoring: NikaCompileAuthoringOptions = { model: 'provider/model', strategy: 'only', repairs: 2, maxTokens: 8192, timeoutSeconds: 120, knowledge };",
    "void client.compile({ workflow: 'source', change: 'change', originalIntent: 'original', answers: { 'stable.key': 'value' } }, { authoring });",
    "void client.compile('intent', { authoring: { model: 'provider/model', knowledge: { pack: './request.json' } } });",
    'const generation: 1 | 2 = compileOutcome.compile_version;',
    'const receipt: NikaCompileAuthoringReceipt | undefined = compileOutcome.provenance.authoring;',
    'const trigger: NikaCompileTrigger | null | undefined = compileOutcome.requested_trigger;',
    'const inputTokens: number | null | undefined = receipt?.input_tokens;',
    'const backend: unknown = receipt?.backend;',
    'void generation; void trigger; void inputTokens; void backend;',
    '// @ts-expect-error authoring always needs an explicit model',
    "void client.compile('intent', { authoring: { strategy: 'only' } });",
    '// @ts-expect-error snapshot and pack are mutually exclusive',
    "const mixedKnowledge: NikaCompileKnowledge = { snapshot: 'x', pack: 'y' };",
    '// @ts-expect-error corpus exclusion belongs to snapshot composition only',
    "const excludedPack: NikaCompileKnowledge = { pack: 'x', excludeCorpus: 'y' };",
    '// @ts-expect-error original intent belongs to revisions only',
    "const createOriginal: NikaCompileRequest = { intent: 'new', originalIntent: 'old' };",
    'void mixedKnowledge; void excludedPack; void createOriginal;',
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

/**
 * What one packed consumer observed (issue #116). On strict JSON the SDK's
 * serializer agrees with JSON.stringify byte for byte, so the expected map
 * bytes are spelled here without importing anything from the package.
 */
function assertLiteralInputs(report, moduleSystem) {
  const inputs = {
    ticket: '@env:SERVER_SECRET',
    expression: '${{ tasks.x.output }}',
    numeral: '42',
    count: 42,
    tags: ['é', '東京'],
    record: { name: '🦋', nothing: null },
  };
  const map = JSON.stringify(inputs);
  const typed = (kind) => ({
    compatibility: kind === 'compatibility',
    configuration: kind === 'configuration',
    nikaError: true,
  });
  const say = (what) => `${moduleSystem}: ${what}`;

  assert.deepEqual(report.native, {
    status: 'succeeded',
    succeeded: true,
    argv: [['--sdk-identity'], ['run', 'echo-packed.nika', '--json', '--inputs-json', '-']],
    stdin: map,
  }, say('native run writes the map to stdin and only names the channel in argv'));

  const { message: oldEngineMessage, ...oldEngine } = report.oldEngine;
  assert.deepEqual(oldEngine, {
    name: 'NikaCompatibilityError',
    capability: 'inputsLiteral',
    transport: 'native-process',
    ...typed('compatibility'),
    argv: [['--sdk-identity']],
  }, say('an engine without inputsLiteral is refused before any run, with no --var fallback'));
  assert.match(oldEngineMessage, /does not advertise inputsLiteral \(advertised: check, /);

  for (const [name, pattern] of [
    ['conflict', /inputs and the deprecated vars alias cannot be combined/],
    ['undefinedValue', /inputs\.a\.b is undefined/],
    ['bigint', /inputs\.a is a bigint/],
  ]) {
    // A configuration refusal names no capability or transport: the report is
    // JSON, so those absent fields are absent here too.
    const { message, ...refused } = report[name];
    assert.deepEqual(refused, {
      name: 'NikaConfigurationError',
      ...typed('configuration'),
    }, say(`${name} is a typed configuration refusal`));
    assert.match(message, pattern, say(`${name} names what was refused`));
  }
  assert.deepEqual(report.silentArgv, [], say('a refused map never spawns the engine'));

  assert.deepEqual(report.http, {
    status: 'succeeded',
    requests: [
      { path: '/health', method: 'GET', body: null },
      { path: '/v1/jobs', method: 'POST', body: `{"workflow":"triage.nika","inputs":${map}}` },
      { path: '/v1/jobs/job-1/events', method: 'GET', body: null },
    ],
  }, say('HTTP posts the same map bytes as JobByName.inputs'));

  const { message: oldResidentMessage, ...oldResident } = report.oldResident;
  assert.deepEqual(oldResident, {
    name: 'NikaCompatibilityError',
    capability: 'jobInputs',
    transport: 'http',
    ...typed('compatibility'),
    requests: [{ path: '/health', method: 'GET', body: null }],
  }, say('a resident without jobInputs is refused after /health alone'));
  assert.match(oldResidentMessage, /does not advertise jobInputs/);

  const { message: snapshotMessage, ...snapshot } = report.snapshot;
  assert.deepEqual(snapshot, {
    name: 'NikaCompatibilityError',
    capability: 'snapshotInputs',
    transport: 'http',
    ...typed('compatibility'),
    requests: [],
  }, say('a snapshot takes no input overlay and nothing is sent'));
  assert.match(snapshotMessage, /served name/);
}

/**
 * What one packed consumer observed (issue #128). The compile fixture replays
 * the wire shape of the pinned engine render layer; the expected argv bytes
 * are spelled here without importing anything from the package.
 */
function assertCompile(report, moduleSystem) {
  const typed = (kind) => ({
    compatibility: kind === 'compatibility',
    configuration: kind === 'configuration',
    protocol: kind === 'protocol',
    credentialVisible: false,
    nikaError: true,
  });
  const say = (what) => `${moduleSystem}: ${what}`;

  assert.deepEqual(report.ready, {
    status: 'ready',
    ready: true,
    processFieldsAbsent: true,
    cognition: 'deterministicOnly',
    candidateHasAnswer: true,
    argv: [
      ['--sdk-identity'],
      ['compile', '--json', '--answer=const.request="Reroute 雪 \\"quoted\\" tickets"', '--', 'classify-and-route'],
    ],
  }, say('a ready compile preserves the engine outcome and serializes the answer exactly once'));

  assert.deepEqual(report.incomplete, {
    status: 'incomplete',
    ready: false,
    questionKey: 'const.request',
    mandatory: true,
  }, say('incomplete is data: the question rides the outcome, exit 2'));

  assert.equal(report.edit.status, 'ready', say('edit resolves'));
  assert.equal(report.edit.candidateKeepsBase, true, say('edit preserves the base bytes'));
  assert.equal(report.edit.scratchRemoved, true, say('the edit scratch dir is removed'));
  assert.equal(report.edit.scratchName, 'base.nika', say('temporary source uses the canonical suffix'));
  assert.equal(report.edit.argv[0], 'compile', say('edit spawns compile'));
  assert.ok(report.edit.argv.includes('--json'), say('edit asks the machine wire'));

  const { message: oldEngineMessage, ...oldEngine } = report.oldEngine;
  assert.deepEqual(oldEngine, {
    name: 'NikaCompatibilityError',
    capability: 'compile',
    transport: 'native-process',
    ...typed('compatibility'),
    argv: [['--sdk-identity']],
  }, say('an engine without the compile capability is refused after the probe alone'));
  assert.match(oldEngineMessage, /does not advertise compile/, say('the refusal names the capability'));

  const { message: mixedMessage, ...mixed } = report.mixed;
  assert.deepEqual(mixed, {
    name: 'NikaConfigurationError',
    ...typed('configuration'),
  }, say('a mixed-shape request is a configuration refusal, not a silent mode pick'));
  assert.match(mixedMessage, /never mixes/, say('the refusal names the ambiguity'));
  const { message: badAnswerMessage, ...badAnswer } = report.badAnswer;
  assert.deepEqual(badAnswer, {
    name: 'NikaConfigurationError',
    ...typed('configuration'),
  }, say('an ambiguous answer key is a configuration refusal'));
  assert.match(badAnswerMessage, /question key/, say('the refusal names the key law'));
  assert.deepEqual(report.silentArgv, [], say('a refused request never spawns the engine'));

  const { message: httpMessage, ...http } = report.http;
  assert.deepEqual(http, {
    name: 'NikaCompatibilityError',
    capability: 'compile',
    transport: 'http',
    ...typed('compatibility'),
    requests: [{ path: '/health', method: 'GET', body: null }],
    argv: [],
  }, say('HTTP compile typed-refuses after /health alone: nothing posted, nothing local'));
  assert.match(httpMessage, /never compiles locally/, say('no local fallback is promised'));
  assert.equal(report.httpSuccess.sameOutcome, true, say('HTTP and native share the authoring outcome'));
  assert.deepEqual(report.httpSuccess.argv, [], say('HTTP success spawns no local engine'));
  assert.deepEqual(report.httpSuccess.request, { compile_version: 1, mode: 'edit',
    source: 'nika: packed\nconst: { request: "é" }\n',
    change: { set_constant: { name: 'request', value: ['雪', null, true, 1.25] } } },
  say('HTTP structured edits use the accepted wire'));

}
