import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { bounded } from '../scripts/gauntlet-cancellation.mjs';
import { OwnedProcesses } from '../scripts/one-door/process.mjs';
import { packedGauntlet } from '../scripts/packed-gauntlet.mjs';

const runners = [
  ['mini-saas', 'run-mini-saas-gauntlet.mjs'],
  ['recovery-e2e', 'run-recovery-e2e.mjs'],
];
const gone = (pid) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

for (const [name, script] of runners) {
  for (const selection of ['missing', 'relative', 'legacy']) {
    test(`${name} refuses ${selection} engine selection and invalidates old green`, async () => {
      const scratch = mkdtempSync(path.join(tmpdir(), 'packed-selection-test-'));
      const owned = new OwnedProcesses();
      const reportPath = path.join(scratch, `${name}.json`);
      const marker = path.join(scratch, 'build-started');
      writeFileSync(reportPath, '{"result":"green"}');
      writeFileSync(path.join(scratch, 'npm'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); process.exit(23);\n`, { mode: 0o755 });
      try {
        const env = { PATH: scratch, HOME: scratch, NIKA_KEYCHAIN: 'off', NIKA_GAUNTLET_RESULTS_DIR: scratch };
        if (selection === 'relative') env.NIKA_BIN = 'nika';
        if (selection === 'legacy') env.NIKA_GAUNTLET_BIN = process.execPath;
        const result = await owned.start(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname],
          { env, timeoutMs: 3000 }).done;
        assert.equal(result.code, 1);
        assert.equal(result.signal, null);
        assert.match(result.stderr, /NIKA_BIN must name an absolute engine binary/);
        assert(!existsSync(marker), 'refusal must precede npm and engine execution');
        assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).result, 'red');
      } finally {
        await owned.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  test(`${name} interruption reaps an uncooperative build before recording red`, { timeout: 10_000 }, async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'packed-interrupt-test-'));
    const owned = new OwnedProcesses();
    const reportPath = path.join(scratch, `${name}.json`);
    const marker = path.join(scratch, 'build.pid');
    mkdirSync(path.join(scratch, 'home'));
    writeFileSync(reportPath, '{"result":"green"}');
    writeFileSync(path.join(scratch, 'npm'), `#!${process.execPath}
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => {});
      writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      setInterval(() => {}, 1000);
    `, { mode: 0o755 });
    try {
      const handle = owned.start(process.execPath, [new URL(`../scripts/${script}`, import.meta.url).pathname],
        { timeoutMs: 7000, graceMs: 2500, env: { PATH: scratch, HOME: path.join(scratch, 'home'),
          NIKA_BIN: process.execPath, NIKA_KEYCHAIN: 'off', NIKA_GAUNTLET_RESULTS_DIR: scratch } });
      await bounded((async () => {
        const until = performance.now() + 1900;
        while (!existsSync(marker) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        assert(existsSync(marker), 'fake build must start');
      })(), 2000, 'fake build startup');
      const during = JSON.parse(readFileSync(reportPath, 'utf8'));
      const buildPid = Number(readFileSync(marker, 'utf8'));
      handle.signal('SIGINT');
      const result = await handle.done;
      gone(buildPid);
      gone(handle.child.pid);
      assert.equal(during.result, 'incomplete');
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      assert.equal(report.result, 'red');
      assert.match(report.error, /required SIGKILL/);
    } finally {
      await owned.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test.each(['success', 'failure', 'interrupted'])('packed evidence remains incomplete until cleanup settles (%s)', async (mode) => {
  const root = mkdtempSync(path.join(tmpdir(), 'packed-commit-test-'));
  const reportPath = path.join(root, 'proof.json');
  let resolveCleanup;
  let rejectCleanup;
  let reachedCleanup;
  let scratch;
  const closing = new Promise((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
  const entered = new Promise((resolve) => { reachedCleanup = resolve; });
  const owned = { close: () => { reachedCleanup(); return closing; } };
  try {
    const proof = packedGauntlet({ name: 'proof', root, owned,
      env: { NIKA_BIN: process.execPath, NIKA_GAUNTLET_RESULTS_DIR: root } }, async (context) => {
      scratch = context.scratch;
      return { measured: true };
    });
    const observed = proof.then((value) => ({ value }), (error) => ({ error }));
    await entered;
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).result, 'incomplete');
    assert(existsSync(scratch));
    if (mode === 'interrupted') process.emit('SIGINT');
    if (mode === 'failure') rejectCleanup(new Error('exit not established'));
    else resolveCleanup();
    const result = await observed;
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.result, mode === 'success' ? 'green' : 'red');
    assert.equal(Boolean(result.error), mode !== 'success');
    assert.equal(existsSync(scratch), mode === 'failure', 'only unproven process exit retains scratch');
  } finally {
    resolveCleanup();
    // The injected owner never spawned children, so this exact fixture is safe.
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true });
    rmSync(root, { recursive: true });
  }
});

test('an unawaited live consumer is reaped but cannot produce green', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'packed-live-test-'));
  let handle;
  try {
    await assert.rejects(packedGauntlet({ name: 'proof', root,
      env: { NIKA_BIN: process.execPath, NIKA_GAUNTLET_RESULTS_DIR: root } }, async ({ start }) => {
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      handle = start(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"],
        { timeoutMs: 2000, onStdout: ready });
      await started;
      return { measured: true };
    }), /required SIGTERM/);
    gone(handle.child.pid);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'proof.json'), 'utf8')).result, 'red');
  } finally { rmSync(root, { recursive: true }); }
});

test('the packed runner deadline aborts and reaps a blocked build', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'packed-deadline-test-'));
  let handle;
  try {
    await assert.rejects(packedGauntlet({ name: 'proof', root, timeoutMs: 50,
      env: { NIKA_BIN: process.execPath, NIKA_GAUNTLET_RESULTS_DIR: root } }, async ({ start }) => {
      handle = start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 2000 });
      await handle.done;
      return { measured: true };
    }), /proof exceeded 50ms/);
    gone(handle.child.pid);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'proof.json'), 'utf8')).result, 'red');
  } finally { rmSync(root, { recursive: true }); }
});
