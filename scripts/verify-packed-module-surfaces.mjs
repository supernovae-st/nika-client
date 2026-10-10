import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    evidence: path.join(root, 'test/fixtures/compile-evidence/document-revision.json'),
    created: path.join(root, 'test/fixtures/compile-evidence/document-create.json'),
    recorded: path.join(root, 'test/fixtures/compile-evidence/recorded-fcdd44292'),
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

  // The documented compile example, verbatim from examples/: typechecked below
  // against the packed types, then run from the tarball against the fixture
  // engine (compile, answer from a JSON file, materialize, run).
  const COMPILE_EXAMPLE = 'compile-then-run.mts';
  await copyFile(path.join(root, 'examples', 'compile-then-run.ts'), path.join(consumer, COMPILE_EXAMPLE));
  if (process.platform !== 'win32') {
    const exampleLog = path.join(scratch, 'example.argv');
    await writeFile(path.join(consumer, 'answers.json'), '{"const.request":"An outage affects support customers."}\n');
    const exampleEnv = { ...consumerEnv, NIKA_BIN: path.join(root, 'test/fixtures/fake-nika-compile.mjs'),
      NIKA_FAKE_ARGV_LOG: exampleLog };
    const printed = run(process.execPath, [COMPILE_EXAMPLE, 'classify-and-route', 'answers.json', 'out/triage.nika'],
      { cwd: consumer, env: exampleEnv }).stdout;
    assertCompileExample(printed, await readFile(exampleLog, 'utf8'),
      await readFile(path.join(consumer, 'out', 'triage.nika'), 'utf8'));
    process.stdout.write(
      `Packed ${packageName}@${expectedVersion} runs examples/compile-then-run.ts: `
      + 'compile, answer from a file, materialize, run\n',
    );
  }

  const typedConsumer = [
    `import { Nika, isNikaRunSucceeded, type NikaConfig, type NikaRunOptions, type NikaRunResult } from '${packageName}';`,
    `import { isNikaCompileHeld, nextCompileRequest } from '${packageName}';`,
    `import type { NikaCompileOutcome, NikaCompileRequest, NikaCompileRefusalCode } from '${packageName}';`,
    `import type { NikaCompileAuthoringBackend, NikaCompileDocumentRevision, NikaCompileReuse } from '${packageName}';`,
    `import type { NikaCompileCreatedDocument, NikaCompileDocumentCreate } from '${packageName}';`,
    `import type { NikaAuthoringSession, NikaSessionResult, NikaSessionSnapshot } from '${packageName}';`,
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
    '// A destination is written only where a local request named one.',
    'const compileWritten: string | null | undefined = compileOutcome.written;',
    '// @ts-expect-error compile has no process exit code',
    'compileOutcome.exitCode;',
    'void compileReady; void compileSource; void compileWritten;',
    '// Generation 2: a provider round, its receipt, and the replay of a kept round.',
    'const compileGeneration: 1 | 2 = compileOutcome.compile_version;',
    'const compileCalls: number | undefined = compileOutcome.provenance.authoring?.calls;',
    'const compileToken: string | undefined = compileOutcome.replay_token;',
    'const compileJudgedServed: boolean | undefined = compileOutcome.judged_answer_round_available;',
    'void compileJudgedServed;',
    'const compileHeld: boolean = isNikaCompileHeld(compileOutcome);',
    'void compileGeneration; void compileCalls; void compileToken; void compileHeld;',
    '// NIK-17: revision, reuse and backend evidence is typed, optional and open.',
    'const evidenceRevision: NikaCompileDocumentRevision | undefined = compileOutcome.provenance.plan?.document_revision;',
    'const evidenceBase: string | undefined = evidenceRevision?.base_sha256;',
    'const evidenceBound: unknown = evidenceRevision?.components[0]?.bindings[0]?.bound;',
    'const evidenceHole: string | null | undefined = evidenceRevision?.components[0]?.bindings[0]?.hole;',
    'const evidenceReuse: NikaCompileReuse | undefined = compileOutcome.provenance.decision?.knowledge_qualification?.reuse;',
    'const evidenceUse: string | undefined = evidenceReuse?.references[0]?.use;',
    'const evidenceBackend: NikaCompileAuthoringBackend | null | undefined = compileOutcome.provenance.authoring?.backend;',
    'const evidenceServed: string | null | undefined = evidenceBackend?.served_model;',
    'const evidenceAdditive: unknown = evidenceBackend?.selection;',
    'void evidenceBase; void evidenceBound; void evidenceHole; void evidenceUse; void evidenceServed; void evidenceAdditive;',
    '// @ts-expect-error a digest is text, never a number',
    'const evidenceDigest: number | undefined = evidenceRevision?.candidate_sha256;',
    '// @ts-expect-error the count of responses that named no model is a number',
    'const evidenceUnreported: string | undefined = evidenceBackend?.unreported_models;',
    'void evidenceDigest; void evidenceUnreported;',
    '// NIK-17: a creation settles a typed, optional record; its base is null, never a program.',
    'const createdDocument: NikaCompileCreatedDocument | undefined = compileOutcome.provenance.plan?.document;',
    'const createdBase: string | null | undefined = createdDocument?.base_sha256;',
    'const createdMade: NikaCompileDocumentCreate | undefined = compileOutcome.provenance.decision?.document_create;',
    'const createdCandidate: string | null | undefined = createdMade?.candidate_sha256;',
    'void createdBase; void createdCandidate;',
    '// @ts-expect-error a settled record\'s version is a number',
    'const createdVersion: string | undefined = createdDocument?.version;',
    'void createdVersion;',
    '// NIK-17: the authoring Session handle; every line names the snapshot it answers.',
    'const sessionOpening: Promise<NikaAuthoringSession> = client.openSession();',
    'declare const authoring: NikaAuthoringSession;',
    'declare const shown: NikaSessionSnapshot;',
    "const sessionSubmitted: Promise<NikaSessionResult> = authoring.submit(shown, 'yes', { command: 'c-1' });",
    'const sessionWaiting: string = shown.work.waiting.kind;',
    'void sessionOpening; void sessionSubmitted; void sessionWaiting;',
    '// @ts-expect-error a line never goes without the snapshot it answers',
    "authoring.submit('yes');",
    '// NIK-17: the exact candidate bytes, the calls receipt and the configured intelligence are typed apart.',
    'const sessionContent: string | undefined = shown.work.candidate?.files[0]?.content;',
    'const sessionRequested: string | undefined = shown.work.authoring?.calls?.requested_model;',
    'const sessionUsage: number | null | undefined = shown.work.authoring?.calls?.input_tokens;',
    'const sessionAuthor: string | undefined = shown.work.intelligence?.author.kind;',
    'void sessionContent; void sessionRequested; void sessionUsage; void sessionAuthor;',
    '// @ts-expect-error a file witness is text, never bytes',
    'const sessionWitness: Uint8Array | undefined = shown.work.candidate?.files[0]?.bytes;',
    'void sessionWitness;',
    `const compileFresh: NikaCompileRequest = { intent: 'x', cognition: 'explicitProvider', limits: { max_calls: 6, deadline_ms: 60000 } };`,
    `const compileSeat: NikaCompileRequest = { intent: 'x', authoringModel: 'mistral/mistral-small-latest', fresh: true };`,
    `const compileRevision: NikaCompileRequest = { workflow: 'src', change: 'weekly', original_intent: 'x', cognition: 'explicitProvider' };`,
    `const compileNext: NikaCompileRequest = nextCompileRequest(compileFresh, compileOutcome, { 'const.audience': 'team' });`,
    `const compileReplay: NikaCompileRequest = nextCompileRequest(compileFresh, compileOutcome, {}, { cognition: 'deterministicOnly' });`,
    `const compileJudged: NikaCompileRequest = { intent: 'x', cognition: 'explicitProvider', replay_token: 'f'.repeat(64), limits: { max_calls: 2 } };`,
    'void compileReplay; void compileJudged;',
    '// @ts-expect-error the next round answers a kept round with one of the two wire cognitions',
    `nextCompileRequest(compileFresh, compileOutcome, {}, { cognition: 'judged' });`,
    "const compileRefusal: NikaCompileRefusalCode = 'compile_limit';",
    'void compileFresh; void compileSeat; void compileRevision; void compileNext; void compileRefusal;',
    '// @ts-expect-error workflow_id names a created workflow: never an edit',
    `const compileEditId: NikaCompileRequest = { workflow: 'src', change: 'c', workflow_id: 'w' };`,
    '// @ts-expect-error the wire knows two request cognitions',
    `const compileWord: NikaCompileRequest = { intent: 'x', cognition: 'implicitProvider' };`,
    '// @ts-expect-error a limit is a number of the wire, never text',
    `const compileLimit: NikaCompileRequest = { intent: 'x', cognition: 'explicitProvider', limits: { max_calls: '6' } };`,
    'void compileEditId; void compileWord; void compileLimit;',
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
    COMPILE_EXAMPLE,
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

  const REPLAY = '0123456789abcdef'.repeat(4);
  assert.deepEqual(report.generation2.round1, { version: 2, status: 'incomplete', token: true, calls: 2, held: false,
    judgedAvailable: true },
  say('a provider round reads generation 2 with its receipt, replay token and the judged round its server serves'));
  assert.deepEqual(report.generation2.round2, { version: 2, ready: true, calls: 1, token: false },
    say('the judged answer round has the replayed candidate judged, ready, with no authoring call'));
  assert.deepEqual(report.generation2.preview, { version: 1, status: 'incomplete', token: false },
    say('the zero-call replay binds the answers with no call and no judge'));
  assert.deepEqual(report.generation2.bodies, [
    { compile_version: 2, mode: 'create', cognition: 'explicitProvider', intent: 'Every morning, summarize ./inbox',
      limits: { max_calls: 6 } },
    { compile_version: 2, mode: 'create', cognition: 'explicitProvider', intent: 'Every morning, summarize ./inbox',
      answers: { 'const.audience': 'team' }, limits: { max_calls: 6 }, replay_token: REPLAY },
    { compile_version: 2, mode: 'create', cognition: 'deterministicOnly', intent: 'Every morning, summarize ./inbox',
      answers: { 'const.audience': 'team' }, replay_token: REPLAY },
  ], say('nextCompileRequest answers the kept round judged by default, zero-call on request'));
  const { message: unseatedMessage, ...unseated } = report.generation2Unseated;
  assert.deepEqual(unseated, {
    name: 'NikaCompatibilityError',
    capability: 'compileNativeV2',
    transport: 'http',
    ...typed('compatibility'),
  }, say('a resident without a native seat refuses a provider round after /health alone'));
  assert.match(unseatedMessage, /Nothing was posted/, say('the refusal says nothing was sent'));

  // NIK-17: a document revision's evidence (synthetic values, the engine's shapes).
  const evidence = JSON.parse(readFileSync(path.join(root, 'test/fixtures/compile-evidence/document-revision.json'), 'utf8'));
  const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const { malformedNative, malformedHttp, ...decoded } = report.evidence;
  assert.deepEqual(decoded, {
    candidateExact: true,
    revision: {
      mode: 'operations', base: digest(evidence.base), candidate: digest(evidence.document.candidate),
      changed: ['const.window_hours', 'const.max_age_hours', 'component block:notify-digest'], decisionSame: true,
      components: [
        { id: 'block:stock-window', release: 'foundry-2026.10.08',
          bindings: [['const.max_age_hours', 'const.max_age_hours', 48, 72], ['const.label', null, null, 'Relevé — semaine']],
          invocation: null, child: null },
        { id: 'block:notify-digest', release: 'foundry-2026.10.08',
          bindings: [['const.channel', 'const.channel', 'email', 'webhook']],
          invocation: { task: 'notify_digest', workflow: 'children/notify-digest.nika' },
          child: evidence.document.provenance.plan.document_revision.components[1].child.candidate_sha256 },
      ],
    },
    source: evidence.document.provenance.plan.source_revision,
    reuse: { counts: [1, 1, 0, 1, 1], uses: [['pattern:paginated-read', 'consulted'], ['block:stock-window', 'expanded'],
      ['block:notify-digest', 'invoked'], ['block:legacy-copy', 'absent'], [null, 'unreadable']] },
    backend: { requested: 'deepseek/deepseek-flash', decision: 'typesafe/jev', observed: ['deepseek-v4-flash'],
      unreported: 1, served: null, forwardedAbsent: true,
      selection: { role: 'author', scope: 'round', future: 'access-owner additive evidence' } },
  }, say('revision, component, reuse and backend evidence decode identically on both doors, null and absence kept apart'));
  for (const [door, refused, transport] of [['native', malformedNative, 'native-process'], ['HTTP', malformedHttp, 'http']]) {
    const { message, ...error } = refused;
    assert.deepEqual(error, { name: 'NikaProtocolError', transport, ...typed('protocol') },
      say(`${door}: malformed known evidence is a protocol fault`));
    assert.match(message, /document_revision\.base_sha256 is not a sha256 digest/, say(`${door}: the fault names its path`));
  }

  // NIK-17: a complete-document creation's evidence (synthetic values, the engine's shapes).
  const created = JSON.parse(readFileSync(path.join(root, 'test/fixtures/compile-evidence/document-create.json'), 'utf8'));
  const { malformedNative: createdNative, malformedHttp: createdHttp, ...creations } = report.created;
  assert.deepEqual(creations, {
    ready: { status: 'ready', candidateExact: true,
      settled: { version: 1, candidate: digest(created.ready.document.candidate), request: created.ready.intent,
        base: null, mode: 'composed', components: [{ id: 'block:stale-filter',
          bindings: [['const.threshold_hours', 24, 48], ['const.input_path', './in/rows.json', './in/tickets.json']] }] },
      made: { mode: 'composed', base: digest(created.ready.authored), candidate: digest(created.ready.document.candidate),
        operations: 3, reuse: [['block:stale-filter', 'expanded']] } },
    written: { status: 'ready', candidateExact: true,
      settled: { version: 1, candidate: digest(created.written.document.candidate), request: created.written.intent,
        base: null, mode: 'written', components: [] },
      made: { mode: 'written', base: null, candidate: digest(created.written.document.candidate), operations: 0,
        reuse: [] } },
    continuation: { status: 'incomplete', candidateExact: true, settled: null,
      made: { mode: 'written', base: null, candidate: null, operations: 0, reuse: [] } },
  }, say('a creation settles only when ready, and both doors decode its evidence identically'));
  for (const [door, refused, transport] of [['native', createdNative, 'native-process'], ['HTTP', createdHttp, 'http']]) {
    const { message, ...error } = refused;
    assert.deepEqual(error, { name: 'NikaProtocolError', transport, ...typed('protocol') },
      say(`${door}: a malformed settled creation record is a protocol fault`));
    assert.match(message, /plan\.document\.candidate_sha256 is not a sha256 digest/,
      say(`${door}: the creation fault names its path`));
  }

  // NIK-17: outcome documents the engine itself wrote, decoded alike on both doors.
  const recordedDir = path.join(root, 'test/fixtures/compile-evidence/recorded-fcdd44292');
  const recordedCandidate = (leg) => JSON.parse(readFileSync(path.join(recordedDir, `${leg}.outcome.json`), 'utf8'))
    .candidate;
  const createdSha = digest(recordedCandidate('edit-created'));
  assert.deepEqual(report.recorded, {
    'ready-composed': { status: 'ready', candidateExact: true, settled: digest(recordedCandidate('ready-composed')),
      revision: null },
    'ready-written': { status: 'ready', candidateExact: true, settled: digest(recordedCandidate('ready-written')),
      revision: null },
    continuation: { status: 'incomplete', candidateExact: true, settled: null, revision: null },
    'edit-created': { status: 'ready', candidateExact: true, settled: createdSha, revision: null },
    'edit-revised': { status: 'ready', candidateExact: true, settled: null,
      revision: { base: createdSha, candidate: digest(recordedCandidate('edit-revised')),
        rebound: [['block:stale-filter-report', 48, 72, createdSha]] } },
  }, say('the engine\'s recorded creation and revision outcomes decode alike on both doors, the receipt rebound 48 to 72'));
}

