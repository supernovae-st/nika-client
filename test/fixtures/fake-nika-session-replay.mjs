#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Replays, over a real stdio pipe, the native frames `nika-session-host` RECORDED at engine
 * e849d08eaf37 (`session-host/e849d08eaf37/`, README beside them): the log lines in event order
 * and the direct replies (refusal, replayed result, details) where the host wrote them. Each
 * command the SDK sends is checked against the recorded script (op, identity, snapshot handle,
 * and the line where the recording names it); a departure is refused `malformed` and the
 * process exits 3. The frames are the host's bytes; only this pipe and the ordering rule are
 * the fixture's.
 */

const dir = new URL('./session-host/e849d08eaf37/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
const answers = read('native-answers.json');
const log = read('native-log.json');
const argv = process.argv.slice(2);

if (argv[0] === '--sdk-identity') {
  process.stdout.write(`${JSON.stringify({ engineVersion: '0.122.0', machineProtocolVersion: 1,
    snapshotFormatVersion: 1, checkReportVersion: 1, eventFormatVersion: 1, traceFormatVersion: 2,
    supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'compile', 'sessionHost'] })}\n`);
  process.exit(0);
}
if (argv[0] !== 'session' || argv[1] !== '--json') process.exit(3);

let emitted = 0;
const write = (frame, then) => process.stdout.write(`${JSON.stringify(frame)}\n`, then);
/** A logged answer brings the log up to its event; any other answer is a direct reply. */
function answer(frame, then) {
  if (typeof frame.event === 'number' && frame.event > emitted) {
    const due = log.filter((entry) => entry.event > emitted && entry.event <= frame.event);
    due.forEach((entry, index) => write(entry, index === due.length - 1 ? then : undefined));
    emitted = frame.event;
  } else {
    write(frame, then);
  }
}

const opening = answers[0].snapshot.snapshot;
const current = answers[1].snapshot.snapshot;
// The recorded script (README): the bytes each step must carry.
const script = [
  { op: 'submit', command: 'c-1', snapshot: opening },
  { op: 'submit', command: 'c-2', snapshot: opening, line: 'yes' },
  { op: 'submit', command: 'c-1', snapshot: opening },
  { op: 'details' },
  { op: 'submit', command: 'c-3', snapshot: current, line: 'yes' },
  { op: 'stop', command: 's-1' },
  { op: 'close' },
];
const members = { submit: 'command,line,snapshot', stop: 'command', close: '', details: '', snapshot: '' };

answer(answers[0]);
let step = 0;
let firstLine;
createInterface({ input: process.stdin }).on('line', (text) => {
  const command = JSON.parse(text);
  const expected = script[step];
  const own = Object.keys(command).filter((key) => key !== 'contract' && key !== 'op').sort().join();
  const departs = !expected || command.contract !== 'nika/session-host@1' || own !== members[command.op]
    || Object.entries(expected).some(([key, value]) => command[key] !== value)
    // The replayed c-1 must carry the very bytes of the first.
    || (step === 2 && command.line !== firstLine);
  if (departs) {
    write({ contract: 'nika/session-host@1', frame: 'refused', session: answers[0].session, error: 'malformed',
      message: `replay: step ${step} departs from the recorded script` }, () => process.exit(3));
    return;
  }
  if (step === 0) firstLine = command.line;
  step += 1;
  answer(answers[step], command.op === 'close' ? () => process.exit(0) : undefined);
});
