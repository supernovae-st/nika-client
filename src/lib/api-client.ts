import type { NikaLogger } from '../types.js';
import { NikaAPIError, NikaConnectionError, NikaTimeoutError } from '../errors.js';

export class ApiClient {
  readonly url: string;
  readonly timeout: number;
  readonly retries: number;
  readonly logger?: NikaLogger;
  private readonly token: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(
    url: string,
    token: string,
    timeout: number,
    retries: number,
    fetchFn: typeof globalThis.fetch,
    logger?: NikaLogger,
  ) {
    this.url = url;
    this.token = token;
    this.timeout = timeout;
    this.retries = retries;
    this._fetch = fetchFn;
    this.logger = logger;
  }

  // ── Standard request: auth + retry + timeout ──────────────

  async request(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.url}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      ...(init?.headers as Record<string, string> ?? {}),
    };

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      // Compose user signal with timeout signal + cleanup on completion
      let abortListener: (() => void) | undefined;
      if (init?.signal) {
        if (init.signal.aborted) {
          clearTimeout(timer);
          throw new NikaConnectionError('Request aborted by caller');
        }
        abortListener = () => controller.abort(init.signal!.reason);
        init.signal.addEventListener('abort', abortListener, { once: true });
      }

      try {
        this.logger?.debug(`${init?.method ?? 'GET'} ${path} (attempt ${attempt + 1})`);

        const res = await this._fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        if (res.ok) {
          this.logger?.debug(`${res.status} ${path}`);
          return res;
        }

        const body = await res.text().catch(() => '');
        const requestId = res.headers.get('x-request-id') ?? undefined;

        // Retry on 429 (rate limit) and 5xx (server errors)
        if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
          const retryAfter = res.headers.get('Retry-After');
          const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
          const delay = Number.isFinite(parsed) ? parsed * 1000 : 1000 * (attempt + 1);
          this.logger?.warn(`${res.status} ${path} — retrying in ${delay}ms`);
          await sleep(delay, init?.signal ?? undefined);
          continue;
        }

        throw new NikaAPIError(
          `${res.status} ${res.statusText}: ${body}`.trim(),
          res.status,
          body,
          requestId,
        );
      } catch (err) {
        if (err instanceof NikaAPIError) throw err;
        if (err instanceof NikaConnectionError) throw err;

        if (err instanceof Error && err.name === 'AbortError') {
          if (init?.signal?.aborted) {
            throw new NikaConnectionError('Request aborted by caller');
          }
          throw new NikaTimeoutError(`Request timed out after ${this.timeout}ms`);
        }

        // fetch throws TypeError for network errors (DNS, refused, reset)
        if (err instanceof TypeError) {
          throw new NikaConnectionError(`Connection failed: ${err.message}`, err);
        }

        throw err;
      } finally {
        clearTimeout(timer);
        // Clean up signal listener to prevent accumulation across retries
        if (abortListener && init?.signal) {
          init.signal.removeEventListener('abort', abortListener);
        }
      }
    }

    throw new NikaAPIError('Max retries exceeded', 503, '');
  }

  // ── JSON shorthand ────────────────────────────────────────

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    return res.json() as Promise<T>;
  }

  // ── SSE connect: auth but no retry/timeout (stream has its own idle timeout) ──

  async connectSSE(path: string, signal?: AbortSignal): Promise<Response> {
    const url = `${this.url}${path}`;
    const res = await this._fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'text/event-stream',
      },
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new NikaAPIError(
        `SSE connection failed: ${res.status} ${res.statusText}`,
        res.status,
        body,
      );
    }

    return res;
  }

  // ── Health fetch: no auth, with timeout ───────────────────

  async fetchHealth(): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      return await this._fetch(`${this.url}/health`, {
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NikaTimeoutError(`Health check timed out after ${this.timeout}ms`);
      }
      if (err instanceof TypeError) {
        throw new NikaConnectionError(`Health check failed: ${err.message}`, err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
