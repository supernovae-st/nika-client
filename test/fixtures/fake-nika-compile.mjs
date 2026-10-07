#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * A fake engine that speaks the compile wire (issue #128): `--sdk-identity`
 * advertises the `compile` capability and `compile --json` answers with the
 * versioned compile envelope. `fake-nika.mjs` (no compile in its capability
 * list) stays the engine from before the door.
 *
 * Behaviors are keyed on the intent positional (after `--`) or, for EDIT, on
 * the `--change=` text. The happy paths replay the shape the engine emits
 * (sources: engine `crates/nika-cli-host/src/compile/render.rs` at 21ff7d53
 * for generation 1; `crates/nika-compile/src/wire.rs::outcome_document` and
 * `crates/nika-cli-host/src/compile.rs::CompileArgs` on the 0.123 integration
 * line for generation 2, the CLI flags and the CLI-only fields). The field
 * VALUES of the generation-2 shapes are SYNTHETIC (no live provider round was
 * recorded); the `hostile-*` keys are SYNTHETIC too — no engine was observed
 * behaving that way; they pin how the SDK fails typed.
 *
 * Like clap, an argument this CLI does not declare is refused on stderr with
 * exit 2 and no machine document. `run <file> --json` answers a minimal
 * admitted run (workflow_started, run_settled) so a compiled candidate can be
 * run end to end.
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

/** A choice question, as `outcome_document` prints one (options only when non-empty). */
const CHOICE = {
  key: 'const.audience',
  label: 'Who reads the digest?',
  type: 'choice',
  why: 'The request names two readers; the compiler never picks one for you.',
  mandatory: true,
  options: [
    { key: 'team', label: 'The whole team' },
    { key: 'lead', label: 'The team lead only' },
  ],
};

/** `trigger_document`: every field, nullable when unread. */
const TRIGGER = {
  kind: 'schedule',
  source_hint: 'every morning at 9',
  event_hint: null,
  cadence: 'daily',
  cron: '0 9 * * *',
  at: '09:00',
  payload_input: null,
  status: 'requires_binding',
  timezone: null,
  missed: null,
  overlap: null,
  ceiling: null,
};

function receipt(model) {
  return {
    model,
    calls: 2,
    input_tokens: 1840,
    output_tokens: 912,
    elapsed_ms: 2310,
    sampling: { temperature: null, seed: null, effective: 'providerDefaultUnknown' },
    context: [
      { role: 'author', instruction_sha256: 'a'.repeat(64), message_bytes: 4096 },
      { role: 'judge_request', instruction_sha256: 'b'.repeat(64), message_bytes: 2048 },
    ],
    backend: {
      kind: 'direct',
      provider: model.split('/')[0],
      requested_model: model,
      observed_models: [model.split('/')[1]],
      unreported_models: 0,
      usage_complete: true,
      cost_basis: 'unpriced; billing_unverified',
      authority: { max_calls: null, source: 'continuous preparation: no request count',
        invocations: { sent: 2, refused: 0 } },
    },
  };
}

function nativeProvenance(model, overrides = {}) {
  return {
    ...PROVENANCE,
    cognition: 'explicitProvider',
    suggested_file: 'morning-digest.nika',
    strategy: 'native',
    plan: { semantic_record: { request: 'digest' } },
    decision: { route: ['native: author 1'], semantic_verification: [] },
    authoring: receipt(model),
    ...overrides,
  };
}

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

/** The flags `CompileArgs` + `AuthoringAuthority` declare that this fixture reads. */
const VALUED = new Map([
  ['--authoring-model', 'authoringModel'],
  ['--decision-model', 'decisionModel'],
  ['--authoring-max-calls', 'maxCalls'],
  ['--authoring-repairs', 'repairs'],
  ['--authoring-max-tokens', 'maxTokens'],
  ['--authoring-timeout', 'timeout'],
  ['--output', 'output'],
]);

