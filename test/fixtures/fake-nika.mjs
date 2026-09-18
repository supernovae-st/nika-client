#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Byte-for-byte `run --json` captures of real engines (provenance:
 * run-wire/README.md). Replaying them makes this fixture speak a measured
 * dialect instead of an imagined one.
 */
const WIRE_REPLAYS = {
  'wire-0119-sec004': { stdout: '0.119.0-sec004.pretty.stdout', exitCode: 2 },
  'wire-0119-parse005': { stdout: '0.119.0-parse005.pretty.stdout', exitCode: 2 },
  'wire-0119-missing-file': { stdout: '0.119.0-missing-file.pretty.stdout', exitCode: 3 },
  'wire-0119-budget1709': { stdout: '0.119.0-budget1709.line.stdout', exitCode: 2 },
  'wire-0119-input1708': { stderr: '0.119.0-input1708.stderr', exitCode: 3 },
  'wire-0119-hello': { stdout: '0.119.0-hello.ndjson.stdout', exitCode: 0 },
  'wire-0119-admitted-failure': {
    stdout: '0.119.0-admitted-failure.ndjson.stdout',
    exitCode: 1,
  },
  'wire-0118-human-gate': { stdout: '0.118.7-human-gate.ndjson.stdout', exitCode: 4 },
  'wire-0118-sigterm-cancel': { stdout: '0.118.7-sigterm-cancel.ndjson.stdout', exitCode: 130 },
  'wire-pr1679-sec004': { stdout: 'pr1679-sec004.compact.stdout', exitCode: 2 },
  'wire-pr1679-parse005': { stdout: 'pr1679-parse005.compact.stdout', exitCode: 2 },
  'wire-pr1679-missing-file': { stdout: 'pr1679-missing-file.compact.stdout', exitCode: 3 },
  'wire-pr1679-budget1709': {
    stdout: 'pr1679-budget1709.compact.stdout',
    stderr: 'pr1679-budget1709.stderr',
    exitCode: 2,
  },
  'wire-pr1679-input1708': {
    stdout: 'pr1679-input1708.compact.stdout',
    stderr: 'pr1679-input1708.stderr',
    exitCode: 3,
  },
};

function wire(name) {
  return readFileSync(new URL(`./run-wire/${name}`, import.meta.url));
}

/** Write both streams fully, then exit: a replay is never cut by the exit. */
function emitThenExit({ stdout, stderr, exitCode, lingerMs = 0 }) {
  const exit = () => setTimeout(() => process.exit(exitCode), lingerMs);
  const writeStdout = () => {
    if (stdout === undefined || stdout.length === 0) exit();
    else process.stdout.write(stdout, exit);
  };
  if (stderr === undefined || stderr.length === 0) writeStdout();
  else process.stderr.write(stderr, writeStdout);
}

