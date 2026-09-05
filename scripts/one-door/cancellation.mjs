import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

// One execution at a time, held by an actual loopback tool request rather
// than stdout buffering or an estimated sleep. Deadlines FAIL the proof;
// they never release the fixture to manufacture a preferred settlement.
export class CancellationRendezvous {
  #server;
  #active;
  url;

  static async listen() {
    const gate = new CancellationRendezvous();
    gate.#server = createServer((request, response) => {
      void gate.#route(request, response).catch((error) => {
        response.writeHead(409).end(error.message);
      });
    });
    gate.#server.listen(0, '127.0.0.1');
    await once(gate.#server, 'listening');
    gate.url = `http://127.0.0.1:${gate.#server.address().port}`;
    return gate;
  }

  arm(label, timeoutMs = 10_000) {
    assert(!this.#active, 'finish the previous rendezvous first');
    const state = { label, token: randomUUID(), requests: { hold: 0, dependent: 0 }, released: false };
    state.arrived = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    state.arrived.catch(() => {});
    state.timer = setTimeout(() => {
      state.error = new Error(`${label}: cancellation rendezvous deadline exceeded`);
      state.reject(state.error);
      state.response?.destroy(state.error);
    }, timeoutMs);
    this.#active = state;
    return `${this.url}/control/${state.token}`;
  }

  get arrived() {
    assert(this.#active, 'rendezvous is not armed');
    return this.#active.arrived;
  }

  async release() {
    const state = this.#active;
    assert(state?.response && !state.released, 'exactly one held task required before release');
    if (state.error) throw state.error;
    state.released = true;
    state.response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"held":true}');
  }

  finish() {
    const state = this.#active;
    assert(state, 'rendezvous is not armed');
    if (state.error) throw state.error;
    assert(state.released, 'held task was not explicitly released');
    assert.equal(state.requests.hold, 1, 'exactly one in-flight task');
    assert.equal(state.requests.dependent, 0, 'dependent task must never execute');
    clearTimeout(state.timer);
    this.#active = undefined;
    return { cancel_point: 'loopback fetch held before response', release: 'after cancellation request acknowledgement',
      requests: { ...state.requests }, dependent_unstarted: true };
  }

  async #route(request, response) {
    const state = this.#active;
    assert(state, 'no active execution');
    if (request.method === 'GET' && request.url === '/hold') {
      assert.equal(++state.requests.hold, 1, 'duplicate hold request');
      state.response = response;
      state.resolve();
      return;
    }
    if (request.method === 'GET' && request.url === '/dependent') {
      state.requests.dependent++;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"dependent":true}');
      return;
    }
    const control = `/control/${state.token}`;
    if (request.method === 'GET' && request.url === `${control}/arrived`) {
      await state.arrived;
      response.writeHead(200).end('{}');
      return;
    }
    if (request.method === 'POST' && request.url === `${control}/release`) {
      await this.release();
      response.writeHead(200).end('{}');
      return;
    }
    response.writeHead(404).end();
  }

  async close() {
    if (this.#active) {
      clearTimeout(this.#active.timer);
      this.#active.reject(new Error('rendezvous closed'));
      this.#active.response?.destroy();
    }
    this.#server.closeAllConnections();
    await new Promise((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }
}
