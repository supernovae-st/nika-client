import assert from 'node:assert/strict';
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded } from './gauntlet-cancellation.mjs';
import { installProject, packedGauntlet, packSdk } from './packed-gauntlet.mjs';
import { stopResident, waitForHealth } from './one-door/resident.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runRecoveryE2e() {
  return packedGauntlet({ name: 'recovery-e2e', root }, async ({ scratch, nikaBin, env, start, run, signal }) => {
    const { filename, tarball } = await packSdk(root, scratch, run);
    const project = path.join(scratch, 'project');
    await installProject(path.join(root, 'gauntlet', 'recovery-e2e'), project, tarball, run);
    const token = 'recovery-e2e-token-0123456789abcdef0123456789';
    const tokenFile = path.join(scratch, 'serve.token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    const port = await freePort(signal);
    const url = `http://127.0.0.1:${port}`;
    const server = start(nikaBin, [
      'serve', '--bind', `127.0.0.1:${port}`, '--workflows', project,
      '--token-file', tokenFile, '--state-root', path.join(scratch, 'state'), '--plain',
    ], { cwd: project, timeoutMs: 90_000, maxBuffer: 1024 * 1024 });
    try {
      await waitForHealth(url, server, signal, { timeoutMs: 3_000 });
      const clientEnv = { ...env, NIKA_URL: url, NIKA_TOKEN: token };
      const producer = await run(process.execPath, ['client.mjs', 'producer'],
        { cwd: project, env: clientEnv, timeoutMs: 30_000 });
      const recoveryState = producer.trim().split('\n').at(-1);
      assert(recoveryState, 'producer did not persist a recovery state');
      const consumer = await run(process.execPath, ['client.mjs', 'consumer'],
        { cwd: project, env: { ...clientEnv, NIKA_RECOVERY_STATE: recoveryState }, timeoutMs: 30_000 });
      const result = JSON.parse(consumer.trim().split('\n').at(-1));
      assert.equal(result.project, 'two-process-durable-recovery');
      assert.equal(result.status, 'succeeded');
      return {
        engine: (await run(nikaBin, ['--version'], { timeoutMs: 5_000 })).trim(),
        package: filename, process_count: 2, installed_from_pack: true, ...result,
      };
    } finally {
      // Keep the original 3s shutdown obligation. TERM/KILL cleanup cannot
      // turn a missed graceful deadline into a successful recovery proof.
      await stopResident(server, { timeoutMs: 3_000 });
    }
  });
}

async function freePort(signal) {
  const probe = createServer();
  try {
    await bounded(new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen({ port: 0, host: '127.0.0.1', signal }, resolve);
    }), 3_000, 'loopback port reservation', signal);
    const address = probe.address();
    assert(address && typeof address === 'object');
    return address.port;
  } finally {
    await bounded(new Promise((resolve) => probe.close(resolve)), 1_000, 'port reservation cleanup');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await runRecoveryE2e();
