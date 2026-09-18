import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const LITERAL_INPUTS_SCENARIO = 'literal-inputs-scenario.cjs';
const scratch = await mkdtemp(path.join(tmpdir(), 'nika-package-surface-'));
const consumer = path.join(scratch, 'consumer');

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

  const typedConsumer = [
    `import { Nika, isNikaRunSucceeded, type NikaConfig, type NikaRunOptions, type NikaRunResult } from '${packageName}';`,
    "const config: NikaConfig = { bin: '/tmp/nika' };",
    'const client: Nika = new Nika(config);',
    'void client;',
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
    argv: [['--sdk-identity'], ['run', 'echo-packed.nika.yaml', '--json', '--inputs-json', '-']],
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
      { path: '/v1/jobs', method: 'POST', body: `{"workflow":"triage.nika.yaml","inputs":${map}}` },
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
