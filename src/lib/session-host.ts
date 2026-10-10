import { randomUUID } from 'node:crypto';
import {
  NikaCompatibilityError,
  NikaConfigurationError,
  NikaProtocolError,
  NikaSessionRefusedError,
} from '../errors.js';
import type {
  NikaSessionClosed,
  NikaSessionCommandOptions,
  NikaSessionDetails,
  NikaSessionEvent,
  NikaSessionEventsOptions,
  NikaSessionOpened,
  NikaSessionResult,
  NikaSessionSnapshot,
  NikaTransportKind,
} from '../types.js';
import { machineObject } from './machine.js';

/**
 * The authoring Session's host contract (engine `nika-session-host`):
 * `nika session --json` natively, `/v1/sessions` over `nika serve`. The engine
 * keeps the one `SessionRuntime`, its published snapshots and the `Waiting`
 * value each one held, and judges every command: whether a line answers a
 * question, consents to a proposal or starts something new is the engine's
 * reading, never the SDK's. This module encodes commands and checks frames;
 * the handle below carries them. Nothing here keeps a second copy of the work.
 */

/** The contract word every frame and command carries. */
export const SESSION_HOST_CONTRACT = 'nika/session-host@1';

/** The work contract a snapshot carries verbatim. */
export const SESSION_WORK_CONTRACT = 'nika/session-work@0';

/** The capability a native engine identity and a resident's `/health` list once they host Sessions. */
export const SESSION_HOST_CAPABILITY = 'sessionHost';
/** The engine (identity) or resident (health) opens a Session with the conversation's own intelligence. */
export const SESSION_INTELLIGENCE_CAPABILITY = 'sessionIntelligence';

/**
 * The first-screen words `openSession({ intelligence })` passes, checked for shape only (the
 * engine reads them): one non-empty line, no control character. `undefined` when none is named.
 */
export function sessionIntelligence(options: { intelligence?: unknown }): string | undefined {
  const words = options.intelligence;
  if (words === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  if (typeof words !== 'string' || words.trim() === '' || /[\u0000-\u001f\u007f]/.test(words)) {
    throw new NikaConfigurationError(
      'openSession: intelligence must be the first-screen words as one non-empty line (no control characters)',
    );
  }
  return words;
}

/**
 * One frame line or body may carry a whole work snapshot with candidate
 * contents; it is still finite. Overflow fails typed, never a truncated parse.
 */
export const SESSION_FRAME_MAX_BYTES = 16 * 1024 * 1024;

/** A command identity, and the shape of every handle the SDK places in a URL path. */
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;
/** A refusal word, as Serve's own error codes are spelled. */
const REFUSAL_WORD = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export type SessionOp = 'submit' | 'stop' | 'close';

/** The command a handle sends: its exact bytes, and what its owner keeps. */
export interface SessionCommand {
  readonly op: SessionOp;
  readonly command: string;
  readonly body: string;
  /** A submit's line, returned to its owner if the host refuses it. */
  readonly line?: string;
}

/**
 * One door of the Session: the native process or the HTTP routes. A channel
 * moves frames; it never decides what a line means.
 */
export interface SessionChannel {
  readonly transport: NikaTransportKind;
  readonly session: string;
  /** The `opened` event, when this door opened the Session (an attached one has none). */
  readonly opened: NikaSessionOpened | undefined;
  snapshot(signal?: AbortSignal): Promise<NikaSessionSnapshot>;
  details(signal?: AbortSignal): Promise<NikaSessionDetails>;
  /** Resolves with the command's `result` (or `closed`) frame; a refusal rejects typed. */
  send(command: SessionCommand, signal?: AbortSignal): Promise<NikaSessionResult | NikaSessionClosed>;
  events(after: string | undefined, signal?: AbortSignal): AsyncIterable<NikaSessionEvent>;
}

/** The key a close waits under on the native door: never an identity a caller can choose. */
export const CLOSE_KEY = '\0close';

/**
 * Encode one command with the contract's field names; the host judges the rest. A close
 * carries no identity (the host keeps no ledger for it): it is keyed locally only.
 */
export function sessionCommand(
  op: SessionOp,
  options: NikaSessionCommandOptions,
  submit?: { snapshot: string; line: string },
): SessionCommand {
  if (op === 'close') {
    return { op, command: CLOSE_KEY, body: JSON.stringify({ contract: SESSION_HOST_CONTRACT, op }) };
  }
  const command = options.command ?? `sdk-${randomUUID()}`;
  if (typeof command !== 'string' || !IDENTITY.test(command)) {
    throw new NikaConfigurationError(
      'session: a command identity is 1 to 128 characters of letters, digits, ".", "_", ":" or "-"',
    );
  }
  const body: Record<string, unknown> = { contract: SESSION_HOST_CONTRACT, op, command };
  if (submit !== undefined) {
    body.snapshot = submit.snapshot;
    body.line = submit.line;
  }
  return { op, command, body: JSON.stringify(body), ...(submit === undefined ? {} : { line: submit.line }) };
}

/** The handle a line names: the snapshot the human answered, never "the latest". */
export function snapshotHandle(value: unknown): string {
  const handle = typeof value === 'string' ? value : machineObject(value)?.snapshot;
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > 256) {
    throw new NikaConfigurationError(
      'session: submit names the snapshot the line answers (a NikaSessionSnapshot or its handle)',
    );
  }
  return handle;
}

