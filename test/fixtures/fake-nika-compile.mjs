#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * A fake engine that speaks the compile wire (issue #128): `--sdk-identity`
 * advertises the `compile` capability and `compile --json` answers with the
 * versioned `compile_version: 1` envelope. `fake-nika.mjs` (no compile in its
 * capability list) stays the engine from before the door.
 *
 * Behaviors are keyed on the intent positional (after `--`) or, for EDIT, on
 * the `--change=` text. The happy paths replay the shape the pinned engine
 * emits (source: engine `crates/nika-cli-host/src/compile/render.rs` at
 * 21ff7d53); the `hostile-*` keys are SYNTHETIC — no engine was observed
 * behaving that way; they pin how the SDK fails typed.
 */

const argv = process.argv.slice(2);
function logInvocation() {
  if (process.env.NIKA_FAKE_PID_FILE) {
    writeFileSync(process.env.NIKA_FAKE_PID_FILE, String(process.pid));
  }
  if (process.env.NIKA_FAKE_ARGV_LOG) {
    appendFileSync(process.env.NIKA_FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
  }
}

const IDENTITY = {
  engineVersion: '0.120.0',
  machineProtocolVersion: 1,
  snapshotFormatVersion: 1,
  checkReportVersion: 1,
  eventFormatVersion: 1,
  traceFormatVersion: 2,
  supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'inputsLiteral', 'compile'],
};

const QUESTION = {
  key: 'const.request',
  label: 'What request should this workflow classify?',
  type: 'literal',
  why: 'The compiler cannot invent this authoring value.',
  mandatory: true,
};

const PROVENANCE = {
  compiler_version: '0.120.0',
  spec_pin: 'be8ff017d448c4d4e413d11c40613af0afb90754',
  skeleton: null,
  cognition: 'deterministicOnly',
};

function outcome(overrides, exitCode) {
  const payload = {
    compile_version: 1,
    status: 'incomplete',
    candidate: null,
    questions: [],
    diagnostics: [],
    requested_boundary: null,
    check_preview: null,
    provenance: PROVENANCE,
    written: null,
    ...overrides,
  };
  // Exit only after the write drains: process.exit can cut a large payload.
  process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(exitCode));
}

function failure(code, message, exitCode) {
  process.stdout.write(
    JSON.stringify({ compile_version: 1, error: { code, message } }) + '\n',
    () => process.exit(exitCode),
  );
}

function candidateFor(answerJson) {
  return [
    '# authored by the fixture engine',
    'nika: compiled-fixture',
    'schema: nika/v1',
    `const: { request: ${answerJson} }`,
    'tasks:',
    '  classify:',
    '    infer: Classify ${{ const.request }}',
    '',
  ].join('\n');
}

function sleepForever() {
  // Settled only by a signal, like an authoring call blocked on cognition.
  setTimeout(() => process.exit(0), 30_000);
}

