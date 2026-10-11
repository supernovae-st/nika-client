#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * A fake engine hosting the authoring Session over `nika session --json`, as
 * contract `nika/session-host@1` states it and engine commit e079f3e79
 * (`nika-session-host` `wire.rs`, `machine.rs`, `host.rs`) writes it.
 * SYNTHETIC: no engine produced these bytes; recorded fixtures from the real
 * doors replace them. It plays the
 * host's own laws (snapshot custody, the command ledger, one turn at a time,
 * Stop receipt vs settlement) so the SDK's handle can be driven, never the
 * Session's reading of a line: the scripted lines below stand in for it.
 *
 * Scripted lines: `draft …` proposes `digest.nika`; `yes` against a consent
 * saves it; `slow …` prepares until stopped (or 400 ms) then proposes;
 * anything else is a reply.
 */

const CONTRACT = 'nika/session-host@1';
const argv = process.argv.slice(2);
if (process.env.NIKA_FAKE_ARGV_LOG) appendFileSync(process.env.NIKA_FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);

const IDENTITY = {
  engineVersion: '0.123.0',
  machineProtocolVersion: 1,
  snapshotFormatVersion: 1,
  checkReportVersion: 1,
  eventFormatVersion: 1,
  traceFormatVersion: 2,
  supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'inputsLiteral', 'compile',
    ...(process.env.NIKA_FAKE_NO_SESSION_HOST ? [] : ['sessionHost']),
    ...(process.env.NIKA_FAKE_SESSION_INTELLIGENCE ? ['sessionIntelligence'] : []),
    // `NIKA_FAKE_SESSION_STEERING` claims the doors' word without the doors: a host that breaks its word.
    ...(process.env.NIKA_FAKE_SESSION_DOORS || process.env.NIKA_FAKE_SESSION_STEERING ? ['sessionSteering'] : [])],
};

if (argv[0] === '--sdk-identity') {
  // `NIKA_FAKE_IDENTITY_FILE` names the identity a real engine printed, printed here as it is.
  const recorded = process.env.NIKA_FAKE_IDENTITY_FILE;
  process.stdout.write(`${recorded ? readFileSync(recorded, 'utf8').trim() : JSON.stringify(IDENTITY)}\n`);
  process.exit(0);
}
// `session --json`, optionally with one `--intelligence <words>` (host 92bc996c8 `machine_selection`).
const selection = argv.length === 4 && argv[2] === '--intelligence' ? argv[3] : undefined;
if (argv[0] !== 'session' || argv[1] !== '--json' || (argv.length !== 2 && selection === undefined)) {
  process.stderr.write(`fake-nika-session: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(3);
}

const session = 'ses_' + '5e'.repeat(16);
// `NIKA_FAKE_SESSION_WORK` names a JSON file whose `authoring` and `intelligence` every snapshot's work carries.
const RICH = process.env.NIKA_FAKE_SESSION_WORK
  ? JSON.parse(readFileSync(process.env.NIKA_FAKE_SESSION_WORK, 'utf8'))
  : undefined;
const CONTENT = '# Digest 🦋\nnika: digest\n# « Relevé — semaine »\ntasks: {}\n';
// The conversation's own choice, held here only (host 92bc996c8: `scope: conversation`).
const CHOSEN = selection === undefined ? undefined : {
  selected: { kind: 'api', via: 'deepseek', transport: null, model: selection.slice(2), locus: 'DeepSeek API',
    ready: true, refusal: null, scope: 'conversation' },
  author: { kind: 'provider', model: selection.slice(2), seat: null, transport: null, why: null },
  decision: null, effort: null,
};
let event = 0;
let seq = 0;
let current;
const published = new Set();
const ledger = new Map();
let busy = null;
let stopRequested = false;
let saved = null;
let waiting = { kind: 'free' };
let candidate = null;
// The Session doors (engine main 0e4e1c74f), with `NIKA_FAKE_SESSION_DOORS`: a `slow …` turn stands for a
// conversation's run that reads its queue; `steer` and `follow_up` queue lines for it while it runs; the
// identity lists `sessionSteering` and a line it cannot parse is refused naming its valid identity.
const DOORS = Boolean(process.env.NIKA_FAKE_SESSION_DOORS);
const IDENTITY_WORD = /^[A-Za-z0-9._:-]{1,128}$/;
let reads = false;
let queue = [];
let workQueued = [];
let lines = 0;
let cited = 0;

function emitAs(name, frame, then) {
  process.stdout.write(`${JSON.stringify({ contract: CONTRACT, ...frame, session: name })}\n`, then);
}

function emit(frame, withEvent = false, then = undefined) {
  const body = { contract: CONTRACT, ...frame, session };
  if (withEvent) body.event = ++event;
  // Exit only after the write drains: a pipe write is asynchronous.
  process.stdout.write(`${JSON.stringify(body)}\n`, then);
  return body;
}

/** The turn under way, with the lines its run reads now (the doors' `busy.queued`). */
function busyView() {
  return busy && reads && queue.length > 0 ? { ...busy, queued: queue.map((entry) => ({ ...entry })) } : busy;
}

/** The current snapshot as a read sees it: the last published one, with the turn under way. */
function reading() {
  return { ...current, busy: busyView() };
}

function publish() {
  seq += 1;
  const handle = `snp_${String(seq).padStart(32, '0')}`;
  published.add(handle);
  current = {
    snapshot: handle,
    seq,
    busy,
    work: {
      contract: 'nika/session-work@0',
      root: process.cwd(),
      request: { goal: null, decisions: [], unresolved: [] },
      authoring: RICH?.authoring ?? null,
      ...(RICH ? { intelligence: RICH.intelligence } : {}),
      ...(CHOSEN ? { intelligence: CHOSEN } : {}),
      waiting,
      candidate,
      saved,
      requested: null,
      run: null,
      rail: { draft: candidate ? 'working' : 'pending', saved: saved ? 'done' : 'pending', checked: 'pending',
        active: 'pending', run: 'pending' },
      future_work_member: { additive: true },
      ...(workQueued.length > 0 ? { queued: workQueued } : {}),
    },
  };
  return current;
}

if (selection !== undefined && !/^2 deepseek\//.test(selection)) {
  // Words the census does not read: one refused line in its own words, exit 3, no Session.
  await new Promise((resolve) => emitAs('', { frame: 'refused', error: 'session_unavailable',
    message: `the intelligence \`${selection}\` is not one this machine reads · choose one the first screen lists` },
  resolve));
  process.exit(3);
}

