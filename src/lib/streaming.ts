import type { NikaEvent, StreamOptions } from '../types.js';
import { NikaConnectionError, NikaError, NikaTimeoutError } from '../errors.js';
import type { ApiClient } from './api-client.js';

const DEFAULT_IDLE_TIMEOUT = 60_000; // 60s without any event = dead connection

/**
 * Parse SSE stream from nika serve into typed events.
 *
 * nika serve emits SSE in the format:
 *   event: <type>
 *   id: <incrementing_number>
 *   data: <json>
 *   \n
 *
 * Terminal events (completed, failed, cancelled) end the generator.
 * An idle timeout detects dead connections (server died without closing TCP).
 *
 * Auto-reconnects on stream drop (up to maxReconnects), using
 * Last-Event-Id header to resume from where it left off.
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
      if (lastEventId) extraHeaders['Last-Event-Id'] = lastEventId;

      yield* streamOnce(client, jobId, options, extraHeaders, (id) => {
        lastEventId = id;
      });

      // If streamOnce returns normally, a terminal event was received — done
      return;
    } catch (err) {
      // Don't reconnect on user abort
      if (options?.signal?.aborted) throw err;

      // Don't reconnect on non-retryable errors (4xx, timeout by choice)
      if (err instanceof NikaTimeoutError) throw err;
      if (err instanceof NikaError && !(err instanceof NikaConnectionError)) throw err;

      // NikaConnectionError = stream dropped without terminal event
      if (reconnects >= maxReconnects) throw err;
      reconnects++;
      await sleep(reconnectDelay * reconnects, options?.signal);
      continue; // retry with Last-Event-Id
    }
  }
}

/**
 * Single SSE connection attempt. Yields events, tracks last event ID.
 * Returns normally on terminal event. Throws on unexpected disconnect.
 */
async function* streamOnce(
  client: ApiClient,
  jobId: string,
  options: StreamOptions | undefined,
  extraHeaders: Record<string, string>,
  onEventId: (id: string) => void,
): AsyncGenerator<NikaEvent> {
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;

  const res = await client.connectSSE(
    `/v1/events/${jobId}`,
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

  // Idle timeout: reset on every chunk received
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
            'SSE stream closed without terminal event (completed/failed/cancelled)',
          );
        }
        break;
      }

      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });

      // SSE blocks are separated by double newlines
      const parts = buffer.split('\n\n');
      buffer = parts.pop()!; // keep incomplete chunk

      for (const part of parts) {
        const lines = part.split('\n');
        let data: string | undefined;
        let eventId: string | undefined;

        for (const line of lines) {
          // Handle both "data: value" and "data:value" (SSE spec)
          if (line.startsWith('data:')) {
            data = line[5] === ' ' ? line.slice(6) : line.slice(5);
          }
          // Parse id: field for reconnect tracking
          if (line.startsWith('id:')) {
            eventId = line[3] === ' ' ? line.slice(4) : line.slice(3);
          }
          // Skip event:, retry:, comments (:), and keep-alive pings
        }

        if (eventId) {
          onEventId(eventId);
        }

        if (data) {
          try {
            const event = JSON.parse(data) as NikaEvent;
            yield event;

            // Terminal events end the stream
            if (
              event.type === 'completed' ||
              event.type === 'failed' ||
              event.type === 'cancelled'
            ) {
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
    // Cancel first (if not already done by idle timer), then release
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