async function compile() {
  const answers = new Map();
  let base;
  let change;
  let intent;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      intent = argv[i + 1] ?? '';
      break;
    } else if (arg.startsWith('--answer=')) {
      const pair = arg.slice('--answer='.length);
      const eq = pair.indexOf('=');
      answers.set(pair.slice(0, eq), pair.slice(eq + 1));
    } else if (arg === '--base') {
      base = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--change=')) {
      change = arg.slice('--change='.length);
    }
  }

  const key = change !== undefined ? change : (intent ?? '');

  if (key === 'hostile-wedged') process.on('SIGTERM', () => {});
  if (key === 'hostile-slow') process.on('SIGTERM', () => process.exit(130));
  // The log is the test's readiness handshake: PID and signal handlers exist.
  logInvocation();

  if (key === 'native-v2') {
    // Synthetic protocol double only: no provider was called or source authored.
    outcome(JSON.parse(readFileSync(new URL('./compile-v2.json', import.meta.url), 'utf8')), 2);
    return;
  }

  if (key === 'hostile-wedged') {
    // Ignores SIGTERM: only SIGKILL ends it. Pins the kill-grace escalation.
    sleepForever();
    return;
  }
  if (key === 'hostile-slow') {
    sleepForever();
    return;
  }
  if (key === 'hostile-self-kill') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (key === 'hostile-not-json') {
    process.stdout.write('this is not the compile wire\n');
    process.exit(2);
    return;
  }
  if (key === 'hostile-invalid-utf8') {
    // Otherwise valid ready JSON: accepting replacement characters would
    // silently change the candidate rather than refusing the broken wire.
    const payload = JSON.stringify({
      compile_version: 1, status: 'ready', candidate: 'INVALID_UTF8',
      questions: [], diagnostics: [], requested_boundary: null,
      check_preview: null, provenance: PROVENANCE, written: null,
    });
    const [before, after] = payload.split('INVALID_UTF8');
    process.stdout.write(Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]),
      () => process.exit(0));
    return;
  }
  if (key === 'hostile-wrong-version') {
    process.stdout.write(JSON.stringify({ compile_version: 3, status: 'ready' }) + '\n');
    process.exit(0);
    return;
  }
  if (key === 'hostile-object-version' || key === 'hostile-token-version') {
    process.stdout.write(JSON.stringify({
      compile_version: key === 'hostile-object-version' ? { toString: null } : 'p'.repeat(32),
      status: 'ready',
    }) + '\n');
    process.exit(0);
    return;
  }
  if (key === 'hostile-unknown-status') {
    outcome({ status: 'nearly' }, 2);
    return;
  }
  if (key === 'hostile-ready-exit-2') {
    outcome({ status: 'ready', candidate: candidateFor('null') }, 2);
    return;
  }
  if (key === 'hostile-ready-exit-1') {
    outcome({ status: 'ready', candidate: candidateFor('null') }, 1);
    return;
  }
  if (key === 'hostile-incomplete-exit-0') {
    outcome({ status: 'incomplete', questions: [QUESTION] }, 0);
    return;
  }
  if (key === 'hostile-ready-no-candidate') {
    outcome({ status: 'ready' }, 0);
    return;
  }
  if (key === 'hostile-writes-anyway') {
    outcome({ status: 'ready', candidate: candidateFor('null'), written: '/tmp/lie.nika' }, 0);
    return;
  }
  if (key === 'hostile-big') {
    outcome({ status: 'ready', candidate: `nika: big\n# ${'x'.repeat(9 * 1024 * 1024)}\n` }, 0);
    return;
  }
  if (key === 'hostile-error-exit-0') {
    process.stdout.write(JSON.stringify({
      compile_version: 1,
      error: { code: 'invalid_answer', message: '--answer expects KEY=JSON_LITERAL' },
    }) + '\n');
    process.exit(0);
    return;
  }
  if (key === 'hostile-error-exit-1') {
    failure('compile_error', 'machinery died after writing', 1);
    return;
  }

  if (change !== undefined) {
    // EDIT: echo proves the exact base bytes and change text that arrived.
    const baseBytes = readFileSync(base, 'utf8');
    outcome({
      status: 'ready',
      candidate: `${baseBytes}\n# applied change: ${change}\n`,
      diagnostics: [{
        kind: 'applied',
        target: 'const.request',
        message: `fixture applied: ${change}`,
      }],
    }, 0);
    return;
  }

  if (intent === 'refuse-me') {
    outcome({
      status: 'refused',
      candidate: null,
      diagnostics: [{
        kind: 'refused',
        target: 'intent',
        message: 'Literal-preservation policy cannot prove safe re-emission of this source.',
      }],
    }, 2);
    return;
  }
  if (intent === 'usage-error') {
    failure('invalid_answer', '--answer expects KEY=JSON_LITERAL', 2);
    return;
  }
  if (intent === 'env-error') {
    failure('read_base', 'No such file or directory', 3);
    return;
  }
  if (intent === 'classify-and-route' || intent === 'echo-answer') {
    const answer = answers.get('const.request');
    if (answer === undefined) {
      outcome({
        status: 'incomplete',
        candidate: candidateFor('null'),
        questions: [QUESTION],
      }, 2);
      return;
    }
    outcome({ status: 'ready', candidate: candidateFor(answer) }, 0);
    return;
  }
  // Unknown intent: incomplete with an unknown diagnostic, like the real core.
  outcome({
    status: 'incomplete',
    diagnostics: [{
      kind: 'unknown',
      target: 'intent',
      message: `Use an exact embedded skeleton name or hello. The requested intent remains unresolved: ${intent ?? ''}`,
    }],
  }, 2);
}

if (argv[0] === '--sdk-identity') {
  logInvocation();
  if (process.env.NIKA_FAKE_COMPILE_PROBE === 'slow') sleepForever();
  else process.stdout.write(`${JSON.stringify(IDENTITY)}\n`);
} else if (argv[0] === 'compile' && argv.includes('--json')) {
  await compile();
} else {
  process.stderr.write(`fake-nika-compile: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(3);
}