/** A line as the human wrote it: any text JSON can carry exactly. */
export function sessionLine(value: unknown): string {
  // A lone surrogate has no UTF-8 form: the engine could not read the line it was sent.
  if (typeof value !== 'string' || /\p{Cs}/u.test(value)) {
    throw new NikaConfigurationError('session: a line is well-formed text');
  }
  return value;
}

/** A Session id, checked before it is ever placed in a URL path. */
export function sessionId(value: unknown, transport: NikaTransportKind): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new NikaProtocolError(transport, 'session: the Session id is not an identity the SDK can address');
  }
  return value;
}

/** A caller's Session id for `attachSession`, checked before any request. */
export function callerSessionId(value: unknown): string {
  if (typeof value !== 'string' || !IDENTITY.test(value)) {
    throw new NikaConfigurationError('attachSession: the Session id is the one `openSession()` or a refusal named');
  }
  return value;
}

/**
 * Check one frame against the contract and return it as the engine wrote it.
 * A frame of another contract generation is a compatibility gap; a frame that
 * breaks this one is a protocol fault. Unknown members ride through.
 */
export function sessionFrame(
  value: unknown,
  transport: NikaTransportKind,
): Record<string, unknown> & { frame: string } {
  const fail = (what: string) => new NikaProtocolError(transport, `session frame ${what}`);
  const frame = machineObject(value);
  if (!frame) throw fail('is not a JSON object');
  if (frame.contract !== SESSION_HOST_CONTRACT) {
    if (typeof frame.contract === 'string' && frame.contract.startsWith('nika/session-host@')) {
      throw new NikaCompatibilityError(SESSION_HOST_CAPABILITY, transport,
        `The engine speaks another Session host contract than ${SESSION_HOST_CONTRACT}`);
    }
    throw fail(`does not carry the contract ${SESSION_HOST_CONTRACT}`);
  }
  if (typeof frame.frame !== 'string' || frame.frame.length === 0) throw fail('names no frame');
  const kind = frame.frame;
  // A refusal names the Session it concerns, or none (`""`) when no Session exists yet.
  if (kind !== 'refused') sessionId(frame.session, transport);
  else if (frame.session !== undefined && typeof frame.session !== 'string') throw fail('refused.session is not text');
  if (frame.event !== undefined
    && !(typeof frame.event === 'number' && Number.isSafeInteger(frame.event) && frame.event >= 1)) {
    throw fail('carries an event number that is not a positive integer');
  }
  const text = (key: string, nullable = false) => {
    const member = frame[key];
    if (typeof member !== 'string' && !(nullable && member === null)) throw fail(`${kind}.${key} is not text`);
  };
  switch (kind) {
    case 'opened':
    case 'closed':
    case 'resync':
      snapshotBody(frame.snapshot, transport);
      if (kind === 'closed' && frame.command !== undefined) text('command');
      break;
    case 'snapshot':
      snapshotBody(frame.snapshot, transport);
      break;
    case 'result':
      text('command');
      text('op');
      if (typeof frame.replayed !== 'boolean') throw fail('result.replayed is not a boolean');
      if (frame.outcomes !== undefined && (!Array.isArray(frame.outcomes)
        || !frame.outcomes.every((outcome) => typeof machineObject(outcome)?.kind === 'string'))) {
        throw fail('result.outcomes is not a list of outcomes with their kind');
      }
      if (frame.receipt !== undefined) text('receipt');
      if (frame.target !== undefined) text('target', true);
      snapshotBody(frame.snapshot, transport);
      break;
    case 'refused':
      // The host's word becomes an error code: an identifier, never free text.
      if (typeof frame.error !== 'string' || !REFUSAL_WORD.test(frame.error)) throw fail('refused.error is not a word');
      text('message');
      if (frame.command !== undefined) text('command');
      if (frame.snapshot !== undefined) snapshotBody(frame.snapshot, transport);
      break;
    case 'details':
      text('snapshot');
      text('text');
      break;
    case 'accepted':
      text('command');
      text('op');
      break;
    case 'activity':
      text('command');
      break;
    default:
      // A frame kind this contract version does not name: carried, never acted upon.
      break;
  }
  return frame as Record<string, unknown> & { frame: string };
}

