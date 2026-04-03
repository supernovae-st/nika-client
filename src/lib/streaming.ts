import type { NikaEvent, StreamOptions } from '../types.js';
import { NikaConnectionError, NikaError, NikaTimeoutError } from '../errors.js';
import type { ApiClient } from './api-client.js';

const DEFAULT_IDLE_TIMEOUT = 60_000; // 60s without any event = dead connection

/**
 * Parse SSE stream from nika serve into typed events.
 *
 * nika serve emits SSE in the format:
 *   event: <type>
 *   data: <json>
 *   \n
 *
 * Terminal events (completed, failed, cancelled) end the generator.
 * An idle timeout detects dead connections (server died without closing TCP).
 */
export async function* streamEvents(
  client: ApiClient,
  jobId: string,
  options?: StreamOptions,
): AsyncGenerator<NikaEvent> {
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;

  const res = await client.connectSSE(`/v1/events/${jobId}`, options?.signal);

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
        // reader.cancel('idle timeout') resolves with done:true (not an error)
        if (timedOut) {
          throw new NikaTimeoutError(
            `SSE stream idle for ${idleTimeout}ms — connection assumed dead`,
          );
        }
        // Server closed without terminal event = unexpected disconnect
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

        for (const line of lines) {
          // Handle both "data: value" and "data:value" (SSE spec)
          if (line.startsWith('data:')) {
            data = line[5] === ' ' ? line.slice(6) : line.slice(5);
          }
          // Skip event:, id:, retry:, comments (:), and keep-alive pings
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
    reader.releaseLock();
  }
}
