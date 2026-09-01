import { describe, expect, it, vi } from 'vitest';
import {
  Nika,
  NikaOperationError,
  NikaTransportError,
} from '../src/index.js';
import {
  HTTP_DEPTH_FIXTURE,
  TOKEN_A,
  healthResponse,
  jsonResponse,
} from './helpers/http-depth-harness.js';

function client(fetch: typeof globalThis.fetch): Nika {
  return new Nika({
    url: 'https://nika.example',
    token: TOKEN_A,
    bin: HTTP_DEPTH_FIXTURE,
    fetch,
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error('expected a refusal');
}

describe('typed HTTP refusals', () => {
  it('carries the server code for an unauthorized bearer', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'unauthorized', message: 'authentication required' } },
        401,
      ));
    const refused = await failure(client(fetch as typeof globalThis.fetch).listWorkflows());
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(refused).toMatchObject({
      operation: 'listWorkflows',
      transport: 'http',
      code: 'unauthorized',
      machineCode: 'unauthorized',
      status: 401,
      message: 'HTTP 401 for /v1/workflows: unauthorized (authentication required)',
    });
  });

  it('names the admission refusal code the engine stamped on a 422', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'NIKA-AUTH-006', message: 'effect under an absent permits block' } },
        422,
      ));
    const refused = await failure(client(fetch as typeof globalThis.fetch).run('flow.nika.yaml'));
    expect(refused).toMatchObject({
      name: 'NikaOperationError',
      operation: 'run',
      code: 'NIKA-AUTH-006',
      status: 422,
    });
  });

  it('keeps a durable-job refusal typed on status and cancel', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse({ id: 'job-1', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'job_not_found', message: 'job not found' } },
        404,
      ));
    const nika = client(fetch as typeof globalThis.fetch);
    const run = await nika.attachRun('job-1');
    const refused = await failure(nika.status(run));
    expect(refused).toMatchObject({
      name: 'NikaOperationError',
      operation: 'status',
      code: 'job_not_found',
      status: 404,
    });
  });

  it('redacts a reflected bearer token inside the server message', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'unauthorized', message: `bad bearer ${TOKEN_A}\n\ttry again` } },
        401,
      ));
    const refused = await failure(client(fetch as typeof globalThis.fetch).workflow('flow.nika.yaml'));
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(String(refused)).toContain('[REDACTED]');
    expect(String(refused)).not.toContain(TOKEN_A);
    expect(String(refused)).not.toMatch(/[\n\t]/);
  });

  it('falls back to the redacted transport error when the code is not an identifier', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: `<script>${TOKEN_A}</script>`, message: 'nope' } },
        403,
      ));
    const refused = await failure(client(fetch as typeof globalThis.fetch).listWorkflows());
    expect(refused).toBeInstanceOf(NikaTransportError);
    expect(refused).not.toBeInstanceOf(NikaOperationError);
    expect(String(refused)).toBe('NikaTransportError: HTTP 403 for /v1/workflows: [REDACTED]');
  });

  it('falls back to the redacted transport error when the body is not JSON', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(new Response('<html>gateway</html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      }));
    const refused = await failure(client(fetch as typeof globalThis.fetch).listWorkflows());
    expect(refused).toBeInstanceOf(NikaTransportError);
    expect(String(refused)).toContain('HTTP 503 for /v1/workflows: [REDACTED]');
  });

  it('bounds an oversized refusal message', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(healthResponse())
      .mockResolvedValueOnce(jsonResponse(
        { error: { code: 'unauthorized', message: 'x'.repeat(4_000) } },
        401,
      ));
    const refused = await failure(client(fetch as typeof globalThis.fetch).listWorkflows());
    expect(refused).toBeInstanceOf(NikaOperationError);
    expect(String(refused).length).toBeLessThan(400);
  });
});