/** The snapshot body: its handle, publish counter, turn under way and the work verbatim. */
function snapshotBody(value: unknown, transport: NikaTransportKind): NikaSessionSnapshot {
  const fail = (what: string) => new NikaProtocolError(transport, `session snapshot ${what}`);
  const body = machineObject(value);
  if (!body) throw fail('is not an object');
  if (typeof body.snapshot !== 'string' || body.snapshot.length === 0 || body.snapshot.length > 256) {
    throw fail('names no handle');
  }
  if (typeof body.seq !== 'number' || !Number.isSafeInteger(body.seq) || body.seq < 0) {
    throw fail('seq is not a count');
  }
  if (body.busy !== null) {
    const busy = machineObject(body.busy);
    if (!busy || typeof busy.command !== 'string' || typeof busy.phase !== 'string'
      || typeof busy.stop_requested !== 'boolean') {
      throw fail('busy is neither null nor the turn under way');
    }
  }
  const work = machineObject(body.work);
  if (!work) throw fail('carries no work');
  if (work.contract !== SESSION_WORK_CONTRACT) {
    if (typeof work.contract === 'string' && work.contract.startsWith('nika/session-work@')) {
      throw new NikaCompatibilityError(SESSION_HOST_CAPABILITY, transport,
        `The engine's work snapshot speaks another contract than ${SESSION_WORK_CONTRACT}`);
    }
    throw fail(`work does not carry the contract ${SESSION_WORK_CONTRACT}`);
  }
  if (typeof work.root !== 'string') throw fail('work.root is not text');
  if (typeof machineObject(work.waiting)?.kind !== 'string') throw fail('work.waiting names no kind');
  for (const key of ['request', 'rail']) {
    if (!machineObject(work[key])) throw fail(`work.${key} is not an object`);
  }
  for (const key of ['authoring', 'candidate', 'saved', 'requested', 'run']) {
    if (work[key] !== null && !machineObject(work[key])) throw fail(`work.${key} is neither an object nor null`);
  }
  workMembers(work, fail);
  return body as unknown as NikaSessionSnapshot;
}

/** A BLAKE3 or sha256 witness: 32 bytes as lowercase hex. */
const WITNESS = /^[0-9a-f]{64}$/;

/** The members each answer act the engine names carries (`nika-session-change` `AnswerAct`). */
const ANSWER_ACTS: Record<string, string[]> = {
  bound: ['key', 'value', 'reading'],
  dropped: ['key'],
  restated: ['key'],
  waits: ['key', 'why'],
  refused: ['class'],
};

