import type { NikaEvent, StreamOptions } from '../types.js';
import { NikaConnectionError, NikaError, NikaTimeoutError } from '../errors.js';
import type { ApiClient } from './api-client.js';

const DEFAULT_IDLE_TIMEOUT = 60_000;

const TERMINAL_STATUS = new Set(['succeeded', 'failed', 'interrupted']);

function isTerminal(event: NikaEvent): boolean {
  return typeof event.status === 'string' && TERMINAL_STATUS.has(event.status);
}

/**
 * Parse nika serve SSE (`GET /v1/jobs/{id}/events`) into typed events.
 *
 * Wire format:
 *   id: <sequence>
 *   data: {"sequence":N,"kind":"...","status":"..."}
 *
 * Terminal when status is succeeded | failed | interrupted.
 * Last-Event-ID resumes from the last sequence.
 */
export async function* streamEvents(
  client: ApiClient,
  jobId: string,
  options?: StreamOptions,
): AsyncGenerator<NikaEvent> {
  const maxReconnects = options?.maxReconnects ?? 3;
  const reconnectDelay = options?.reconnectDelay ?? 1000;
  let lastEventId: string | undefined;
  let reconnects = 0;

  while (true) {
    try {
      const extraHeaders: Record<string, string> = {};
      if (lastEventId) extraHeaders['Last-Event-ID'] = lastEventId;

      yield* streamOnce(client, jobId, options, extraHeaders, (id) => {
        lastEventId = id;
      });
      return;
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      if (err instanceof NikaTimeoutError) throw err;
      if (err instanceof NikaError && !(err instanceof NikaConnectionError)) throw err;
      if (reconnects >= maxReconnects) throw err;
      reconnects++;
      await sleep(reconnectDelay * reconnects, options?.signal);
    }
  }
}

async function* streamOnce(
  client: ApiClient,
  jobId: string,
  options: StreamOptions | undefined,
  extraHeaders: Record<string, string>,
  onEventId: (id: string) => void,
): AsyncGenerator<NikaEvent> {
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;

  const res = await client.connectSSE(
    `/v1/jobs/${jobId}/events`,
    options?.signal,
    extraHeaders,
  );

  if (!res.body) {
    throw new NikaError('SSE response has no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let receivedTerminal = false;
  let timedOut = false;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function resetIdleTimer() {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel('idle timeout').catch(() => {});
    }, idleTimeout);
  }

  resetIdleTimer();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (timedOut) {
          throw new NikaTimeoutError(
            `SSE stream idle for ${idleTimeout}ms — connection assumed dead`,
          );
        }
        if (!receivedTerminal) {
          throw new NikaConnectionError(
            'SSE stream closed without terminal event (succeeded/failed/interrupted)',
          );
        }
        break;
      }

      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop()!;

      for (const part of parts) {
        const lines = part.split('\n');
        let data: string | undefined;
        let eventId: string | undefined;

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const value = line[5] === ' ' ? line.slice(6) : line.slice(5);
            data = data === undefined ? value : `${data}\n${value}`;
          }
          if (line.startsWith('id:')) {
            eventId = line[3] === ' ' ? line.slice(4) : line.slice(3);
          }
        }

        if (eventId) {
          onEventId(eventId);
        }

        if (data) {
          try {
            const event = JSON.parse(data) as NikaEvent;
            yield event;
            if (isTerminal(event)) {
              receivedTerminal = true;
              return;
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NikaConnectionError('Request aborted by caller'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new NikaConnectionError('Request aborted by caller'));
    }, { once: true });
  });
}
