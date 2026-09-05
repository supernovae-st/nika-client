import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { OwnedProcesses } from '../scripts/one-door/process.mjs';

const runner = new URL('../scripts/execute-gauntlet-corpus.mjs', import.meta.url).pathname;
const repo = path.resolve(new URL('..', import.meta.url).pathname);

for (const mode of ['missing', 'version-failed', 'run-failed', 'invalid-json', 'success', 'interrupted']) {
  test(`corpus owns its isolated execution and replaces stale evidence: ${mode}`, { timeout: 20_000 }, async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'corpus-owner-test-'));
    const owned = new OwnedProcesses();
    const reportPath = path.join(scratch, 'local-execution.json');
    const marker = path.join(scratch, 'started.json');
    const binary = path.join(scratch, 'nika');
    writeFileSync(reportPath, '{"result":"green","old":true}');
    writeFileSync(binary, `#!${process.execPath}
      const fs = require('node:fs');
      if (process.argv.includes('--version')) {
        console.log('nika 0.118.3 (8375f17e8)');
        process.exit(${mode === 'version-failed' ? 9 : 0});
      }
      if (process.argv[2] === 'key') process.exit(0);
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid,
        cwd: process.cwd(), home: process.env.HOME, secret: process.env.NIKA_TEST_SECRET,
        file: process.argv[3] }));
      if (${JSON.stringify(mode)} === 'interrupted') {
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      } else if (${JSON.stringify(mode)} === 'run-failed') process.exit(17);
      else if (${JSON.stringify(mode)} === 'invalid-json') console.log('{');
      else console.log(JSON.stringify({ file: process.argv[3] }));
    `, { mode: 0o755 });
    try {
      const handle = owned.start(process.execPath, [runner], { cwd: repo,
        env: { PATH: scratch, HOME: scratch, NIKA_TEST_SECRET: 'must-not-reach-engine',
          ...(mode === 'missing' ? {} : { NIKA_BIN: binary }), NIKA_GAUNTLET_RESULTS_DIR: scratch },
        timeoutMs: 15_000, graceMs: 3000 });
      if (mode === 'interrupted') {
        const until = performance.now() + 4000;
        while (!existsSync(marker) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
        assert(existsSync(marker));
        assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).result, 'incomplete');
        handle.signal('SIGINT');
      }
      const result = await handle.done;
      assert.equal(result.signal, null);
      assert.equal(result.code, mode === 'success' ? 0 : 1, result.stderr);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      assert.equal(report.result, mode === 'success' ? 'green' : 'red');
      assert.equal(report.old, undefined);
      if (existsSync(marker)) {
        const observation = JSON.parse(readFileSync(marker, 'utf8'));
        assert.notEqual(observation.cwd, repo);
        assert.notEqual(observation.home, scratch);
        assert.equal(observation.secret, undefined);
        assert.equal(existsSync(observation.cwd), false, 'owned project is removed after process exit');
        assert.equal(existsSync(observation.home), false, 'owned signing home is removed');
        assert.throws(() => process.kill(observation.pid, 0), { code: 'ESRCH' });
      }
      if (mode === 'success') {
        assert.equal(report.workflows, 100);
        assert.equal(report.distinct_output_hashes, 100);
      }
    } finally {
      await owned.close();
      rmSync(scratch, { recursive: true });
    }
  });
}
