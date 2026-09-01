#!/usr/bin/env node
function main() {
const argv = process.argv.slice(2);
const command = argv[0];
const workflow = argv[1] ?? '';

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
