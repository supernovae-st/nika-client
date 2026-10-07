import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * `fetch()` for a request its caller set no deadline on.
 *
 * Node's global `fetch` stops waiting for a response whose headers take more
 * than 300 s (undici's `headersTimeout`, `UND_ERR_HEADERS_TIMEOUT`). A serve
 * provider compile round answers only once the round settles, and a server
 * with no configured deadline may take longer than that: the client would
 * fail while the round and its spend go on, losing its answer and its replay
 * token. This sends the same request through `node:http`/`node:https`, which
 * set no header or body deadline: the caller's signal (or the server) ends it.
 *
 * It accepts only what the HTTP transport sends: an absolute http(s) URL,
 * a method, `Headers`, a string body and a signal. The answer is a standard
 * `Response` whose body streams the server's bytes.
 */
export function fetchWithoutDeadline(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    return Promise.reject(new TypeError('fetchWithoutDeadline takes a URL, not a Request'));
  }
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new TypeError(`fetchWithoutDeadline cannot reach ${url.protocol}`));
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    return Promise.reject(new TypeError('fetchWithoutDeadline sends a string body only'));
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = init.body ?? undefined;
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const request = send(url, { method: init.method ?? 'GET', headers });
    const abort = () => request.destroy(abortError(signal));
    signal?.addEventListener('abort', abort, { once: true });
    const settled = () => signal?.removeEventListener('abort', abort);
    request.once('error', (error) => {
      settled();
      // As fetch does: an aborted request rejects with its signal's reason.
      reject(signal?.aborted ? abortError(signal) : new TypeError('fetch failed', { cause: error }));
    });
    request.once('response', (message: IncomingMessage) => {
      message.once('close', settled);
      const status = message.statusCode ?? 0;
      const answered = new Headers();
      const raw = message.rawHeaders;
      for (let at = 0; at + 1 < raw.length; at += 2) answered.append(raw[at]!, raw[at + 1]!);
      const empty = status === 204 || status === 304 || init.method === 'HEAD';
      if (empty) message.resume();
      try {
        resolve(new Response(
          empty ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>),
          { status, statusText: message.statusMessage ?? '', headers: answered },
        ));
      } catch (error) {
        // A status a Response cannot carry (outside 200–599) is a transport failure.
        message.destroy();
        reject(new TypeError('fetch failed', { cause: error }));
      }
    });
    request.end(body);
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('This operation was aborted', 'AbortError');
}
