import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/verify-packed-install.mjs');
const VERSION = '0.116.0';
const PREPARED_COMMIT = 'a'.repeat(40);
const NATIVE_PACKAGE = nativePackageForHost();
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('fresh packed release install', () => {
  it('installs the two tarballs, imports the SDK, and executes the native CLI', () => {
    const fixture = packedFixture(VERSION);
    const result = verify(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installed and executed packed SDK + ${NATIVE_PACKAGE}`);
  }, 30_000);

  it('refuses a packed payload whose executable reports another engine version', () => {
    const fixture = packedFixture('0.115.0');
    const result = verify(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('packed engine identity is 0.115.0, expected 0.116.0');
  }, 30_000);
});

function verify(fixture: { client: string; native: string }) {
  return spawnSync(process.execPath, [
    SCRIPT,
    fixture.client,
    fixture.native,
    VERSION,
    PREPARED_COMMIT,
    NATIVE_PACKAGE,
  ], { encoding: 'utf8', timeout: 30_000 });
}

function packedFixture(engineVersion: string): { client: string; native: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'nika-packed-install-proof-'));
  scratch.push(root);
  const clientRoot = path.join(root, 'client');
  const nativeRoot = path.join(root, 'native');
  const tarballs = path.join(root, 'tarballs');
  mkdirSync(path.join(clientRoot, 'dist/bin'), { recursive: true });
  mkdirSync(path.join(nativeRoot, 'bin'), { recursive: true });
  mkdirSync(tarballs);

  writeFileSync(path.join(clientRoot, 'package.json'), JSON.stringify({
    name: '@supernovae-st/nika-client',
    version: VERSION,
    type: 'module',
    exports: './dist/index.js',
    bin: { nika: './dist/bin/nika.js' },
    optionalDependencies: { [NATIVE_PACKAGE]: VERSION },
    nikaRelease: { preparedCommit: PREPARED_COMMIT, version: VERSION },
  }));
  writeFileSync(path.join(clientRoot, 'dist/index.js'), [
    'export class Nika {',
    "  constructor() { this.transportKind = 'native-process'; }",
    '  async check() { return { clean: true, exitCode: 0 }; }',
    '}',
    '',
  ].join('\n'));
  const shim = path.join(clientRoot, 'dist/bin/nika.js');
  writeFileSync(shim, [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
    "import { createRequire } from 'node:module';",
    "import path from 'node:path';",
    'const require = createRequire(import.meta.url);',
    `const manifest = require.resolve('${NATIVE_PACKAGE}/package.json');`,
    "const result = spawnSync(path.join(path.dirname(manifest), 'bin/nika'), process.argv.slice(2),",
    "  { stdio: 'inherit' });",
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);

  writeFileSync(path.join(nativeRoot, 'package.json'), JSON.stringify({
    name: NATIVE_PACKAGE,
    version: VERSION,
    nikaRelease: { preparedCommit: PREPARED_COMMIT, version: VERSION },
  }));
  const binary = path.join(nativeRoot, 'bin/nika');
  writeFileSync(binary, [
    '#!/usr/bin/env node',
    "if (process.argv[2] === '--sdk-identity') {",
    `  console.log(JSON.stringify({ engineVersion: '${engineVersion}' }));`,
    "} else if (process.argv[2] === '--version') {",
    `  console.log('nika ${engineVersion} (fixture)');`,
    '} else {',
    '  process.exitCode = 2;',
    '}',
    '',
  ].join('\n'));
  chmodSync(binary, 0o755);

  return {
    client: pack(clientRoot, tarballs),
    native: pack(nativeRoot, tarballs),
  };
}

function pack(packageRoot: string, tarballs: string): string {
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', tarballs],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(output);
  return path.join(tarballs, filename);
}

function nativePackageForHost(): string {
  const name = ({
    'darwin-arm64': '@supernovae-st/nika-darwin-arm64',
    'darwin-x64': '@supernovae-st/nika-darwin-x64',
    'linux-arm64': '@supernovae-st/nika-linux-arm64',
    'linux-x64': '@supernovae-st/nika-linux-x64',
  } as Record<string, string>)[`${process.platform}-${process.arch}`];
  if (!name) throw new Error(`unsupported test host ${process.platform}-${process.arch}`);
  return name;
}
