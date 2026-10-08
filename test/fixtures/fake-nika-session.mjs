#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * A fake engine hosting the authoring Session over `nika session --json`, as
 * contract `nika/session-host@1` (v2, agreed 2026-10-08 with the engine's
 * Session transport lane) states it. SYNTHETIC: no engine produced these
 * bytes; recorded fixtures from the real doors replace them. It plays the
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
    ...(process.env.NIKA_FAKE_NO_SESSION_HOST ? [] : ['sessionHost'])],
};

if (argv[0] === '--sdk-identity') {
  process.stdout.write(`${JSON.stringify(IDENTITY)}\n`);
  process.exit(0);
}
if (argv[0] !== 'session' || argv[1] !== '--json') {
  process.stderr.write(`fake-nika-session: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(3);
}

const session = 'ses_' + '5e'.repeat(16);
const CONTENT = '# Digest 🦋\nnika: digest\n# « Relevé — semaine »\ntasks: {}\n';
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

function emit(frame, withEvent = false, then = undefined) {
  const body = { contract: CONTRACT, ...frame, session };
  if (withEvent) body.event = ++event;
  // Exit only after the write drains: a pipe write is asynchronous.
  process.stdout.write(`${JSON.stringify(body)}\n`, then);
  return body;
}

/** The current snapshot as a read sees it: the last published one, with the turn under way. */
function reading() {
  return { ...current, busy };
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
      authoring: null,
      waiting,
      candidate,
      saved,
      requested: null,
      run: null,
      rail: { draft: candidate ? 'working' : 'pending', saved: saved ? 'done' : 'pending', checked: 'pending',
        active: 'pending', run: 'pending' },
      future_work_member: { additive: true },
    },
  };
  return current;
}

if (process.env.NIKA_FAKE_SESSION_LOCKED) {
  // The project's Session history is held elsewhere: one refused line, exit 3.
  await new Promise((resolve) => emit({ frame: 'refused', error: 'session_unavailable',
    message: 'another nika holds this project\'s Session' }, false, resolve));
  process.exit(3);
}

emit({ frame: 'opened', snapshot: publish(), notices: ['fake host'] }, true);

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit({ frame: 'refused', error: 'malformed', message: 'not JSON' });
    return;
  }
  if (command.contract !== CONTRACT) {
    emit({ frame: 'refused', command: command.command, error: 'malformed', message: 'wrong contract' });
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
      emit({ frame: 'refused', command: command.command, error: 'command_conflict', message: 'other bytes', snapshot: current });
    } else if (known.result) {
      emit({ ...known.result, replayed: true, event: undefined });
    } else {
      known.awaiting = true;
    }
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
    emit({ frame: 'closed', command: command.command, snapshot: current }, true, () => process.exit(0));
    return;
  }
  if (command.op !== 'submit') {
    emit({ frame: 'refused', command: command.command, error: 'malformed', message: 'unknown op' });
    return;
  }
  if (busy) {
    emit({ frame: 'refused', command: command.command, error: 'busy', message: 'a turn runs', snapshot: current });
    return;
  }
  if (command.snapshot !== current.snapshot) {
    emit({ frame: 'refused', command: command.command,
      error: published.has(command.snapshot) ? 'stale_snapshot' : 'unknown_snapshot',
      message: 'the line answered another snapshot', snapshot: current });
    return;
  }
  const entry = { bytes };
  ledger.set(command.command, entry);
  busy = { command: command.command, phase: 'preparing', stop_requested: false };
  stopRequested = false;
  emit({ frame: 'accepted', command: command.command, op: 'submit' }, true);
  emit({ frame: 'activity', command: command.command, phase: 'authoring', note: 'thinking', done: false }, true);
  const settle = () => {
    let outcomes;
    if (stopRequested) {
      outcomes = [{ kind: 'cancelled', text: 'stopped', withdrawn: true }];
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
    const result = emit({ frame: 'result', command: command.command, op: 'submit', replayed: false, outcomes,
      snapshot: publish() }, true);
    entry.result = result;
    if (entry.awaiting) emit({ ...result, replayed: true, event: undefined });
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
