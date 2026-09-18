#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * A fake engine that speaks the literal input channel of nika#1683:
 * `--sdk-identity` advertises `inputsLiteral`, and `run <file> --json
 * --inputs-json -` reads one JSON object from stdin. `fake-nika.mjs` stays the
 * engine WITHOUT the capability (an old producer).
 *
 * The `wire-c1683-*` workflows replay bytes measured from the engine candidate
 * (provenance: run-wire/README.md). The `echo-*` workflows report what this
 * process received, so a test reads the SDK's own argv and stdin bytes. The
 * `hostile-*` workflows are SYNTHETIC: no engine was observed behaving that
 * way, they only pin how the SDK's stdin writer fails.
 */
const WIRE_REPLAYS = {
  'wire-c1683-unknown-input': {
    stdout: 'c1683-unknown-input.compact.stdout',
    stderr: 'c1683-unknown-input.stderr',
    exitCode: 3,
  },
  'wire-c1683-type-mismatch': {
    stdout: 'c1683-type-mismatch.compact.stdout',
    stderr: 'c1683-type-mismatch.stderr',
    exitCode: 3,
  },
  'wire-c1683-missing-required': {
    stdout: 'c1683-missing-required.compact.stdout',
    stderr: 'c1683-missing-required.stderr',
    exitCode: 3,
  },
  'wire-c1683-duplicate-key': {
    stdout: 'c1683-duplicate-key.compact.stdout',
    stderr: 'c1683-duplicate-key.stderr',
    exitCode: 3,
  },
  'wire-c1683-literal': { stdout: 'c1683-literal.ndjson.stdout', exitCode: 0 },
};

const argv = process.argv.slice(2);
const command = argv[0];
const workflow = argv[1] ?? '';

if (process.env.NIKA_FAKE_ARGV_LOG) {
  appendFileSync(process.env.NIKA_FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}
if (process.env.NIKA_FAKE_PID_FILE && command === 'run') {
  writeFileSync(process.env.NIKA_FAKE_PID_FILE, String(process.pid));
}

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function wire(name) {
  return readFileSync(new URL(`./run-wire/${name}`, import.meta.url));
}

/** Write both streams fully, then exit: a replay is never cut by the exit. */
function emitThenExit({ stdout, stderr, exitCode }) {
  const exit = () => process.exit(exitCode);
  const writeStdout = () => {
    if (stdout === undefined || stdout.length === 0) exit();
    else process.stdout.write(stdout, exit);
  };
  if (stderr === undefined || stderr.length === 0) writeStdout();
  else process.stderr.write(stderr, writeStdout);
}

function stdinKind() {
  const stat = fstatSync(0);
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isCharacterDevice()) return 'character-device';
  return 'other';
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.once('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.once('error', reject);
  });
}

/** The engine's typed pre-run refusal: prose on stderr, one envelope on stdout, exit 3. */
function refuse(code, message) {
  emitThenExit({
    stderr: `nika run: ${message}\n`,
    stdout: `${JSON.stringify({ error: { code, message } })}\n`,
    exitCode: 3,
  });
}

async function run() {
  const literal = argv.includes('--inputs-json');
  // The engine judges the channel before it reads either source.
  if (literal && argv[argv.indexOf('--inputs-json') + 1] !== '-') {
    refuse('invalid_inputs_channel', '--inputs-json accepts only `-` (JSON-object stdin)');
    return;
  }
  if (literal && argv.includes('--var')) {
    refuse(
      'input_channel_conflict',
      '--inputs-json cannot share --var or workflow-source stdin (`run -`)',
    );
    return;
  }

  if (workflow.includes('hostile-exits-before-reading')) {
    // The process ends while the SDK still holds most of the map unwritten.
    refuse('input_read_failed', 'cannot read input stdin: fixture closed it unread');
    return;
  }
  if (workflow.includes('hostile-never-reads')) {
    // Admitted without draining stdin: the SDK's writer stays pending until the
    // run is cancelled.
    emit({ kind: 'workflow_started', argv });
    process.on('SIGTERM', () => {
      emit({ kind: 'workflow_interrupted', status: 'interrupted' });
      process.exit(130);
    });
    setTimeout(() => process.exit(0), 30_000);
    return;
  }

  const kind = stdinKind();
  const bytes = literal ? await readStdin() : Buffer.alloc(0);
  const replay = Object.entries(WIRE_REPLAYS).find(([name]) => workflow.includes(name))?.[1];
  if (replay) {
    emitThenExit({
      stdout: replay.stdout === undefined ? undefined : wire(replay.stdout),
      stderr: replay.stderr === undefined ? undefined : wire(replay.stderr),
      exitCode: replay.exitCode,
    });
    return;
  }
  emit({ kind: 'workflow_started', argv });
  emit({
    kind: 'workflow_completed',
    status: 'succeeded',
    outputs: {
      stdin_kind: kind,
      stdin_bytes: bytes.byteLength,
      stdin_sha256: createHash('sha256').update(bytes).digest('hex'),
      // A large map would not fit one machine frame; its digest is the proof.
      ...(bytes.byteLength <= 4096 ? { stdin: bytes.toString('utf8') } : {}),
    },
  });
  process.exit(0);
}

if (command === '--sdk-identity') {
  console.log(JSON.stringify({
    engineVersion: '0.120.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 2,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'inputsLiteral'],
  }));
} else if (command === 'run' && argv.includes('--json')) {
  await run();
} else {
  console.error(`fake-nika-inputs: unsupported argv ${JSON.stringify(argv)}`);
  process.exit(3);
}
