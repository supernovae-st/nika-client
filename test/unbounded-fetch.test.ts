import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchWithoutDeadline } from '../src/lib/unbounded-fetch.js';

// The fetch a provider compile round without a deadline goes through: the
// global fetch stops waiting for headers after 300 s, this one never does.
// A real loopback server, no network beyond it.

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('fetchWithoutDeadline', () => {
  it('sends the method, headers and body, and answers a standard Response', async () => {
    let seen: { method?: string; auth?: string; type?: string; body: string } = { body: '' };
    const url = await serve((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seen = { method: request.method, auth: request.headers.authorization,
          type: request.headers['content-type'], body };
        response.writeHead(200, { 'Content-Type': 'application/json', 'Nika-Compile-Replay': 'ab12' });
        response.end('{"compile_version":2}');
      });
    });
    const response = await fetchWithoutDeadline(`${url}/v1/compile`, {
      method: 'POST',
      headers: new Headers({ Authorization: 'Bearer t', 'Content-Type': 'application/json' }),
      body: '{"intent":"x"}',
    });
    expect(seen).toEqual({ method: 'POST', auth: 'Bearer t', type: 'application/json', body: '{"intent":"x"}' });
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.headers.get('nika-compile-replay')).toBe('ab12');
    expect(await response.json()).toEqual({ compile_version: 2 });
  });

  it('answers a refusal as its status, never as a transport failure', async () => {
    const url = await serve((_request, response) => {
      response.writeHead(422, { 'Content-Type': 'application/json' });
      response.end('{"error":{"code":"compile_limit","message":"m"}}');
    });
    const response = await fetchWithoutDeadline(url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: 'compile_limit', message: 'm' } });
  });

  it("ends a request that waits for its headers when the caller's signal aborts", async () => {
    const url = await serve(() => {
      // Never answers: only the caller's signal ends the wait.
    });
    const controller = new AbortController();
    const pending = fetchWithoutDeadline(url, { method: 'POST', body: '{}', signal: controller.signal });
    setTimeout(() => controller.abort(new Error('the caller stopped')), 50);
    await expect(pending).rejects.toThrow('the caller stopped');
  });

  it('fails as fetch does when nothing listens', async () => {
    const url = await serve(() => {});
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(fetchWithoutDeadline(url, { method: 'POST', body: '{}' })).rejects.toThrow('fetch failed');
  });

  it('refuses what the transport never sends', async () => {
    await expect(fetchWithoutDeadline('file:///etc/hosts')).rejects.toThrow(TypeError);
    await expect(fetchWithoutDeadline('http://127.0.0.1:1', { body: new Uint8Array([1]) }))
      .rejects.toThrow('string body only');
  });
});
