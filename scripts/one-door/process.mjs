import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Every child gets its own POSIX process group. Native engines launched by an
// SDK consumer inherit that group, so cleanup never selects unrelated engines.
export class OwnedProcesses {
  #children = new Set();
  #closing;

  start(command, args, { timeoutMs, cwd, env, maxBuffer = 4 * 1024 * 1024,
    graceMs = 1500, killMs = 3000, onStdout, onStderr } = {}) {
    assert(process.platform !== 'win32', 'one-door process supervision requires POSIX process groups');
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'every subprocess needs a finite timeout');
    assert(!this.#closing, 'process supervisor is closing');
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let closed = false;
    let spawnError;
    let failure;
    let stopping;
    let timer;
    let rejectFailure;
    const closedResult = new Promise((resolve) => {
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    const alive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const signal = (value) => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, value); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const waitGone = async (milliseconds) => {
      const until = performance.now() + milliseconds;
      do {
        if (closed && !alive()) return true;
        await delay(20);
      } while (performance.now() < until);
      return closed && !alive();
    };
    const stop = () => {
      stopping ??= (async () => {
        signal('SIGTERM');
        if (await waitGone(graceMs)) return;
        signal('SIGKILL');
        assert(await waitGone(killMs), `owned process group ${child.pid} did not exit; retain its scratch directory`);
        await closedResult;
      })();
      return stopping;
    };
    const fail = (error) => {
      if (failure) return;
      failure = error;
      // Keep rejection immediate and supervised even when callers are still
      // waiting for server readiness rather than awaiting this handle's done.
      stop().then(() => rejectFailure(error), rejectFailure);
    };
    const handle = { child, stdout: '', stderr: '', signal, stop, done: undefined };
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    for (const [name, callback] of [['stdout', onStdout], ['stderr', onStderr]]) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        if (Buffer.byteLength(handle[name]) + Buffer.byteLength(chunk) > maxBuffer) {
          fail(new Error(`${command}: ${name} exceeded ${maxBuffer} bytes`));
          return;
        }
        handle[name] += chunk;
        try { callback?.(chunk, handle); } catch (error) { fail(error); }
      });
    }
    timer = setTimeout(() => fail(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
    handle.done = Promise.race([closedResult, failed]).then(async (result) => {
      if (stopping) await stopping;
      if (failure) throw failure;
      if (spawnError) throw spawnError;
      if (alive()) {
        await stop();
        throw new Error(`${command} exited with live descendants`);
      }
      return { ...result, stdout: handle.stdout, stderr: handle.stderr };
    }).finally(() => {
      clearTimeout(timer);
      if (closed && !alive()) this.#children.delete(handle);
    });
    handle.done.catch(() => {});
    this.#children.add(handle);
    return handle;
  }

  async run(command, args, options) {
    const result = await this.start(command, args, options).done;
    assert.equal(result.code, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }

  close() {
    this.#closing ??= (async () => {
      const results = await Promise.allSettled([...this.#children].map(async (handle) => {
        await handle.stop();
        await handle.done.catch(() => {});
      }));
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, 'owned process cleanup failed');
    })();
    return this.#closing;
  }
}
