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

/**
 * One frame line or body may carry a whole work snapshot with candidate
 * contents; it is still finite. Overflow fails typed, never a truncated parse.
 */
export const SESSION_FRAME_MAX_BYTES = 16 * 1024 * 1024;

/** A command identity, and the shape of every handle the SDK places in a URL path. */
const IDENTITY = /^[A-Za-z0-9._:-]{1,128}$/;

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

/** Encode one command with the contract's field names; the host judges the rest. */
export function sessionCommand(
  op: SessionOp,
  options: NikaSessionCommandOptions,
  submit?: { snapshot: string; line: string },
): SessionCommand {
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
  if (kind !== 'refused' || frame.session !== undefined) sessionId(frame.session, transport);
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
      text('error');
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
  return body as unknown as NikaSessionSnapshot;
}

/** A refusal frame as the typed error its owner receives, the refused line kept. */
export function sessionRefusal(
  frame: Record<string, unknown>,
  transport: NikaTransportKind,
  status: number,
  line?: string,
): NikaSessionRefusedError {
  const code = frame.error as string;
  return new NikaSessionRefusedError(transport, code,
    `The Session host refused (${code}): ${frame.message as string}`, {
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

  /** End the Session; its history stays the engine's. */
  async close(options: NikaSessionCommandOptions = {}): Promise<NikaSessionClosed | NikaSessionResult> {
    return this.#channel.send(sessionCommand('close', options), options.signal);
  }

  /** The Session's events, from `after` (or from now) until it closes or `signal` ends the view. */
  events(options: NikaSessionEventsOptions = {}): AsyncIterable<NikaSessionEvent> {
    return this.#channel.events(options.after, options.signal);
  }
}