if (process.env.NIKA_FAKE_SESSION_LOCKED) {
  // The project's Session history is held elsewhere: one refused line, exit 3.
  // As `open::run_stdio` refuses: no Session exists yet, so the frame names none.
  await new Promise((resolve) => emitAs('', { frame: 'refused', error: 'session_unavailable',
    message: 'another nika holds this project\'s Session' }, resolve));
  process.exit(3);
}

emit({ frame: 'opened', snapshot: publish(), notices: ['fake host'] }, true);

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  // `NIKA_FAKE_SESSION_LINES` names a file that keeps every line this host was written.
  if (process.env.NIKA_FAKE_SESSION_LINES) appendFileSync(process.env.NIKA_FAKE_SESSION_LINES, `${line}\n`);
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit({ frame: 'refused', error: 'malformed', message: 'not JSON' });
    return;
  }
  if (command.contract !== CONTRACT) {
    emit({ frame: 'refused', error: 'malformed', message: 'wrong contract' });
    return;
  }
  // `deny_unknown_fields` and per-op members: close and reads take no command, snapshot or line.
  const members = Object.keys(command).filter((key) => key !== 'contract' && key !== 'op').sort().join();
  const expected = { submit: 'command,line,snapshot', stop: 'command', close: '', snapshot: '', details: '',
    ...(DOORS ? { steer: 'command,line', follow_up: 'command,line' } : {}) };
  // As `machine.rs` answers a line it cannot parse: `malformed`, in line order, naming the valid identity
  // the line carries from engine 0e4e1c74f (the doors here), and no command before it.
  const named = DOORS && typeof command.command === 'string' && IDENTITY_WORD.test(command.command)
    ? { command: command.command } : {};
  if (!(command.op in expected)) {
    emit({ frame: 'refused', error: 'malformed', message: `unknown op \`${command.op}\``, ...named });
    return;
  }
  if (members !== expected[command.op]) {
    emit({ frame: 'refused', error: 'malformed', message: `\`${command.op}\` takes other members`, ...named });
    return;
  }
  if (command.op === 'snapshot') { emit({ frame: 'snapshot', snapshot: reading() }); return; }
  if (command.op === 'details') {
    emit({ frame: 'details', snapshot: current.snapshot, text: `details of ${current.snapshot}` });
    return;
  }
  const bytes = JSON.stringify([command.op, command.snapshot ?? null, command.line ?? null]);
  const known = ledger.get(command.command);
  if (known) {
    if (known.bytes !== bytes) {
      emit({ frame: 'refused', command: command.command, error: 'command_conflict', message: 'other bytes',
        line: command.line, snapshot: current });
    } else if (known.result) {
      // v3: the recorded log frame again, with its original event number, as a direct reply.
      process.stdout.write(`${JSON.stringify({ ...known.result, replayed: true })}\n`);
    }
    // In flight with the same bytes: the native door writes nothing; the result event answers both.
    return;
  }
  if (command.op === 'stop') {
    const target = busy?.command ?? null;
    const receipt = busy ? 'stop_requested' : 'nothing_to_stop';
    if (busy) { stopRequested = true; busy = { ...busy, stop_requested: true }; }
    const result = emit({ frame: 'result', command: command.command, op: 'stop', replayed: false, receipt, target,
      snapshot: current }, true);
    ledger.set(command.command, { bytes, result });
    return;
  }
  if (command.op === 'close') {
    emit({ frame: 'closed', snapshot: current }, true, () => process.exit(0));
    return;
  }
  if (command.op === 'steer' || command.op === 'follow_up') {
    // A line for the conversation's run under way: queued while it reads, refused truthfully otherwise.
    const target = busy?.command ?? null;
    let receipt;
    let queued;
    if (!busy) receipt = 'nothing_to_steer';
    else if (!reads) receipt = 'not_reading';
    else if (command.line.trim() === '') receipt = 'blank';
    else if (queue.length >= 32) receipt = 'full';
    else {
      lines += 1;
      queued = { id: `l${lines}`, mode: command.op, line: command.line, state: 'waiting' };
      queue.push(queued);
      receipt = 'queued';
    }
    const result = emit({ frame: 'result', command: command.command, op: command.op, replayed: false, receipt,
      ...(queued ? { queued: { ...queued } } : {}), target, snapshot: reading() }, true);
    ledger.set(command.command, { bytes, result });
    return;
  }
  if (command.op !== 'submit') {
    emit({ frame: 'refused', command: command.command, error: 'malformed', message: 'unknown op' });
    return;
  }
  if (busy) {
    emit({ frame: 'refused', command: command.command, error: 'busy', message: 'a turn runs', line: command.line,
      snapshot: current });
    return;
  }
  if (command.snapshot !== current.snapshot) {
    emit({ frame: 'refused', command: command.command,
      error: published.has(command.snapshot) ? 'stale_snapshot' : 'unknown_snapshot',
      message: 'the line answered another snapshot', line: command.line, snapshot: current });
    return;
  }
  const entry = { bytes };
  ledger.set(command.command, entry);
  busy = { command: command.command, phase: 'preparing', stop_requested: false };
  stopRequested = false;
  cited += 1;
  // With the doors, a `slow …` turn is a conversation's run: it reads its queue and calls a tool.
  reads = DOORS && command.line.startsWith('slow');
  queue = [];
  emit({ frame: 'accepted', command: command.command, op: 'submit' }, true);
  emit({ frame: 'activity', command: command.command, phase: 'authoring', note: 'thinking', done: false }, true);
  if (reads) {
    emit({ frame: 'activity', command: command.command, phase: 'checking', note: 'verify', done: false,
      tool: { call: 'toolu_1', name: 'verify', state: 'started' } }, true);
  }
  const settle = () => {
    let outcomes;
    if (reads) {
      // What became of each queued line: returned unsent by a Stop, else entered as a cited line.
      for (const entry of queue) {
        if (stopRequested) entry.state = 'returned';
        else Object.assign(entry, { state: 'entered', cite: `u${(cited += 1)}` });
      }
      workQueued = queue.map((entry) => ({ ...entry }));
      if (!stopRequested) {
        emit({ frame: 'activity', command: command.command, phase: 'checking', note: 'verify · 42 ms', done: true,
          tool: { call: 'toolu_1', name: 'verify', state: 'finished', elapsed_ms: 42 } }, true);
      }
    }
    if (stopRequested && reads) {
      // `Outcome::Stopped`: a conversation's turn the person stopped, its queued lines returned unsent.
      const unsent = queue.map((entry) => ({ ...entry }));
      const text = 'stopped by you · nothing was under way · the conversation and its draft are kept'
        + (unsent.length > 0 ? ` · not sent: ${unsent.map((entry) => `« ${entry.line} »`).join(' · ')}` : '');
      outcomes = [{ kind: 'stopped', reach: 'between_steps', text, ...(unsent.length > 0 ? { unsent } : {}) }];
    } else if (stopRequested) {
      // `Outcome::Cancelled { withdrawn }` lists what the Stop withdrew.
      outcomes = [{ kind: 'cancelled', text: 'stopped',
        withdrawn: [{ kind: 'proposal', proposal: 'p'.repeat(64), text: 'Save digest.nika?' }] }];
    } else if (command.line.startsWith('draft') || command.line.startsWith('slow')) {
      candidate = { proposal: 'p'.repeat(64), aside: false, rehearsed: false, run_after_save: false,
        files: [{ path: 'digest.nika', landing: 'create', workflow: true, bytes: 'b'.repeat(64), replaces: null,
          audit: null, content: CONTENT }], revision: null };
      waiting = { kind: 'consent', proposal: 'p'.repeat(64) };
      outcomes = [{ kind: 'proposal', proposal: 'p'.repeat(64), text: 'Save digest.nika?' }];
    } else if (command.line === 'yes' && waiting.kind === 'consent') {
      saved = { workflow: 'digest.nika', check_clean: true, world: null };
      candidate = null;
      waiting = { kind: 'free' };
      outcomes = [{ kind: 'reply', text: 'Saved digest.nika' }];
    } else {
      outcomes = [{ kind: 'reply', text: `read: ${command.line}` }];
    }
    busy = null;
    reads = false;
    queue = [];
    const result = emit({ frame: 'result', command: command.command, op: 'submit', replayed: false, outcomes,
      snapshot: publish() }, true);
    entry.result = result;
  };
  if (command.line.startsWith('slow')) {
    const started = Date.now();
    const wait = () => (stopRequested || Date.now() - started > 400 ? settle() : setTimeout(wait, 10));
    setTimeout(wait, 10);
  } else {
    settle();
  }
});
input.on('close', () => {
  emit({ frame: 'closed', snapshot: current }, true, () => process.exit(0));
});
