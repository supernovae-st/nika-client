import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'nika-client-packed-'));
const PACKED_CLIENT = path.join(SCRATCH, 'packed-client');
let PACKED_TARBALL: string;
const HOST_PACKAGE = packageForCurrentHost();
const posix = process.platform !== 'win32';

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', SCRATCH],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(output);
  PACKED_TARBALL = path.join(SCRATCH, filename);
  const extracted = path.join(SCRATCH, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzf', PACKED_TARBALL, '-C', extracted]);
  renameSync(path.join(extracted, 'package'), PACKED_CLIENT);
}, 60_000);

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe.skipIf(!posix || !HOST_PACKAGE)('packed native distribution', () => {
  it('loads the supported host payload from an ESM import', () => {
    const project = stageProject(HOST_PACKAGE);
    const result = runNode(project, 'esm.mjs', `
      import { Nika } from '@supernovae-st/nika-client';
      const report = await new Nika().check('esm-packed.nika.yaml');
      console.log(JSON.stringify(report.argv));
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('esm-packed.nika.yaml');
  });

  it('loads the supported host payload from a CJS require', () => {
    const project = stageProject(HOST_PACKAGE);
    const result = runNode(project, 'cjs.cjs', `
      const { Nika } = require('@supernovae-st/nika-client');
      new Nika().check('cjs-packed.nika.yaml').then((report) => {
        console.log(JSON.stringify(report.argv));
      });
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cjs-packed.nika.yaml');
  });

  it('lets the Node process exit immediately after a durable schedule apply', () => {
    const project = stageProject(HOST_PACKAGE);
    const result = runNode(project, 'schedule-exit.mjs', `
      import { Nika } from '@supernovae-st/nika-client';
      const identity = {
        status: 'ok',
        service: 'nika-serve',
        engineVersion: '0.114.0',
        machineProtocolVersion: 1,
        snapshotFormatVersion: 1,
        checkReportVersion: 1,
        eventFormatVersion: 1,
        traceFormatVersion: 1,
        supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'schedule'],
      };
      const status = {
        definition: {
          id: 'exit', workflow: 'flow.nika.yaml',
          when: { kind: 'once', at: '2099-09-01T07:00:00Z' },
          maxCostUsd: 0.25, missed: 'skip', maxLatenessSeconds: null,
          overlap: 'skip', afterSkip: 'next_slot', jitter: null,
          tolerance: null, active: true, pauseReason: null, pauseUntil: null,
        },
        origin: 'api', revision: 'sha256:${'a'.repeat(64)}', active: true,
        pause: null, due: { kind: 'not_due' }, next: [],
        earliestWakeHint: null, lastDecision: null,
      };
      let request = 0;
      const fetch = async () => new Response(JSON.stringify(
        request++ === 0 ? identity : { applied: true, changed: true, status }
      ), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const nika = new Nika({
        url: 'https://nika.example', token: 'ssssssssssssssssssssssssssssssss', fetch,
      });
      const applied = await nika.schedule('flow.nika.yaml', {
        id: 'exit', when: { kind: 'once', at: '2099-09-01T07:00:00Z' },
        maxCostUsd: 0.25, missed: 'skip',
      });
      console.log(JSON.stringify({ applied: applied.applied, requests: request }));
    `);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ applied: true, requests: 2 });
  });

  it('reports NikaEngineUnavailable after npm install --omit=optional', () => {
    const project = stageOmittingOptional();
    const result = runUnavailable(project);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: 'NikaEngineUnavailable',
      code: 'NIKA_ENGINE_UNAVAILABLE',
      packageName: HOST_PACKAGE,
    });
  });

  it('does not select a payload for the wrong platform', () => {
    const wrong = allPackages().find((name) => name !== HOST_PACKAGE);
    const project = stageProject(wrong);
    const result = runUnavailable(project);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: 'NikaEngineUnavailable',
      packageName: HOST_PACKAGE,
    });
  });

  it('refuses a packaged executable whose integrity no longer matches', () => {
    const project = stageProject(HOST_PACKAGE);
    const suffix = HOST_PACKAGE.replace('@supernovae-st/nika-', '');
    appendFileSync(path.join(
      project,
      'node_modules',
      '@supernovae-st',
      `nika-${suffix}`,
      'bin',
      'nika',
    ), '\n// tampered\n');
    const result = runNode(project, 'tampered.mjs', `
      import { Nika } from '@supernovae-st/nika-client';
      try { await new Nika().check('must-not-run.nika.yaml'); } catch (error) {
        console.log(JSON.stringify({ name: error.name, capability: error.capability }));
      }
    `);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      name: 'NikaCompatibilityError',
      capability: 'engineIdentity',
    });
  });

  it('forwards the payload exit code through the project-local shim', () => {
    const project = stageProject(HOST_PACKAGE);
    const shim = path.join(
      project,
      'node_modules',
      '@supernovae-st',
      'nika-client',
      'dist',
      'bin',
      'nika.js',
    );
    const result = spawnSync(
      process.execPath,
      [shim, 'check', 'dirty-shim.nika.yaml', '--json'],
      { cwd: project, env: cleanEnv(), encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('dirty-shim.nika.yaml');
  });

  it('forwards signals to the payload and mirrors signal termination', async () => {
    const project = stageProject(HOST_PACKAGE);
    const shim = path.join(
      project,
      'node_modules',
      '@supernovae-st',
      'nika-client',
      'dist',
      'bin',
      'nika.js',
    );
    const child = spawn(process.execPath, [shim, 'wait-for-signal'], {
      cwd: project,
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', () => resolve());
    });
    child.kill('SIGTERM');
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    expect(code).toBeNull();
    expect(signal).toBe('SIGTERM');
  });
});

