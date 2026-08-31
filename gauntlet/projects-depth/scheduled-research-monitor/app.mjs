import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { Nika, NikaOperationError } from '@supernovae-st/nika-client';

const engine = process.env.NIKA_BIN;
assert(engine, 'NIKA_BIN is required');
const token = 'depth-schedule-token-0123456789abcdef01234567';
const runtime = path.join(process.cwd(), '.runtime');
await mkdir(runtime, { recursive: true });
const tokenFile = path.join(runtime, 'serve.token');
await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
await chmod(tokenFile, 0o600);
const stateRoot = path.join(runtime, 'state');
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
let activeServer;

try {
  activeServer = await startServer();
  let nika = client();
  assert.equal((await nika.check('workflow.nika.yaml')).clean, true);
  const created = await nika.schedule('workflow.nika.yaml', {
    id: 'research-six-hourly',
    when: { kind: 'cadence', expression: 'TZ=UTC 0 */6 * * *' },
    maxCostUsd: 0.000001,
    missed: 'catch-up-once',
    overlap: 'skip',
    afterSkip: 'next_slot',
  });
  assert.equal(created.applied, true);
  const originalRevision = created.status.revision;
  const pauseUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const paused = await nika.schedule('workflow.nika.yaml', {
    id: 'research-six-hourly',
    when: { kind: 'cadence', expression: 'TZ=UTC 0 */6 * * *' },
    maxCostUsd: 0.000001,
    missed: 'catch-up-once',
    overlap: 'skip',
    afterSkip: 'next_slot',
    revision: originalRevision,
    active: false,
    pauseReason: 'depth restart exercise',
    pauseUntil,
  });
  assert.notEqual(paused.status.revision, originalRevision);
  let staleError;
  try {
    await nika.schedule('workflow.nika.yaml', {
      id: 'research-six-hourly',
      when: { kind: 'cadence', expression: 'TZ=UTC 0 */6 * * *' },
      maxCostUsd: 0.000001,
      missed: 'catch-up-once',
      overlap: 'skip',
      afterSkip: 'next_slot',
      revision: originalRevision,
      active: false,
      pauseReason: 'stale writer',
      pauseUntil,
    });
  } catch (error) { staleError = error; }
  assert(staleError instanceof NikaOperationError);
  assert.equal(staleError.code, 'schedule_conflict');

  await stopServer(activeServer);
  activeServer = await startServer();
  nika = client();
  const restored = await nika.scheduleStatus('research-six-hourly');
  assert.equal(restored.revision, paused.status.revision);
  assert.equal(restored.active, false);
  const run = await nika.run('workflow.nika.yaml', { idempotencyKey: 'research-monitor-manual-001' });
  const events = [];
  for await (const event of nika.events(run)) events.push(event.sequence);
  const result = await run.done;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.outputs?.snapshot?.source_count, 3);

  console.log(JSON.stringify({
    project: 'scheduled-research-monitor',
    status: 'succeeded',
    schedule_cas_updated: true,
    stale_writer_error: { name: staleError.name, code: staleError.code, current_revision: staleError.currentRevision },
    revision_survived_restart: restored.revision === paused.status.revision,
    reconnect_event_sequences: events,
    deterministic_cost_cap_usd: 0,
  }));
} finally {
  if (activeServer && activeServer.exitCode === null) await stopServer(activeServer);
}

function client() {
  return new Nika({ url, token, allowInsecureHttp: true, bin: engine, cwd: process.cwd(), eventBufferSize: 128 });
}

async function startServer() {
  const child = spawn(engine, ['serve', '--bind', `127.0.0.1:${port}`, '--workflows', '.', '--token-file', tokenFile, '--state-root', stateRoot, '--plain'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostics += chunk; });
  child.diagnostics = () => diagnostics;
  await waitForHealth(url);
  return child;
}

async function stopServer(child) {
  child.kill('SIGINT');
  await Promise.race([new Promise((resolve) => child.once('close', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGTERM');
  if (child.exitCode && child.exitCode !== 130) throw new Error(`nika serve exited ${child.exitCode}: ${child.diagnostics().slice(-500)}`);
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nika serve did not become healthy');
}