/**
 * The work members the SDK names (engine `nika-session-change` `work.rs`;
 * candidate `content`, `authoring.draft`/`calls` and `intelligence` from the
 * 0.123 integration `1b47f34c0`, `authoring.calls.per_call` from
 * `ca5845b85`, `answered` as `Answered`/`AnswerAct` serialize; `knowledge`,
 * `authoring.stages` and the `knowledge_choice` wait from `5f1e91c6f`; the
 * conversation's `bindings`, `delegations`, `questions` and the `questions`
 * wait from `6d217dfba`; `run.sealed` from `ad70c9aa7`), judged where
 * they are. A member present with another shape
 * is a protocol fault naming its path, never its value; an absent one,
 * `null` where the engine writes it and every unknown member ride through.
 * Nothing is copied or rebuilt.
 */
function workMembers(work: Record<string, unknown>, fail: (what: string) => NikaProtocolError): void {
  const member = (record: Record<string, unknown>, key: string, at: string,
    check: (value: unknown, path: string) => void, required = false) => {
    if (Object.hasOwn(record, key)) check(record[key], `${at}.${key}`);
    else if (required) throw fail(`${at}.${key} is absent`);
  };
  const object = (value: unknown, path: string) => {
    const found = machineObject(value);
    if (!found) throw fail(`${path} is not an object`);
    return found;
  };
  const text = (nullable = false) => (value: unknown, path: string) => {
    if (typeof value !== 'string' && !(nullable && value === null)) {
      throw fail(`${path} is ${nullable ? 'neither text nor null' : 'not text'}`);
    }
  };
  const count = (nullable = false) => (value: unknown, path: string) => {
    if (!(nullable && value === null)
      && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
      throw fail(`${path} is ${nullable ? 'neither a count nor null' : 'not a count'}`);
    }
  };
  const flag = (value: unknown, path: string) => {
    if (typeof value !== 'boolean') throw fail(`${path} is not a boolean`);
  };
  const witness = (nullable = false) => (value: unknown, path: string) => {
    if (!(nullable && value === null) && !(typeof value === 'string' && WITNESS.test(value))) {
      throw fail(`${path} is ${nullable ? 'neither a witness nor null' : 'not a witness'}`);
    }
  };
  const texts = (value: unknown, path: string) => {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      throw fail(`${path} is not a list of text`);
    }
  };
  /** A list whose every entry is an object, each judged by `check` at its own path. */
  const list = (check: (entry: Record<string, unknown>, at: string) => void) => (value: unknown, path: string) => {
    if (!Array.isArray(value)) throw fail(`${path} is not a list`);
    value.forEach((entry, index) => check(object(entry, `${path}[${index}]`), `${path}[${index}]`));
  };

  const candidate = machineObject(work.candidate);
  if (candidate) {
    member(candidate, 'files', 'work.candidate', (files, path) => {
      if (!Array.isArray(files)) throw fail(`${path} is not a list`);
      files.forEach((entry, index) => {
        const at = `${path}[${index}]`;
        const file = object(entry, at);
        member(file, 'path', at, text(), true);
        member(file, 'bytes', at, witness(), true);
        member(file, 'content', at, text());
        member(file, 'replaces', at, witness(true));
        member(file, 'landing', at, text());
        member(file, 'workflow', at, flag);
      });
    }, true);
    member(candidate, 'revision', 'work.candidate', (value, path) => {
      if (value === null) return;
      const revision = object(value, path);
      member(revision, 'mode', path, text(), true);
      member(revision, 'base_sha256', path, witness(true), true);
      member(revision, 'candidate_sha256', path, witness(), true);
      member(revision, 'changed', path, texts, true);
      member(revision, 'preservation', path, text());
      member(revision, 'components', path, (components, at) => {
        if (!Array.isArray(components)) throw fail(`${at} is not a list`);
        components.forEach((entry, index) => {
          const where = `${at}[${index}]`;
          const use = object(entry, where);
          member(use, 'id', where, text(), true);
          member(use, 'version', where, text(true));
          member(use, 'release', where, text(true));
          member(use, 'file_sha256', where, witness(true));
          member(use, 'witness', where, text(), true);
          member(use, 'bindings', where, (bindings, list) => {
            if (!Array.isArray(bindings)) throw fail(`${list} is not a list`);
            bindings.forEach((binding, position) => {
              const hole = object(binding, `${list}[${position}]`);
              member(hole, 'path', `${list}[${position}]`, text(), true);
              member(hole, 'value', `${list}[${position}]`, () => {}, true);
            });
          }, true);
        });
      }, true);
    });
  }
  const authoring = machineObject(work.authoring);
  if (authoring) {
    member(authoring, 'candidate', 'work.authoring', witness(true));
    member(authoring, 'draft', 'work.authoring', text(true));
    member(authoring, 'calls', 'work.authoring', (value, path) => {
      if (value === null) return;
      const calls = object(value, path);
      member(calls, 'requested_model', path, text(), true);
      member(calls, 'calls', path, count(), true);
      member(calls, 'elapsed_ms', path, count(), true);
      member(calls, 'input_tokens', path, count(true));
      member(calls, 'output_tokens', path, count(true));
      member(calls, 'backend', path, (backend, at) => {
        if (backend !== null) object(backend, at);
      });
      member(calls, 'per_call', path, (list, at) => {
        if (!Array.isArray(list)) throw fail(`${at} is not a list`);
        list.forEach((entry, index) => {
          const where = `${at}[${index}]`;
          const call = object(entry, where);
          // The engine's own words: their spelling is its allowlist's, never re-judged here.
          for (const key of ['call', 'stop_reason', 'failure_kind', 'reasoning_effort']) {
            member(call, key, where, text(true), true);
          }
          for (const key of ['instruction_sha256', 'schema_sha256']) member(call, key, where, witness(true), true);
          for (const key of ['message_bytes', 'references', 'max_output_tokens', 'timeout_ms', 'elapsed_ms',
            'input_tokens', 'output_tokens', 'reasoning_tokens']) {
            member(call, key, where, count(true), true);
          }
          member(call, 'usage_reported', where, (reported, place) => {
            if (reported !== null && typeof reported !== 'boolean') {
              throw fail(`${place} is neither a boolean nor null`);
            }
          }, true);
        });
      });
    });
    // The compile's other stages, as its decision record states them: every member written,
    // a time it does not state `null`, never `0`.
    member(authoring, 'stages', 'work.authoring', (value, path) => {
      if (value === null) return;
      const stages = object(value, path);
      member(stages, 'qualification_ms', path, count(true), true);
      member(stages, 'trials', path, list((trial, at) => {
        member(trial, 'attempt', at, text(true), true);
        member(trial, 'elapsed_ms', at, count(true), true);
        member(trial, 'runtime_bound_ms', at, count(true), true);
      }), true);
    });
  }
  // What a held line or the questions open together carry; the kind itself is checked above.
  const waiting = machineObject(work.waiting)!;
  if (waiting.kind === 'knowledge_choice') member(waiting, 'line', 'work.waiting', text(), true);
  if (waiting.kind === 'questions') member(waiting, 'ids', 'work.waiting', texts, true);
  // The knowledge the Session reads: left out when it states none (never `null`), each known
  // state with its own members; a state this SDK has not met rides through.
  member(work, 'knowledge', 'work', (value, path) => {
    const knowledge = object(value, path);
    member(knowledge, 'state', path, text(), true);
    if (knowledge.state === 'admitted') {
      member(knowledge, 'source', path, text(), true);
      member(knowledge, 'version', path, text(true), true);
      member(knowledge, 'manifest_sha256', path, witness(), true);
      member(knowledge, 'by', path, text(), true);
    } else if (knowledge.state === 'refused') {
      for (const key of ['source', 'by', 'code', 'cause']) member(knowledge, key, path, text(), true);
    } else if (knowledge.state === 'unread') {
      member(knowledge, 'why', path, text(), true);
    }
  });
  // What a conversation led by an intelligence holds: each list left out when empty (never `null`).
  member(work, 'bindings', 'work', list((binding, at) => {
    member(binding, 'key', at, text());
    member(binding, 'role', at, text(), true);
    member(binding, 'value', at, text(), true);
    member(binding, 'provenance', at, (value, path) => {
      const provenance = object(value, path);
      member(provenance, 'kind', path, text(), true);
      member(provenance, 'message', path, text(), true);
      for (const key of ['excerpt', 'question', 'option']) member(provenance, key, path, text());
    }, true);
  }));
  member(work, 'delegations', 'work', list((delegation, at) => {
    for (const key of ['message', 'excerpt', 'scope']) member(delegation, key, at, text(), true);
  }));
  member(work, 'questions', 'work', list((asked, at) => {
    for (const key of ['id', 'key', 'question', 'state']) member(asked, key, at, text(), true);
    member(asked, 'why', at, text());
    member(asked, 'role', at, text());
    member(asked, 'after', at, texts);
    member(asked, 'free_text', at, flag, true);
    member(asked, 'multi_select', at, flag, true);
    member(asked, 'options', at, list((offer, where) => {
      member(offer, 'key', where, text(), true);
      member(offer, 'label', where, text(), true);
      member(offer, 'recommended', where, flag, true);
      member(offer, 'values', where, list((offered, place) => {
        member(offered, 'role', place, text(), true);
        member(offered, 'value', place, text(), true);
        member(offered, 'name', place, text());
      }), true);
    }), true);
  }));
  member(work, 'intelligence', 'work', (value, path) => {
    if (value === null) return;
    const intelligence = object(value, path);
    member(intelligence, 'author', path, (author, at) => {
      const seat = object(author, at);
      member(seat, 'kind', at, text(), true);
      for (const key of ['model', 'seat', 'transport', 'why']) member(seat, key, at, text(true));
    }, true);
    member(intelligence, 'selected', path, (selected, at) => {
      if (selected === null) return;
      const chosen = object(selected, at);
      member(chosen, 'kind', at, text(), true);
      for (const key of ['via', 'transport', 'model', 'refusal']) member(chosen, key, at, text(true));
      member(chosen, 'locus', at, text());
      member(chosen, 'ready', at, flag);
      member(chosen, 'scope', at, text());
    });
    member(intelligence, 'decision', path, (decision, at) => {
      if (decision === null) return;
      const seat = object(decision, at);
      member(seat, 'model', at, text(), true);
      member(seat, 'refusal', at, text(true));
    });
    member(intelligence, 'effort', path, text(true));
  });
  // The compiler's question while one waits: the engine leaves it out otherwise (never `null`),
  // and writes a choice's options only when it has some.
  member(work, 'question', 'work', (value, path) => {
    const question = object(value, path);
    for (const key of ['key', 'label', 'type', 'why']) member(question, key, path, text(), true);
    member(question, 'mandatory', path, flag, true);
    member(question, 'options', path, (options, at) => {
      if (!Array.isArray(options)) throw fail(`${at} is not a list`);
      options.forEach((entry, index) => {
        const where = `${at}[${index}]`;
        const option = object(entry, where);
        member(option, 'key', where, text(), true);
        member(option, 'label', where, text(), true);
      });
    });
  });
  // What the last line typed for a question did: left out when it answered nothing (never `null`),
  // each known act with its own members; an act this SDK has not met rides through.
  member(work, 'answered', 'work', (value, path) => {
    const answered = object(value, path);
    member(answered, 'question', path, text(), true);
    member(answered, 'act', path, text(), true);
    const act = String(answered.act);
    for (const key of Object.hasOwn(ANSWER_ACTS, act) ? ANSWER_ACTS[act]! : []) {
      member(answered, key, path, text(), true);
    }
  });
  // Every member of an observed Run is written, `null` where its observation carried none.
  member(work, 'run', 'work', (value, path) => {
    if (value === null) return;
    const run = object(value, path);
    member(run, 'current', path, flag, true);
    for (const key of ['workflow', 'trace', 'execution', 'workflow_sha256', 'chain_head']) {
      member(run, key, path, text(true), true);
    }
    member(run, 'chain_len', path, count(true), true);
    member(run, 'sealed', path, flag);
    member(run, 'end', path, (end, at) => {
      if (end === null) return;
      const ended = object(end, at);
      member(ended, 'end', at, text(), true);
      member(ended, 'exit', at, count());
    }, true);
  });
}