function parseCompile() {
  const flags = { answers: new Map(), positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'compile' && i === 0) continue;
    if (arg === '--json') continue;
    if (arg === '--') {
      flags.positional = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith('--answer=')) {
      const pair = arg.slice('--answer='.length);
      const eq = pair.indexOf('=');
      flags.answers.set(pair.slice(0, eq), pair.slice(eq + 1));
    } else if (arg === '--base') {
      flags.base = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--change=')) {
      flags.change = arg.slice('--change='.length);
    } else if (arg === '--fresh') {
      flags.fresh = true;
    } else {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      const field = VALUED.get(name);
      if (!field || eq < 0) {
        // clap's refusal: plain text on stderr, exit 2, no machine document.
        process.stderr.write(`error: unexpected argument '${name}' found\n\nUsage: nika compile [OPTIONS] [INTENT] [DEST]\n`);
        process.exit(2);
      }
      flags[field] = arg.slice(eq + 1);
    }
  }
  return flags;
}

async function compile() {
  const flags = parseCompile();
  const { answers, base, change } = flags;
  const intent = flags.positional[0];

  const key = change !== undefined ? change : (intent ?? '');

  if (key === 'hostile-wedged') process.on('SIGTERM', () => {});
  if (key === 'hostile-slow') process.on('SIGTERM', () => process.exit(130));
  // The log is the test's readiness handshake: PID and signal handlers exist.
  logInvocation();

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
    process.stdout.write(JSON.stringify({ compile_version: 2, status: 'ready' }) + '\n');
    process.exit(0);
    return;
  }
  if (key === 'hostile-future-version') {
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
  if (key === 'hostile-ready-held') {
    // SYNTHETIC: the engine sets `incomplete` before it adds `verify_held`.
    outcome({
      compile_version: 2,
      status: 'ready',
      candidate: 'nika: held\ntasks: {}\n',
      diagnostics: [{ kind: 'applied', target: 'verify_held', message: 'held' }],
      provenance: nativeProvenance(flags.authoringModel ?? 'mock/echo'),
    }, 0);
    return;
  }
  if (key === 'hostile-v2-no-receipt') {
    const { authoring: _receipt, ...provenance } = nativeProvenance(flags.authoringModel ?? 'mock/echo');
    outcome({ compile_version: 2, provenance }, 2);
    return;
  }
  if (key === 'hostile-v1-receipt') {
    outcome({ provenance: nativeProvenance(flags.authoringModel ?? 'mock/echo') }, 2);
    return;
  }
  if (key === 'hostile-written-elsewhere') {
    outcome({ status: 'ready', candidate: candidateFor('null'), written: '/tmp/elsewhere.nika' }, 0);
    return;
  }
  if (key === 'hostile-existing-unasked') {
    outcome({ existing_destination: 'out/unasked.nika' }, 2);
    return;
  }
  if (key === 'usage-unknown-flag') {
    // What a CLI from before a flag answers: clap's refusal, no document.
    process.stderr.write("error: unexpected argument '--fresh' found\n");
    process.exit(2);
    return;
  }

  if (change !== undefined) {
    // EDIT: echo proves the exact base bytes, change text and original intent that arrived.
    const baseBytes = readFileSync(base, 'utf8');
    outcome({
      status: 'ready',
      candidate: `${baseBytes}\n# applied change: ${change}\n`
        + (intent === undefined ? '' : `# original intent: ${intent}\n`),
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
  if (intent === 'authority-refused') {
    failure('authoring_authority',
      'the repairs or samples typed can need 7 authoring requests under the escalate strategy, and 2 are authorized: authorize them with --authoring-max-calls 7, or ask for fewer', 2);
    return;
  }
  if (intent === 'config-refused') {
    failure('authoring_config', 'the reasoning effort `extreme` is not a known word', 3);
    return;
  }
  if (intent === 'record-errors') {
    outcome({
      plan_record_error: { path: '.nika/compile/abc.plan.json', message: 'Permission denied (os error 13)' },
      declined_record_error: { path: '.nika/compile/abc.declined.json', message: 'Permission denied (os error 13)' },
    }, 2);
    return;
  }
  if (intent === 'decision-intent' && flags.decisionModel !== undefined) {
    outcome({
      questions: [QUESTION],
      provenance: { ...PROVENANCE, cognition: 'explicitDecision', strategy: 'warm', suggested_file: null },
    }, 2);
    return;
  }
  if (intent === 'held-intent' && flags.authoringModel !== undefined) {
    // The verifier answered and did not accept: incomplete, a preview, no plan kept.
    const { plan: _plan, ...provenance } = nativeProvenance(flags.authoringModel);
    outcome({
      compile_version: 2,
      status: 'incomplete',
      candidate: 'nika: held-digest\ntasks: {}\n',
      diagnostics: [
        { kind: 'unknown', target: 'semantic_verification', message: 'The judge compared the whole request with the candidate\'s bytes: it does not carry « every morning ».' },
        { kind: 'applied', target: 'verify_held', message: 'The candidate was judged and not accepted: the parts named above stay missing.' },
      ],
      requested_trigger: TRIGGER,
      provenance,
    }, 2);
    return;
  }
  if (intent === 'native-intent' && flags.authoringModel !== undefined) {
    const audience = answers.get('const.audience');
    if (audience === undefined) {
      // A fresh round: one provider call happened, so the document is generation 2.
      outcome({
        compile_version: 2,
        questions: [CHOICE],
        requested_trigger: TRIGGER,
        provenance: nativeProvenance(flags.authoringModel),
      }, 2);
      return;
    }
    // An answer round replays the recorded plan: no call, generation 1.
    const candidate = `nika: morning-digest\nconst: { audience: ${audience} }\ntasks: {}\n`;
    outcome({
      status: 'ready',
      candidate,
      requested_trigger: TRIGGER,
      provenance: { ...PROVENANCE, strategy: 'native', suggested_file: 'morning-digest.nika',
        plan: { semantic_record: { request: 'digest' } } },
      ...destination(flags.output, candidate),
    }, 0);
    return;
  }
  if (intent === 'classify-and-route' || intent === 'echo-answer') {
    const answer = answers.get('const.request');
    if (answer === undefined) {
      outcome({
        status: 'incomplete',
        candidate: candidateFor('null'),
        questions: [QUESTION],
        ...destination(flags.output),
      }, 2);
      return;
    }
    const candidate = candidateFor(answer);
    outcome({ status: 'ready', candidate, ...destination(flags.output, candidate) }, 0);
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

/**
 * The CLI's `--output` law: only a ready candidate is written (and named in
 * `written`); a destination that already holds a file is left in place and
 * named in `existing_destination`.
 */
function destination(output, readyCandidate) {
  if (output === undefined) return {};
  if (readyCandidate !== undefined) {
    writeFileSync(output, readyCandidate);
    return { written: output };
  }
  return existsSync(output) ? { existing_destination: output } : {};
}

function run() {
  logInvocation();
  const workflow = argv[1];
  let source;
  try {
    source = readFileSync(workflow, 'utf8');
  } catch {
    process.stdout.write(`${JSON.stringify({ error: { code: null, message: `cannot read ${workflow}` } })}\n`,
      () => process.exit(3));
    return;
  }
  const frames = [
    { kind: 'workflow_started', status: 'running' },
    { kind: 'run_settled', status: 'succeeded', cause: 'normal', outputs: { source_bytes: Buffer.byteLength(source) } },
  ];
  process.stdout.write(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`, () => process.exit(0));
}

if (argv[0] === '--sdk-identity') {
  logInvocation();
  if (process.env.NIKA_FAKE_COMPILE_PROBE === 'slow') sleepForever();
  else process.stdout.write(`${JSON.stringify(IDENTITY)}\n`);
} else if (argv[0] === 'compile' && argv.includes('--json')) {
  await compile();
} else if (argv[0] === 'run' && argv.includes('--json')) {
  run();
} else {
  process.stderr.write(`fake-nika-compile: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(3);
}
