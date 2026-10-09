import {
  NikaProtocolError,
  NikaSessionWaitError,
  NikaTransportError,
} from '../errors.js';
import type {
  NikaSessionClosed,
  NikaSessionDetails,
  NikaSessionEvent,
  NikaSessionOpened,
  NikaSessionResult,
  NikaSessionSnapshot,
} from '../types.js';
import { machineObject } from './machine.js';
import {
  SESSION_FRAME_MAX_BYTES,
  SESSION_HOST_CONTRACT,
  sessionFrame,
  sessionId,
  sessionRefusal,
  type SessionChannel,
  type SessionCommand,
} from './session-host.js';
import { decodeSse, type SseLimits } from './sse/parser.js';

/**
 * The HTTP door of the authoring Session (`nika serve`, same bearer token):
 * `POST /v1/sessions` opens the served project's one live Session, its
 * routes read it, command it and stream its events. A command's POST waits
 * for the turn's settlement with no client deadline: the server owns the
 * accepted turn, so a cut wait loses nothing, and the same command posted
 * again returns its recorded result. 400, 404, 409 and 503 answer with the
 * host's `refused` frame; 401, 413 and 415 with Serve's own error envelope.
 */

const transport = 'http' as const;
/** The statuses whose body is the host's `refused` frame. */
const REFUSED = [400, 404, 409, 503];

/** What the HTTP transport lends the Session door: requests, bounded bodies, its refusals. */
export interface HttpSessionPort {
  /** One authenticated request; `unbounded` sets no client deadline. Any status resolves. */
  request(path: string, init: RequestInit, unbounded: boolean): Promise<Response>;
  /** A bounded JSON object body. */
  object(response: Response, path: string, signal: AbortSignal | undefined, maxBytes: number,
    useRequestTimeout: boolean): Promise<Record<string, unknown>>;
  /** Serve's own refusal for a status outside the host's (401, 413, 415, …). */
  failure(response: Response, path: string): Promise<Error>;
  /** Host text as the client may show it: no control characters, never the bearer token. */
  redact(text: string): string;
  sseLimits(maxBytes: number): SseLimits;
}

export async function openHttpSession(
  port: HttpSessionPort,
  signal?: AbortSignal,
  intelligence?: string,
): Promise<SessionChannel> {
  const path = '/v1/sessions';
  // The host opens on no body or on the contract it speaks; the contract is stated, as JSON, with
  // the conversation's own first-screen words when the opener names them.
  const body = JSON.stringify({ contract: SESSION_HOST_CONTRACT, ...(intelligence === undefined ? {} : { intelligence }) });
  const frame = await exchange(port, path,
    { method: 'POST', signal, body, headers: { 'Content-Type': 'application/json' } }, [201], false);
  if (frame.frame !== 'opened') throw new NikaProtocolError(transport, 'POST /v1/sessions did not answer opened');
  return new HttpSessionChannel(port, sessionId(frame.session, transport), frame as unknown as NikaSessionOpened);
}

export async function attachHttpSession(
  port: HttpSessionPort,
  session: string,
  signal?: AbortSignal,
): Promise<SessionChannel> {
  const channel = new HttpSessionChannel(port, session, undefined);
  await channel.snapshot(signal);
  return channel;
}

class HttpSessionChannel implements SessionChannel {
  readonly transport = transport;

  constructor(
    private readonly port: HttpSessionPort,
    readonly session: string,
    readonly opened: NikaSessionOpened | undefined,
  ) {}