function main() {
const argv = process.argv.slice(2);
const command = argv[0];
const workflow = argv[1] ?? '';

// Test-owned observers: which engine invocations happened, and which process
// served them. Absent unless a test asks.
if (process.env.NIKA_FAKE_ARGV_LOG) {
  appendFileSync(process.env.NIKA_FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}
if (process.env.NIKA_FAKE_PID_FILE && command === 'run') {
  writeFileSync(process.env.NIKA_FAKE_PID_FILE, String(process.pid));
}

if (command === '--sdk-identity') {
  console.log(JSON.stringify({
    engineVersion: '0.114.0',
    machineProtocolVersion: 1,
    snapshotFormatVersion: 1,
    checkReportVersion: 1,
    eventFormatVersion: 1,
    traceFormatVersion: 1,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
  }));
  return;
}

if (command === 'wait-for-signal') {
  console.log('ready');
  setTimeout(() => process.exit(0), 2_000);
  return;
}

if (command === 'check') {
  const sdkSnapshot = argv.includes('--sdk-snapshot');
  if (workflow.includes('hang')) {
    setTimeout(() => {
      console.log(JSON.stringify({ report_version: 1, clean: true, argv }));
      process.exit(0);
    }, 5_000);
    return;
  }
  if (workflow.includes('stderr-report')) {
    // The engine wrote its report to stderr behind a `nika: ` prefix.
    console.error(`nika: ${JSON.stringify({
      clean: false,
      findings: [{
        gate: 'PARSE',
        kind: 'parse',
        message: `cannot read ${workflow}: No such file or directory (os error 2)`,
        severity: 'error',
      }],
      parse_fatal: true,
      report_version: 1,
    }, null, 1)}`);
    process.exit(3);
  }
  if (workflow.includes('stderr-plain')) {
    // Neither stream carries a JSON object; only prose reaches the caller.
    console.error('nika: the engine could not produce a check report for this input');
    process.exit(3);
  }
  if (workflow.includes('red-snapshot')) {
    if (sdkSnapshot) {
      // A red workflow has no exportable snapshot: one error line, no findings.
      console.log(JSON.stringify({
        error: {
          message: 'cannot export execution snapshot: captured workflow failed check: '
            + `NIKA-AUTH-006 ${workflow}: invoke \`nika:write\` is not permitted `
            + '— fix: add "nika:write" to permits.tools',
        },
      }));
      process.exit(2);
    }
    console.log(JSON.stringify({
      report_version: 1,
      clean: false,
      argv,
      findings: [{
        code: 'NIKA-AUTH-006',
        gate: 'AUTH',
        kind: 'permits',
        severity: 'error',
        message: 'invoke `nika:write` is not permitted — fix: add "nika:write" to permits.tools',
      }],
    }));
    process.exit(2);
  }
  if (sdkSnapshot && workflow.includes('parse-fatal')) {
    console.log(JSON.stringify({
      report_version: 1,
      clean: false,
      parse_fatal: true,
      findings: [{ code: 'NIKA-PARSE-001', message: 'fixture parse failure' }],
    }));
    process.exit(2);
  }
  const report = {
    report_version: 1,
    clean: !workflow.includes('dirty'),
    argv,
    engine_owned: { future: true },
  };
  if (sdkSnapshot) {
    Object.assign(report, {
      engineVersion: '0.114.0',
      machineProtocolVersion: workflow.includes('tampered') ? 99 : 1,
      snapshotFormatVersion: 1,
      checkReportVersion: 1,
      eventFormatVersion: 1,
      traceFormatVersion: 1,
      supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace'],
      execution_snapshot: '{"format_version":1,"root":"fixture.nika.yaml","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","units":[{"path":"fixture.nika.yaml","kind":0,"digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","bytes_hex":"00"}]}',
    });
  }
  console.log(JSON.stringify(report));
  process.exit(workflow.includes('dirty') ? 2 : 0);
}

if (command === 'run' && argv.includes('--json')) {
  const emit = (value) => console.log(JSON.stringify(value));

  const replay = Object.entries(WIRE_REPLAYS).find(([name]) => workflow.includes(name))?.[1];
  if (replay) {
    emitThenExit({
      stdout: replay.stdout === undefined ? undefined : wire(replay.stdout),
      stderr: replay.stderr === undefined ? undefined : wire(replay.stderr),
      exitCode: replay.exitCode,
    });
    return;
  }

  // SYNTHETIC hostile shapes: no engine was observed writing these. They
  // exist to pin how the SDK fails, never to describe an engine.
  if (workflow.includes('synthetic-truncated-pretty')) {
    // A pretty report cut mid-document, as a crash mid-write would leave it.
    emitThenExit({ stdout: wire('0.119.0-sec004.pretty.stdout').subarray(0, 900), exitCode: 2 });
    return;
  }
  if (workflow.includes('synthetic-truncated-compact')) {
    // A compact report cut mid-line, with no terminating newline.
    emitThenExit({ stdout: wire('pr1679-sec004.compact.stdout').subarray(0, 160), exitCode: 2 });
    return;
  }
  if (workflow.includes('synthetic-oversize')) {
    // One refusal line far beyond any configured machine bound, never ended.
    emitThenExit({
      stdout: `{"clean":false,"findings":[{"code":"NIKA-SEC-004","message":"${'x'.repeat(200_000)}`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-silent-exit-0')) {
    emitThenExit({ exitCode: 0 });
    return;
  }
  if (workflow.includes('synthetic-silent-exit-2')) {
    emitThenExit({ exitCode: 2 });
    return;
  }
  if (workflow.includes('synthetic-crash-before-frame')) {
    emitThenExit({ stderr: "thread 'main' panicked at src/main.rs:1:1\n", exitCode: 101 });
    return;
  }
  if (workflow.includes('synthetic-uncoded-stderr')) {
    emitThenExit({ stderr: 'nika run: environment: the project root is not readable\n', exitCode: 3 });
    return;
  }
  if (workflow.includes('synthetic-null-code-envelope')) {
    // The engine's envelope contract: `code` is null when the refusal class
    // carries no wire code. The message text here is invented.
    emitThenExit({
      stdout: `${JSON.stringify({
        error: { code: null, message: 'nika run: environment: the project root is not readable' },
      })}\n`,
      exitCode: 3,
    });
    return;
  }
  if (workflow.includes('synthetic-unknown-first-object')) {
    emitThenExit({ stdout: `${JSON.stringify({ protocol: 2 })}\n`, exitCode: 0 });
    return;
  }
  if (workflow.includes('synthetic-refusal-then-events')) {
    // A refusal object followed by lifecycle frames: the engine ran anyway.
    process.stdout.write(wire('pr1679-sec004.compact.stdout'));
    emit({ kind: 'workflow_started' });
    setTimeout(() => {
      emit({ kind: 'workflow_completed', status: 'succeeded' });
      process.exit(0);
    }, 5_000);
    return;
  }
  if (workflow.includes('synthetic-pretty-event')) {
    // A lifecycle frame pretty-printed over several lines: no engine writes it.
    emitThenExit({
      stdout: `${JSON.stringify({ kind: 'workflow_started', status: 'running' }, null, 2)}\n`,
      exitCode: 0,
    });
    return;
  }
  if (workflow.includes('synthetic-refusal-then-garbage')) {
    emitThenExit({
      stdout: `${wire('pr1679-sec004.compact.stdout')}this line follows a refusal\n`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-refusal-then-object')) {
    emitThenExit({
      stdout: `${wire('pr1679-sec004.compact.stdout')}${JSON.stringify({ note: 'a second object' })}\n`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-teaching-then-extra')) {
    emitThenExit({
      stdout: `${wire('0.119.0-budget1709.line.stdout')}a line after the teaching line\n`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-clean-report-with-findings')) {
    // A report that calls itself clean is not a refusal, whatever it lists.
    emitThenExit({
      stdout: `${JSON.stringify({
        clean: true,
        findings: [{ code: 'NIKA-SEC-004', message: 'listed by a clean report', severity: 'error' }],
        report_version: 1,
      })}\n`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-clean-report')) {
    emitThenExit({
      stdout: `${JSON.stringify({ clean: true, findings: [], report_version: 1 })}\n`,
      exitCode: 0,
    });
    return;
  }
  if (workflow.includes('synthetic-findings-without-verdict')) {
    // Findings with no `clean: false`: the engine never said it refused.
    emitThenExit({
      stdout: `${JSON.stringify({
        findings: [{ code: 'NIKA-SEC-004', message: 'no verdict beside it', severity: 'error' }],
      })}\n`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-malformed-findings')) {
    emitThenExit({
      stdout: `${JSON.stringify({ clean: false, findings: ['not a finding object'] })}\n`,
      exitCode: 2,
    });
    return;
  }
  if (workflow.includes('synthetic-envelope-without-message')) {
    emitThenExit({ stdout: `${JSON.stringify({ error: { code: 'NIKA-1709' } })}\n`, exitCode: 2 });
    return;
  }
  if (workflow.includes('synthetic-refusal-exit-0')) {
    // The real compact refusal, contradicted by a success exit.
    emitThenExit({ stdout: wire('pr1679-sec004.compact.stdout'), exitCode: 0 });
    return;
  }
  if (workflow.includes('synthetic-teaching-after-admission')) {
    // A plain code line after a lifecycle frame: never measured on any engine.
    emit({ kind: 'workflow_started' });
    console.log('NIKA-1704 · the ceiling was crossed mid-run');
    setTimeout(() => process.exit(1), 0);
    return;
  }
  if (workflow.includes('synthetic-big-event')) {
    // Admitted, then one complete frame past the bound, newline included,
    // delivered in a single write.
    emit({ kind: 'workflow_started' });
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({ kind: 'task_completed', pad: 'x'.repeat(8_000) })}\n`, () => {
        emit({ kind: 'workflow_completed', status: 'succeeded' });
        process.exit(0);
      });
    }, 20);
    return;
  }
  if (workflow.includes('synthetic-exact-bound')) {
    // The first frame's raw line is exactly 512 bytes before its newline.
    const open = '{"kind":"workflow_started","pad":"';
    const first = `${open}${'x'.repeat(512 - open.length - 2)}"}`;
    process.stdout.write(`${first}\n`, () => {
      emit({ kind: 'workflow_completed', status: 'succeeded' });
      process.exit(0);
    });
    return;
  }
  if (workflow.includes('synthetic-ignores-sigterm')) {
    // A faulty stream from a process that will not end when asked politely.
    process.on('SIGTERM', () => {});
    console.log('this line is not machine output at all');
    setTimeout(() => process.exit(0), 30_000);
    return;
  }
  if (workflow.includes('synthetic-lingering-refusal')) {
    // The refusal is complete on the wire while the process is still alive.
    emitThenExit({ stdout: wire('pr1679-budget1709.compact.stdout'), exitCode: 2, lingerMs: 300 });
    return;
  }
  if (workflow.includes('synthetic-garbage-then-hang')) {
    console.log('this line is not machine output at all');
    setTimeout(() => process.exit(0), 5_000);
    return;
  }

  if (workflow.includes('refuse-1709')) {
    // A pre-run refusal: one plain code line under --json, no machine frame.
    console.log(
      "NIKA-1709 · refusing to start: the workflow's unavoidable cost floor $0.000005 "
      + 'exceeds --max-cost-usd $0.000000 (cheapest static path · gates closed · first-try) '
      + '— raise the budget or trim the workflow (`nika check` shows the envelope)',
    );
    process.exit(2);
  }

  if (workflow.includes('garbage-line')) {
    console.log('this line is not machine output at all');
    process.exit(0);
  }

  if (workflow.includes('cancel')) {
    emit({ kind: 'workflow_started' });
    process.on('SIGTERM', () => {
      emit({ kind: 'workflow_interrupted', status: 'interrupted' });
      process.exit(130);
    });
    setTimeout(() => {
      emit({ kind: 'workflow_completed', status: 'succeeded' });
      process.exit(0);
    }, 2_000);
    return;
  }

  const finish = () => {
    emit({ kind: 'workflow_started', argv });
    const count = workflow.includes('burst') ? 6 : 1;
    for (let index = 0; index < count; index += 1) {
      emit({ kind: 'task_completed', sequence: index + 1, value: index });
    }
    if (workflow.includes('settled')) {
      if (workflow.includes('recovered')) {
        emit({ kind: 'task_failed', fields: [
          { key: 'task', value: 'recovered' },
          { key: 'detail', value: 'NIKA-EXEC-001 · recovered by the workflow' },
        ] });
      }
      // The 0.118 engine's terminal shape (ADR-128): the settlement rides
      // run_settled flattened · status · cause · elapsed_ms · tasks · spend.
      emit({
        kind: 'workflow_completed',
        fields: [{ key: 'status', value: 'succeeded' }, { key: 'cause', value: 'normal' }],
      });
      emit({
        kind: 'run_settled',
        status: 'succeeded',
        cause: 'normal',
        elapsed_ms: 12,
        tasks: { total: 2, ok: 2, failed: 0, recovered: 1, skipped: 0, cancelled: 0, never_started: 0 },
        spend: { total_cost_usd: null, priced_calls: 0, unpriced_calls: 0, qualifier: 'unmetered' },
        outputs: { answer: 'x' },
      });
      process.exit(0);
    }
    if (workflow.includes('fields-failure')) {
      // The released engine's shape: the failure rides field rows on
      // task_failed; workflow_failed and run_settled carry no error.
      emit({
        kind: 'task_failed',
        fields: [
          { key: 'task', value: 'boom' },
          { key: 'note', value: 'exec · false' },
          { key: 'detail', value: 'NIKA-EXEC-001 · command exited with status 1: ' },
          { key: 'duration_ms', value: 7 },
        ],
      });
      emit({ kind: 'workflow_failed', fields: [{ key: 'workflow', value: 'fixture' }] });
      emit({ kind: 'run_settled', status: 'failed', outputs: { boom: null } });
      process.exit(1);
    }
    if (workflow.includes('failing')) {
      emit({
        kind: 'workflow_failed',
        status: 'failed',
        error: { code: 'NIKA-TEST-001', message: 'fixture failure' },
      });
      process.exit(1);
    }
    emit({
      kind: 'workflow_completed',
      status: 'succeeded',
      outputs: { answer: 42 },
      receipt: { trace_path: 'fixture-trace.ndjson', opaque: true },
    });
    process.exit(0);
  };

  setTimeout(finish, workflow.includes('slow') || workflow.includes('burst') ? 30 : 0);
  return;
}

if (command === 'trace' && argv[1] === 'verify') {
  const target = argv[2] ?? '';
  console.log(target.includes('broken') ? 'BROKEN' : `OK ${target}`);
  process.exit(target.includes('broken') ? 2 : 0);
}

if (command === 'trace' && argv[1] === 'evidence') {
  console.log(JSON.stringify({
    trace: { chain: 'intact', events: 7, head: 'fixture-head' },
    seal: {
      present: true,
      verifies: true,
      covers_chain: true,
      covers: {
        sdk_receipt: {
          receipt_format: 1,
          execution_id: 'exe-fixture',
          trace_id: 'trace-fixture',
          snapshot_digest: 'snapshot-fixture',
        },
      },
    },
  }));
  return;
}

console.error(`fake-nika: unsupported argv ${JSON.stringify(argv)}`);
process.exit(3);
}

main();