/** A refusal frame as the typed error its owner receives, the refused line kept. */
export function sessionRefusal(
  frame: Record<string, unknown>,
  transport: NikaTransportKind,
  status: number,
  line?: string,
): NikaSessionRefusedError {
  const code = frame.error as string;
  // The host's sentence, bounded and on one line, as an error message may be logged.
  const said = (frame.message as string).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return new NikaSessionRefusedError(transport, code,
    `The Session host refused (${code}): ${said.length > 240 ? `${said.slice(0, 240)}...` : said}`, {
      status,
      ...(typeof frame.command === 'string' ? { command: frame.command } : {}),
      ...(line === undefined ? {} : { line }),
      ...(frame.snapshot === undefined ? {} : { snapshot: frame.snapshot as NikaSessionSnapshot }),
      ...(code === 'session_live' && typeof frame.session === 'string' ? { session: frame.session } : {}),
    });
}

/**
 * The authoring Session, over either door. Every method is one engine
 * operation: a read, a command, or the event stream. The handle keeps no
 * work of its own and never chooses which snapshot a line answers.
 */
export class NikaAuthoringSession {
  readonly #channel: SessionChannel;

  constructor(channel: SessionChannel) {
    this.#channel = channel;
  }

  /** The Session's identity for this incarnation; a restart is a new Session. */
  get id(): string {
    return this.#channel.session;
  }