  async snapshot(signal?: AbortSignal): Promise<NikaSessionSnapshot> {
    const frame = await exchange(this.port, this.#path(''), { method: 'GET', signal }, [200], false);
    this.#own(frame, 'snapshot');
    return frame.snapshot as NikaSessionSnapshot;
  }

  async details(signal?: AbortSignal): Promise<NikaSessionDetails> {
    const frame = await exchange(this.port, this.#path('/details'), { method: 'GET', signal }, [200], false);
    this.#own(frame, 'details');
    return frame as unknown as NikaSessionDetails;
  }

  async send(command: SessionCommand, signal?: AbortSignal): Promise<NikaSessionResult | NikaSessionClosed> {
    // Submit and stop ride the same bytes as natively (their identity keys the host's ledger);
    // a close is the Session route's DELETE.
    const path = command.op === 'close' ? this.#path('') : this.#path('/commands');
    const init: RequestInit = command.op === 'close' ? { method: 'DELETE', signal } : {
      method: 'POST', body: command.body, headers: { 'Content-Type': 'application/json' }, signal,
    };
    let frame: Record<string, unknown>;
    try {
      frame = await exchange(this.port, path, init, [200], true, command.line);
    } catch (error) {
      // A cut wait, not a refusal: the server owns the accepted turn.
      if (error instanceof NikaTransportError && !(error instanceof NikaProtocolError)) {
        throw new NikaSessionWaitError(transport, command.command,
          `session: the wait for command ${command.command} stopped; the server keeps an accepted turn, `
          + 'the same command sent again reads its result and stop() stops it',
          { cause: error });
      }
      throw error;
    }
    this.#own(frame, command.op === 'close' ? 'closed' : 'result');
    if (command.op !== 'close' && frame.command !== command.command) {
      throw new NikaProtocolError(transport, `session: the answer named another command than ${command.command}`);
    }
    return frame as unknown as NikaSessionResult | NikaSessionClosed;
  }

  events(after: string | undefined, signal?: AbortSignal): AsyncIterable<NikaSessionEvent> {
    const channel = this;
    return {
      async *[Symbol.asyncIterator]() {
        // A view whose signal already ended is over before it starts: nothing is requested.
        if (signal?.aborted) return;
        const path = channel.#path('/events');
        const headers = new Headers({ Accept: 'text/event-stream' });
        if (after !== undefined) headers.set('Last-Event-ID', after);
        let response: Response;
        try {
          response = await channel.port.request(path, { method: 'GET', headers, signal }, true);
        } catch (error) {
          // Ending the view is the caller's choice, not a failure; it never stops the Session.
          if (signal?.aborted) return;
          throw error;
        }
        if (response.status !== 200) throw await refusal(channel.port, response, path, signal);
        const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (type !== 'text/event-stream' || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new NikaProtocolError(transport, `HTTP ${path} is not an event stream`);
        }
        for await (const sse of decodeSse(response.body, channel.port.sseLimits(SESSION_FRAME_MAX_BYTES), signal)) {
          if (sse.data === undefined) continue;
          let value: unknown;
          try {
            value = JSON.parse(sse.data);
          } catch {
            // No cause: a JSON parse error quotes the text it read.
            throw new NikaProtocolError(transport, `HTTP ${path} carried an event that is not JSON`);
          }
          const frame = sessionFrame(value, transport);
          channel.#own(frame, frame.frame);
          yield (sse.id === undefined ? frame : { ...frame, cursor: sse.id }) as NikaSessionEvent;
          if (frame.frame === 'closed') return;
        }
      },
    };
  }

  /** This Session's routes, each spelled whole as the pinned contract names it, for the coverage check. */
  #path(route: '' | '/details' | '/commands' | '/events'): string {
    const session = encodeURIComponent(this.session);
    if (route === '/details') return `/v1/sessions/${session}/details`;
    if (route === '/commands') return `/v1/sessions/${session}/commands`;
    if (route === '/events') return `/v1/sessions/${session}/events`;
    return `/v1/sessions/${session}`;
  }

  #own(frame: Record<string, unknown>, expected: string): void {
    if (frame.frame !== expected) {
      throw new NikaProtocolError(transport, `session: expected a ${expected} frame, got another`);
    }
    if (frame.session !== this.session) {
      throw new NikaProtocolError(transport, 'session: a frame named another Session');
    }
  }
}

/** One request answered by a frame, or refused by the host with one. */
async function exchange(
  port: HttpSessionPort,
  path: string,
  init: RequestInit,
  accepted: readonly number[],
  unbounded: boolean,
  line?: string,
): Promise<Record<string, unknown> & { frame: string }> {
  const response = await port.request(path, init, unbounded);
  if (!accepted.includes(response.status)) throw await refusal(port, response, path, init.signal ?? undefined, line);
  const body = await port.object(response, path, init.signal ?? undefined, SESSION_FRAME_MAX_BYTES, !unbounded);
  return sessionFrame(body, transport);
}

async function refusal(
  port: HttpSessionPort,
  response: Response,
  path: string,
  signal: AbortSignal | undefined,
  line?: string,
): Promise<Error> {
  const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (REFUSED.includes(response.status) && type === 'application/json') {
    const body = await port.object(response, path, signal, SESSION_FRAME_MAX_BYTES, true);
    if (machineObject(body)?.frame === 'refused') {
      const frame = sessionFrame(body, transport);
      return sessionRefusal({ ...frame, message: port.redact(frame.message as string) }, transport,
        response.status, line);
    }
    return new NikaProtocolError(transport, `HTTP ${response.status} for ${path} carried no refused frame`);
  }
  return port.failure(response, path);
}