/**
 * What the documented compile example did from the packed package: one
 * deterministic incomplete round, the answer from the JSON file on the next
 * round's argv, the ready candidate written where it was told, then one run
 * of that file. The engine is the compile fixture; nothing else is spawned.
 */
function assertCompileExample(printed, argvLog, written) {
  const lines = printed.trim().split('\n');
  assert.deepEqual(lines.filter((line) => line.startsWith('compile · ')), [
    'compile · incomplete · generation 1 · no provider call',
    'compile · ready · generation 1 · no provider call',
  ], 'the example reports each compile round');
  assert.ok(lines.includes('? const.request · What request should this workflow classify?'),
    'the example shows the question it answers');
  assert.ok(lines.includes('event · run.settled · succeeded'), 'the example observes the run');
  assert.match(lines.at(-1), /^run · succeeded · outputs \{"source_bytes":\d+\}$/, 'the example reads the result');
  const argvs = argvLog.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(argvs.slice(0, 3), [
    ['--sdk-identity'],
    ['compile', '--json', '--', 'classify-and-route'],
    ['compile', '--json', '--answer=const.request="An outage affects support customers."', '--', 'classify-and-route'],
  ], 'the answer from the file rides the next round once');
  assert.equal(argvs.length, 4, 'compile twice, then run once');
  assert.equal(argvs[3][0], 'run');
  assert.match(argvs[3][1], /\/out\/triage\.nika$/, 'run() receives the materialized candidate');
  assert.equal(argvs[3][2], '--json');
  assert.match(written, /const: \{ request: "An outage affects support customers\." \}/,
    'the written file is the ready candidate');
}