  get transport(): NikaTransportKind {
    return this.#channel.transport;
  }

  /** The `opened` event (first snapshot, host notices) when this handle opened the Session. */
  get opened(): NikaSessionOpened | undefined {
    return this.#channel.opened;
  }

  /** The current published snapshot. It never waits on a turn. */
  async snapshot(options: { signal?: AbortSignal } = {}): Promise<NikaSessionSnapshot> {
    return this.#channel.snapshot(options.signal);
  }

  /** The Session's details text for its current snapshot. It never waits on a turn. */
  async details(options: { signal?: AbortSignal } = {}): Promise<NikaSessionDetails> {
    return this.#channel.details(options.signal);
  }

  /**
   * Submit one line as the answer to the snapshot it was typed against. The
   * engine reads the line and settles the turn; the result's `outcomes` say
   * what happened and its `snapshot` is the next one. A snapshot that is no
   * longer current refuses (`stale_snapshot`) with nothing sent to the
   * runtime: show the refusal's snapshot, never resend the line on its own.
   */
  async submit(
    snapshot: NikaSessionSnapshot | string,
    line: string,
    options: NikaSessionCommandOptions = {},
  ): Promise<NikaSessionResult> {
    // `async`: a caller's mistake arrives as a rejection too, before anything is sent.
    const command = sessionCommand('submit', options,
      { snapshot: snapshotHandle(snapshot), line: sessionLine(line) });
    return this.#channel.send(command, options.signal) as Promise<NikaSessionResult>;
  }

  /**
   * Ask the turn under way to stop. The result's `receipt` says whether a
   * Stop was requested; the stopped turn's own result settles it. A Run in
   * progress is not stopped here (`run_underway`).
   */
  async stop(options: NikaSessionCommandOptions = {}): Promise<NikaSessionResult> {
    return this.#channel.send(sessionCommand('stop', options), options.signal) as Promise<NikaSessionResult>;
  }

  /**
   * End the Session (the native process with it); its history stays the engine's. A close
   * carries no identity: the host keeps no ledger for it.
   */
  async close(options: { signal?: AbortSignal } = {}): Promise<NikaSessionClosed> {
    return this.#channel.send(sessionCommand('close', {}), options.signal) as Promise<NikaSessionClosed>;
  }

  /**
   * The Session's events, after `after` (or every event the door still holds), until it closes
   * or `signal` ends the view.
   */
  events(options: NikaSessionEventsOptions = {}): AsyncIterable<NikaSessionEvent> {
    return this.#channel.events(options.after, options.signal);
  }
}
