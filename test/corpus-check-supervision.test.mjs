import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { OwnedProcesses } from '../scripts/one-door/process.mjs';

const runner = new URL('../scripts/verify-gauntlet-corpus.mjs', import.meta.url).pathname;
const repo = path.resolve(new URL('..', import.meta.url).pathname);

for (const mode of ['success', 'invalid-json', 'not-ready', 'interrupted']) {
  test(`corpus check is an isolated, supervised observation: ${mode}`, { timeout: 15_000 }, async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'corpus-check-owner-test-'));
    const owned = new OwnedProcesses();
    const marker = path.join(scratch, 'started.json');
    const binary = path.join(scratch, 'nika');
    const results = path.join(scratch, 'must-not-record-execution');
    writeFileSync(binary, `#!${process.execPath}
      const fs = require('node:fs');
      if (process.argv[2] !== 'check') process.exit(21);
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid,
        cwd: process.cwd(), home: process.env.HOME, secret: process.env.NIKA_TEST_SECRET,
        project: fs.existsSync(require('node:path').join(process.cwd(), 'nika.yaml')) }));
      if (${JSON.stringify(mode)} === 'interrupted') {
        process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
      } else if (${JSON.stringify(mode)} === 'invalid-json') console.log('{');
      else console.log(JSON.stringify({ clean: true, paid_ready: ${mode !== 'not-ready'} }));
    `, { mode: 0o755 });
    try {
      const handle = owned.start(process.execPath, [runner], { cwd: repo, timeoutMs: 10_000, graceMs: 3000,
        env: { PATH: scratch, HOME: scratch, NIKA_BIN: binary,
          NIKA_GAUNTLET_RESULTS_DIR: results, NIKA_TEST_SECRET: 'not-for-engine' } });
      if (mode === 'interrupted') {
        const until = performance.now() + 3000;
        while (!existsSync(marker) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        assert(existsSync(marker));
        handle.signal('SIGINT');
      }
      const result = await handle.done;
      assert.equal(result.signal, null);
      assert.equal(result.code, mode === 'success' ? 0 : 1, result.stderr);
      assert.equal(result.stdout.includes('corpus-check green after owned cleanup'), mode === 'success');
      const observation = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(observation.project, true, 'an explicit project root must stop ancestor discovery');
      assert.notEqual(observation.cwd, repo);
      assert.notEqual(observation.home, scratch);
      assert.equal(observation.secret, undefined);
      assert.equal(existsSync(observation.cwd), false);
      assert.equal(existsSync(observation.home), false);
      assert.throws(() => process.kill(observation.pid, 0), { code: 'ESRCH' });
      assert.equal(existsSync(results), false, 'static checks must not manufacture execution evidence');
    } finally {
      await owned.close();
      rmSync(scratch, { recursive: true });
    }
  });
}