function stageProject(payloadPackage?: string): string {
  const project = mkdtempSync(path.join(SCRATCH, 'project-'));
  const scope = path.join(project, 'node_modules', '@supernovae-st');
  mkdirSync(scope, { recursive: true });
  cpSync(PACKED_CLIENT, path.join(scope, 'nika-client'), { recursive: true });
  if (payloadPackage) installFixturePayload(scope, payloadPackage);
  return project;
}

function stageOmittingOptional(): string {
  const project = mkdtempSync(path.join(SCRATCH, 'omit-optional-'));
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true }));
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--omit=optional', PACKED_TARBALL],
    { cwd: project, stdio: 'pipe' },
  );
  return project;
}

function installFixturePayload(scope: string, packageName: string): void {
  const suffix = packageName.replace('@supernovae-st/nika-', '');
  const source = path.join(FIXTURES, 'native-payloads', suffix);
  const destination = path.join(scope, `nika-${suffix}`);
  mkdirSync(path.join(destination, 'bin'), { recursive: true });
  copyFileSync(path.join(source, 'package.json'), path.join(destination, 'package.json'));
  const bin = path.join(destination, 'bin', 'nika');
  copyFileSync(path.join(FIXTURES, 'fake-nika.mjs'), bin);
  chmodSync(bin, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(bin)).digest('hex');
  writeFileSync(path.join(destination, 'INTEGRITY.json'), JSON.stringify({
    algorithm: 'sha256',
    executable: { file: 'bin/nika', sha256 },
  }));
}

function runUnavailable(project: string) {
  return runNode(project, 'missing.mjs', `
    import { Nika } from '@supernovae-st/nika-client';
    try { new Nika(); } catch (error) {
      console.log(JSON.stringify({
        name: error.name,
        code: error.code,
        packageName: error.packageName,
      }));
    }
  `);
}

function runNode(project: string, filename: string, source: string) {
  const entry = path.join(project, filename);
  writeFileSync(entry, source);
  return spawnSync(process.execPath, [entry], {
    cwd: project,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 2_000,
  });
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NIKA_BIN;
  return env;
}

function packageForCurrentHost(): string | undefined {
  return ({
    'darwin-arm64': '@supernovae-st/nika-darwin-arm64',
    'darwin-x64': '@supernovae-st/nika-darwin-x64',
    'linux-arm64': '@supernovae-st/nika-linux-arm64',
    'linux-x64': '@supernovae-st/nika-linux-x64',
  } as Record<string, string>)[`${process.platform}-${process.arch}`];
}

function allPackages(): string[] {
  return [
    '@supernovae-st/nika-darwin-arm64',
    '@supernovae-st/nika-darwin-x64',
    '@supernovae-st/nika-linux-arm64',
    '@supernovae-st/nika-linux-x64',
  ];
}
