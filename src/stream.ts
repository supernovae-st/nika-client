import type { NikaEvent } from './types.js';
import { NikaError } from './errors.js';

/**
 * Parse SSE stream from nika serve.
 *
 * nika serve emits SSE in the format:
 *   event: <type>
 *   data: <json>
 *   \n
 *
 * The JSON payload contains a `type` field matching the event type.
 * Terminal events (completed, failed, cancelled) end the stream.
 */
export async function* streamEvents(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<NikaEvent> {
  const res = await fetch(url, {
    headers: {
      ...headers,
      'Accept': 'text/event-stream',
    },
    signal,
  });

  if (!res.ok) {
    throw new NikaError(
      `SSE connection failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  if (!res.body) {
    throw new NikaError('SSE response has no body', 500);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
              return;
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
