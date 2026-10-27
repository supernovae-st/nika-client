#!/usr/bin/env node
// render.mjs · render the SDK tapes against the PUBLISHED package and its bundled engine.
//
//   node scripts/media/render.mjs [--preflight-only] [tape ...]
//
// Honesty contract: every frame is real output of the published
// @supernovae-st/nika package and the engine it bundles, run in a fresh
// scratch project, keyless (`mock/echo`). Nothing is typed into the output.
// The renderer refuses to record when the story a tape tells no longer holds
// (preflight), and refuses to publish a recording whose transcript misses a
// fact the tape is about or shows a machine path.
//
// For each tape:
//  1. a fresh $WORK (<projects>/<tape>) with app/, home/, out/, theme.tape, the tape;
//  2. scenes/<tape>/ copied into app/, plus hello.nika and demo.mts extracted
//     byte for byte from this repository's README (step 2 and step 3), the page
//     that embeds the recordings;
//  3. every tape except sdk-quickstart: `npm install @supernovae-st/nika@<version>`
//     in app/, from the registry (never a checkout);
//  4. the scene's preflight, in its own copy ($WORK/preflight), refuses to record
//     if the story no longer holds (sdk-quickstart: also if the commands it types
//     are not README step 1, the install pinned to <version>);
//  5. vhs with cwd $WORK and only a clean environment (no *_API_KEY, *_TOKEN,
//     *SECRET*); HOME is a scratch home with no key, no config and no keychain;
//  6. post-processing into media/: gifsicle -O3 (lossless: --lossy smears grey
//     specks next to glyphs), the mp4 remuxed with faststart, the tape's
//     Screenshot lines as pngquant stills, and a text transcript. Every tape
//     takes one still named after itself (media/stills/<tape>.png): the frame
//     the pages show to a reader who prefers reduced motion;
//  7. media/media-sources.json records sources, versions, outputs and probes.
//
// The repository keeps only what its pages use: a GIF to embed, an MP4 to
// pause and scrub, the stills and a transcript; no WebM. The sdk-doors motion
// clip is an illustration rendered by the engine repository's motion pipeline;
// media-sources.json records it under `motion`, and a render here leaves that
// entry as it is.
//
// validate.mjs imports the scene table from here; `node render.mjs` renders.
//
// The tapes' hidden first line routes the shell's stderr through a pipe: the
// engine prints a home-isolation notice on a terminal only when HOME differs
// from the account home, which a scratch HOME always does, and that notice
// would carry the scratch path into the recording. Every render checks, on a
// pseudo-terminal, that the notice is all this changes for the engine commands
// the tapes type (stderrRouting below). The engine's own captures keep the
// same notice out.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const MEDIA = join(ROOT, 'media');
const PROJECTS = process.env.SDK_MEDIA_PROJECTS ?? join(tmpdir(), 'nika-sdk-media');
const PACKAGE = '@supernovae-st/nika';
const VERSION = process.env.SDK_MEDIA_VERSION ?? '0.124.0';
// The captions name this exact build: a package that bundles another one is refused.
const ENGINE_BUILD = process.env.SDK_MEDIA_BUILD ?? '866ed914b';
const ENGINE_VERSION_LINE = `nika ${VERSION} (${ENGINE_BUILD})`;
const HOST_PAYLOAD = `nika-${platform()}-${arch()}`;
const TAPES = ['sdk-quickstart', 'sdk-events', 'sdk-admitted-executed-sealed', 'sdk-compile', 'sdk-remote'];
const BUDGET = { gif: 3 << 20, mp4: 4 << 20, png: 1 << 20 };
const FORBIDDEN_ENV = /_API_KEY$|_TOKEN$|SECRET/i;
// Nothing of this machine may reach a recording.
const FORBIDDEN_TEXT = [
  /\/Users\//, /\/private\//, /\/tmp\//, /\/var\/folders\//, /nika-sdk-media/, /nika-swarm/,
  /home isolation/, /ExperimentalWarning/, /npm (warn|WARN|ERR)/, /\bError:/, /zsh: /,
  /command not found/, /UNMET/,
];

// ── tools ────────────────────────────────────────────────────────────────
function which(name) {
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error(`${name} is not on PATH`);
  return found.stdout.trim();
}
const TOOL = {
  vhs: which('vhs'), ttyd: which('ttyd'), ffmpeg: which('ffmpeg'), ffprobe: which('ffprobe'),
  gifsicle: which('gifsicle'), pngquant: which('pngquant'), npm: join(dirname(process.execPath), 'npm'),
};

// PATH = node + system: a directory holding only node, npm, npx and what vhs
// itself needs (ttyd, ffmpeg). A nika on the outer PATH can never be reached.
const TOOLBIN = join(PROJECTS, '_toolbin');
function prepareToolbin() {
  rmSync(TOOLBIN, { recursive: true, force: true });
  mkdirSync(TOOLBIN, { recursive: true });
  const links = {
    node: process.execPath, npm: TOOL.npm, npx: join(dirname(process.execPath), 'npx'),
    ttyd: TOOL.ttyd, ffmpeg: TOOL.ffmpeg, ffprobe: TOOL.ffprobe,
  };
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(TOOLBIN, name));
}

function cleanEnv(home, extra = {}) {
  const env = {
    HOME: home,
    PATH: `${TOOLBIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    NIKA_KEYCHAIN: 'off',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    ...extra,
  };
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV.test(key)) throw new Error(`refusing to pass ${key} to a scene`);
  }
  return env;
}

function run(command, args, { cwd, env, timeout = 180_000, allow = [0] } = {}) {
  const res = spawnSync(command, args, {
    cwd, env, timeout, encoding: 'utf8', maxBuffer: 256 << 20,
  });
  if (res.error) throw new Error(`${command} ${args.join(' ')}: ${res.error.message}`);
  if (!allow.includes(res.status)) {
    throw new Error(`${command} ${args.join(' ')} exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sha256Text = (text) => createHash('sha256').update(text).digest('hex');

function expect(text, pattern, label) {
  const ok = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  if (!ok) throw new Error(`preflight · ${label}: expected ${pattern}\n--- observed ---\n${text}`);
}
function expectExact(text, wanted, label) {
  if (text !== wanted) {
    throw new Error(`preflight · ${label}: expected exactly\n${wanted}\n--- observed ---\n${text}`);
  }
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path, base) : [relative(base, path)];
  }).sort();
}

// ── the README: the quick start's source, and the page the recordings sit in ──
function readmeQuickStart(readme) {
  const fenced = (marker, fence, saveAs) => {
    const at = readme.indexOf(marker);
    if (at < 0) throw new Error(`README has no "${marker}"`);
    const saveAt = readme.indexOf(`Save this as \`${saveAs}\``, at);
    const opener = `\n\`\`\`${fence}\n`;
    const open = readme.indexOf(opener, at);
    if (saveAt < 0 || open < 0 || saveAt > open) throw new Error(`README step for ${saveAs} moved`);
    const start = open + opener.length;
    const end = readme.indexOf('\n```\n', start - 1);
    return readme.slice(start, end + 1);
  };
  const files = {
    'hello.nika': fenced('**2 · Write a workflow.**', 'yaml', 'hello.nika'),
    'demo.mts': fenced('**3 · Run it and verify it from TypeScript.**', 'ts', 'demo.mts'),
  };
  const runAt = readme.indexOf('```sh\nnode demo.mts\n```');
  const textOpen = readme.indexOf('```text\n', runAt);
  if (runAt < 0 || textOpen < 0) throw new Error('README no longer states the quick start output');
  const textStart = textOpen + '```text\n'.length;
  const expected = readme.slice(textStart, readme.indexOf('\n```\n', textStart - 1) + 1);
  // Step 1: the install and the key, the two commands sdk-quickstart types first.
  const oneAt = readme.indexOf('**1 · Install the package.**');
  const oneOpen = readme.indexOf('\n```sh\n', oneAt);
  if (oneAt < 0 || oneOpen < 0) throw new Error('README step 1 moved');
  const oneStart = oneOpen + '\n```sh\n'.length;
  const stepOne = readme.slice(oneStart, readme.indexOf('\n```\n', oneStart - 1)).split('\n');
  return { files, expected, stepOne, lines: readme.split('\n') };
}

// The commands a tape types on camera, in order (the hidden setup excluded).
function typedLines(name) {
  const tape = readFileSync(join(HERE, `${name}.tape`), 'utf8');
  const shown = tape.slice(tape.indexOf('\nShow\n'));
  return [...shown.matchAll(/^Type (?:"(.*)"|`(.*)`)$/gm)].map((m) => m[1] ?? m[2]);
}

function npmInstall(app, home) {
  return run(TOOL.npm, ['install', `${PACKAGE}@${VERSION}`], {
    cwd: app, env: cleanEnv(home), timeout: 300_000,
  });
}

function publishedPackage() {
  const dir = join(PROJECTS, '_package');
  rmSync(dir, { recursive: true, force: true });
  const app = join(dir, 'app');
  const home = join(dir, 'home');
  mkdirSync(app, { recursive: true });
  mkdirSync(home, { recursive: true });
  copyFileSync(join(HERE, 'scenes/sdk-quickstart/package.json'), join(app, 'package.json'));
  npmInstall(app, home);
  const root = join(app, 'node_modules', PACKAGE);
  const payloadRoot = join(app, 'node_modules/@supernovae-st', HOST_PAYLOAD);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== VERSION) throw new Error(`installed ${pkg.version}, wanted ${VERSION}`);
  const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'));
  const integrity = JSON.parse(readFileSync(join(payloadRoot, 'INTEGRITY.json'), 'utf8'));
  const source = JSON.parse(readFileSync(join(payloadRoot, 'SOURCE.json'), 'utf8'));
  const executable = join(payloadRoot, integrity.executable.file);
  if (sha256(executable) !== integrity.executable.sha256) {
    throw new Error('the payload executable does not match its INTEGRITY.json');
  }
  const identity = JSON.parse(run(join(app, 'node_modules/.bin/nika'), ['--sdk-identity'], {
    cwd: app, env: cleanEnv(home),
  }).stdout);
  if (identity.engineVersion !== VERSION || identity.buildSha !== ENGINE_BUILD || identity.machineProtocolVersion !== 2) {
    throw new Error(`engine identity ${identity.engineVersion} (${identity.buildSha}) / protocol ${identity.machineProtocolVersion}`);
  }
  // The programs come from this repository's README, the page that embeds the
  // recordings; the published README is recorded beside it, with whether its
  // quick start programs are the same bytes.
  const readme = readmeQuickStart(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  const publishedText = readFileSync(join(root, 'README.md'), 'utf8');
  let published = null;
  try {
    published = readmeQuickStart(publishedText);
  } catch {
    // an older README layout: recorded as not comparable
  }
  return {
    readme,
    record: {
      name: PACKAGE,
      version: pkg.version,
      registry: 'https://registry.npmjs.org/',
      resolved: lock.packages[`node_modules/${PACKAGE}`]?.resolved,
      integrity: lock.packages[`node_modules/${PACKAGE}`]?.integrity,
      readme: {
        file: `${PACKAGE}@${VERSION}/README.md`,
        sha256: sha256Text(publishedText),
        sameQuickStartPrograms: published !== null
          && Object.keys(readme.files).every((file) => readme.files[file] === published.files[file]),
      },
      payload: {
        name: `@supernovae-st/${HOST_PAYLOAD}`,
        version: JSON.parse(readFileSync(join(payloadRoot, 'package.json'), 'utf8')).version,
        integrity: lock.packages[`node_modules/@supernovae-st/${HOST_PAYLOAD}`]?.integrity,
        executableSha256: integrity.executable.sha256,
        matchesIntegrityJson: true,
        releaseAsset: integrity.archive,
        source,
      },
      engine: {
        engineVersion: identity.engineVersion,
        buildSha: identity.buildSha,
        specSha: identity.specSha,
        machineProtocolVersion: identity.machineProtocolVersion,
        supportedCapabilities: identity.supportedCapabilities,
      },
    },
  };
}

// ── the hidden first line: a pipe for stderr must hide one notice, nothing else ──
// Runs a command on a pseudo-terminal (stdin and stdout), with stderr on the
// terminal or on a pipe, and prints what a viewer would see. macOS `script`
// refuses a non-terminal stdin, so this uses the system python's pty module.
const PTY_RUN = [
  'import os, pty, subprocess, sys',
  'tty = sys.argv[1] == "tty"',
  'master, slave = pty.openpty()',
  'proc = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave if tty else subprocess.PIPE)',
  'os.close(slave)',
  'out = b""',
  'while True:',
  '    try:',
  '        data = os.read(master, 65536)',
  '    except OSError:',
  '        break',
  '    if not data:',
  '        break',
  '    out += data',
  'proc.wait()',
  'sys.stdout.buffer.write(out + (b"" if tty else proc.stderr.read()))',
  'sys.exit(proc.returncode)',
].join('\n');
const HOME_NOTICE = /^nika: home isolation: /;

// For each engine command a tape types on camera, in fresh homes: what the
// terminal shows with stderr on it, minus the notice, must be exactly what it
// shows with stderr on a pipe.
function stderrRouting(app, readme) {
  writeFileSync(join(app, 'hello.nika'), readme.files['hello.nika']);
  const checked = [];
  for (const args of [['--version'], ['key', 'init'], ['check', 'hello.nika']]) {
    const [onTerminal, onPipe] = ['tty', 'pipe'].map((mode) => {
      const home = join(PROJECTS, '_stderr', `${args[0]}-${mode}`);
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      const shown = run('/usr/bin/python3', ['-c', PTY_RUN, mode, join(app, 'node_modules/.bin/nika'), ...args], {
        cwd: app, env: cleanEnv(home),
      }).stdout;
      return shown.replaceAll('\r\n', '\n').replaceAll(home, '<HOME>')
        .replace(/fingerprint [0-9a-f]{16}/g, 'fingerprint <fp>').split('\n');
    });
    const kept = onTerminal.filter((line) => !HOME_NOTICE.test(line));
    if (kept.join('\n') !== onPipe.join('\n')) {
      throw new Error(`a pipe for stderr changes more than the home-isolation notice for nika ${args.join(' ')}:\n`
        + `${onTerminal.join('\n')}\n--- stderr on a pipe ---\n${onPipe.join('\n')}`);
    }
    checked.push({ command: `nika ${args.join(' ')}`, noticeLinesHidden: onTerminal.length - kept.length, linesShown: kept.length });
  }
  return checked;
}

// ── staging ──────────────────────────────────────────────────────────────
function stage(name, dir, readme, { install }) {
  const app = join(dir, 'app');
  const home = join(dir, 'home');
  mkdirSync(app, { recursive: true });
  mkdirSync(home, { recursive: true });
  cpSync(join(HERE, 'scenes', name), app, { recursive: true });
  for (const file of SCENES[name].readme) writeFileSync(join(app, file), readme.files[file]);
  if (!existsSync(join(app, 'package.json'))) {
    copyFileSync(join(HERE, 'scenes/sdk-quickstart/package.json'), join(app, 'package.json'));
  }
  if (install) npmInstall(app, home);
  return { app, home };
}

function sceneSources(name) {
  const files = {
    'scripts/media/theme.tape': sha256(join(HERE, 'theme.tape')),
    [`scripts/media/${name}.tape`]: sha256(join(HERE, `${name}.tape`)),
    'scripts/media/render.mjs': sha256(join(HERE, 'render.mjs')),
  };
  for (const file of listFiles(join(HERE, 'scenes', name))) {
    files[`scripts/media/scenes/${name}/${file}`] = sha256(join(HERE, 'scenes', name, file));
  }
  if (!existsSync(join(HERE, 'scenes', name, 'package.json'))) {
    files['scripts/media/scenes/sdk-quickstart/package.json'] =
      sha256(join(HERE, 'scenes/sdk-quickstart/package.json'));
  }
  return files;
}

function screenshotsOf(name) {
  return [...readFileSync(join(HERE, `${name}.tape`), 'utf8').matchAll(/^Screenshot out\/(\S+\.png)$/gm)]
    .map((m) => m[1]);
}

// ── ports (sdk-remote) ───────────────────────────────────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
// A listener left on the scene port is stopped only when its working
// directory is inside this render's $WORK: another session's server is never touched.
function stopSceneServer(port, work) {
  const listing = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' });
  const pids = [...(listing.stdout ?? '').matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
  const stopped = [];
  for (const pid of pids) {
    const cwd = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const dir = (cwd.stdout ?? '').match(/^n(.+)$/m)?.[1] ?? '';
    if (dir.startsWith(work) || dir.startsWith(`/private${work}`)) {
      process.kill(pid, 'SIGTERM');
      stopped.push(pid);
    } else {
      console.warn(`  ! port ${port} is held by pid ${pid} outside this render; left alone`);
    }
  }
  return stopped;
}

async function waitHealth(url, ms) {
  const deadline = Date.now() + ms;
  const started = Date.now();
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { health: await res.json(), afterMs: Date.now() - started };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`nika serve did not answer ${url}/health within ${ms} ms`);
}

// ── scenes: what each tape must show, checked before it is recorded ──────
const SCENES = {
  'sdk-quickstart': {
    readme: ['hello.nika', 'demo.mts'],
    install: false,
    async preflight({ app, home, nika, node, readme }) {
      // The two commands typed first are README step 1: the install, pinned to
      // the version this render installs, and the key the app's engine can read.
      const typed = typedLines('sdk-quickstart');
      const [readmeInstall, readmeKey] = readme.stepOne;
      expectExact(typed[0], `${readmeInstall}@${VERSION}`, 'the tape installs README step 1, pinned');
      expectExact(typed.find((line) => line.includes(' key init')), readmeKey, 'the tape mints the key with README step 1');
      const install = npmInstall(app, home);
      expect(install.stdout, /^added 2 packages in /m, 'npm install');
      const installed = readdirSync(join(app, 'node_modules/@supernovae-st')).sort();
      expectExact(installed.join(' '), `nika ${HOST_PAYLOAD}`, 'node_modules/@supernovae-st');
      expectExact(nika(['--version']).stdout.trim(), ENGINE_VERSION_LINE, 'nika --version');
      expect(nika(['key', 'init']).stdout, /^run-signing key minted · fingerprint [0-9a-f]{16}$/m, 'key init');
      if (!existsSync(join(home, '.nika/keys'))) throw new Error('preflight · key init left no file key under ~/.nika/keys');
      const demo = node(['demo.mts']);
      expectExact(demo.stdout, readme.expected, 'node demo.mts prints what the README promises');
      expectExact(demo.stderr, '', 'node demo.mts writes nothing to stderr');
      return {
        readmeStepOne: readme.stepOne, install: install.stdout.trim(), installed,
        demo: demo.stdout.trim().split('\n'),
      };
    },
    transcript: [
      `npm install ${PACKAGE}@${VERSION}`, 'added 2 packages', HOST_PAYLOAD, ENGINE_VERSION_LINE,
      'NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init', 'run-signing key minted', 'nika: hello',
      'prompt: "Say hello from the Nika SDK."',
      "import { Nika, isNikaRunSucceeded } from '@supernovae-st/nika';",
      'mock(echo) · Say hello from the Nika SDK.', 'receipt verified',
    ],
  },
  'sdk-events': {
    readme: [],
    install: true,
    async preflight({ nika, node }) {
      const check = nika(['check', 'brief.nika']);
      expect(check.stdout, 'PLAN     3 waves · 4 tasks · max parallelism 2', 'nika check plan');
      expect(check.stdout, 'run ready ✔', 'nika check verdict');
      const watch = node(['watch.mts']).stdout;
      const events = watch.split('\n').filter((line) => /^\s*\d+\.\ds  \S/.test(line));
      if (events.length !== 16) throw new Error(`preflight · expected 16 events, saw ${events.length}\n${watch}`);
      expect(watch, /^\s+0\.0s  run\.started/m, 'run.started first');
      expect(watch, /task\.completed  brief/, 'brief completes');
      expect(watch, /engine\.event    \(permit_checked\)/, 'engine frame on raw');
      expect(watch, /run\.settled     succeeded/, 'run.settled');
      expect(watch, 'result  succeeded · cause normal · 4/4 tasks ok', 'result()');
      const review = events.find((line) => /task\.started    review/.test(line));
      const at = Number(review?.trim().split('s')[0]);
      if (!(at >= 1.9)) throw new Error(`preflight · the nika:wait gate did not hold wave 2 (review at ${at}s)`);
      return { events: events.map((line) => line.trim()), reviewStartedAt: at };
    },
    transcript: [
      'PLAN     3 waves · 4 tasks · max parallelism 2', 'for await (const event of run.events())',
      'run.started', 'task.scheduled  audience', 'task.completed  brief', '(permit_checked)',
      '(workflow_completed)', 'run.settled     succeeded', 'result  succeeded · cause normal · 4/4 tasks ok',
    ],
  },
  'sdk-admitted-executed-sealed': {
    readme: ['hello.nika'],
    install: true,
    async preflight({ app, nika, node, sh }) {
      const refused = node(['gate.mts', 'list-files.nika']).stdout;
      expect(refused, 'check  refused · exit 2', 'check() refuses');
      expect(refused, 'NIKA-SEC-004', 'finding code');
      expect(refused, 'exec task under a boundary that forbids shells (task `list`) — fix: add "ls" to permits.exec', 'finding message');
      expect(refused, 'run    not started · NIKA-SEC-004 · no run, no events, no trace', 'run() refuses');
      const traces = join(app, '.nika/traces');
      if (existsSync(traces) && readdirSync(traces).length > 0) {
        throw new Error('preflight · a refused run left a trace behind');
      }
      const diff = sh('/usr/bin/diff', ['-u', 'list-files.nika', 'fixed/list-files.nika'], [1]).stdout;
      expect(diff, '+  exec: [ls]', 'the one-line permits fix');
      const clean = node(['gate.mts', 'fixed/list-files.nika']).stdout;
      expect(clean, 'check  clean · exit 0', 'fixed file checks clean');
      expect(clean, /run    succeeded · \d+ entries listed/, 'fixed file runs');
      const unsealed = node(['prove.mts']).stdout;
      expect(unsealed, /run      succeeded · mock\(echo\) · Say hello from the Nika SDK\./, 'executed');
      expect(unsealed, /receipt  sealed false · 5 events · head [0-9a-f]{12}…/, 'unsealed receipt');
      expect(unsealed, 'verify   not verified · invalid · receipt_mismatch', 'unsealed verify');
      expect(nika(['key', 'init']).stdout, /^run-signing key minted/m, 'key init');
      const sealed = node(['prove.mts']).stdout;
      expect(sealed, /receipt  sealed true · 6 events · head [0-9a-f]{12}…/, 'sealed receipt');
      expect(sealed, 'verify   verified', 'sealed verify');
      const receipt = JSON.parse(readFileSync(join(app, 'receipt.json'), 'utf8'));
      if (typeof receipt.trace_path !== 'string' || receipt.trace_path.startsWith('/')) {
        throw new Error(`preflight · the receipt names a machine path: ${receipt.trace_path}`);
      }
      const lastEvent = readFileSync(join(app, receipt.trace_path), 'utf8').trim().split('\n').at(-1);
      expect(lastEvent, '"run_sealed"', 'the sixth journal line is run_sealed');
      expect(node(['tamper.mts']).stdout, /^changed one byte on line 4 of \.nika\/traces\/\S+\.ndjson$/m, 'tamper');
      const broken = node(['verify.mts']).stdout;
      expect(broken, 'verify   not verified · invalid', 'tampered verify');
      expect(broken, /engine   BROKEN at line 5 — recorded chain [0-9a-f]+ · computed [0-9a-f]+/, 'engine names the line');
      return {
        refused: refused.trim().split('\n'), clean: clean.trim().split('\n'),
        unsealed: unsealed.trim().split('\n'), sealed: sealed.trim().split('\n'), broken: broken.trim().split('\n'),
      };
    },
    transcript: [
      'permits: {}', 'check  refused · exit 2', 'NIKA-SEC-004',
      'run    not started · NIKA-SEC-004 · no run, no events, no trace', '+  exec: [ls]',
      'check  clean · exit 0', 'run    succeeded', 'sealed false · 5 events',
      'not verified · invalid · receipt_mismatch', 'NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init',
      'run-signing key minted', 'sealed true · 6 events',
      'verify   verified', 'changed one byte on line 4 of .nika/traces/', 'verify   not verified · invalid',
      'BROKEN at line 5',
    ],
  },
  'sdk-compile': {
    readme: [],
    install: true,
    async preflight({ app, nika, node, sh }) {
      const intent = 'Every morning, summarize ./inbox/*.md into ./digest.md';
      const author = node(['author.mts', intent]).stdout;
      expect(author, 'round 1  incomplete · 1 required, 4 optional question(s)', 'round 1');
      expect(author, '? model', 'the required question is the runtime model');
      expect(author, '`every morning` is a trigger, not a task', 'trigger diagnostic');
      expect(author, 'round 2  ready · provider calls: none', 'round 2');
      expect(author, 'trigger schedule · daily · requires_binding', 'trigger stays a binding');
      expect(author, 'check    clean · exit 0 · kept as digest.nika', 'candidate checks clean');
      // Off camera: both rounds are generation 1 with deterministic cognition.
      writeFileSync(join(app, 'probe.mjs'), [
        "import { Nika, nextCompileRequest } from '@supernovae-st/nika';",
        'const nika = new Nika({ cwd: process.cwd() });',
        'const request = { intent: process.argv[2] };',
        'const first = await nika.compile(request);',
        "const second = await nika.compile(nextCompileRequest(request, first, { model: 'mock/echo' }));",
        'console.log(JSON.stringify([first, second].map((o) => ({ v: o.compile_version, cognition: o.provenance?.cognition, authoring: o.provenance?.authoring ?? null }))));',
      ].join('\n'));
      const probe = JSON.parse(node(['probe.mjs', intent]).stdout);
      rmSync(join(app, 'probe.mjs'));
      for (const round of probe) {
        if (round.v !== 1 || round.cognition !== 'deterministicOnly' || round.authoring !== null) {
          throw new Error(`preflight · a compile round was not deterministic: ${JSON.stringify(probe)}`);
        }
      }
      const boundary = sh('/usr/bin/sed', ['-n', '/^permits:/,/^tasks:/p', 'digest.nika']).stdout;
      for (const want of ['- ./inbox/**', '- ./digest.md', '- nika:assert', '- nika:glob', '- nika:jq', '- nika:read', '- nika:write']) {
        expect(boundary, want, 'requested boundary');
      }
      const check = nika(['check', 'digest.nika']).stdout;
      expect(check, 'PLAN     9 waves · 9 tasks', 'candidate plan');
      expect(check, 'wave 9 write_output (invoke · nika:write)', 'last wave writes');
      expect(check, 'run ready ✔', 'candidate is run ready');
      return { author: author.trim().split('\n'), rounds: probe, boundary: boundary.trim().split('\n') };
    },
    transcript: [
      'round 1  incomplete · 1 required, 4 optional question(s)', '? model',
      '`every morning` is a trigger, not a task', 'round 2  ready · provider calls: none',
      'trigger schedule · daily · requires_binding', 'check    clean · exit 0 · kept as digest.nika',
      '- ./inbox/**', '- ./digest.md', 'PLAN     9 waves · 9 tasks', 'wave 9 write_output',
    ],
  },
  'sdk-remote': {
    readme: ['hello.nika'],
    install: true,
    port: 8787,
    async preflight({ app, home, nika, node, readme }) {
      // The setup the tape types is the README's: its three setup lines and its
      // serve command verbatim (the tape only sends the server to the background),
      // and README step 1's key command.
      const typed = typedLines('sdk-remote');
      const background = ' > serve.log 2>&1 &';
      for (const line of typed.slice(0, 3)) {
        if (!readme.lines.includes(line)) throw new Error(`preflight · the README has no line "${line}"`);
      }
      expectExact(typed[3], readme.stepOne[1].replace(/ {3}#.*$/, `   # the server signs each job's record`), 'the key line is README step 1');
      const serveLine = typed.find((line) => line.includes(' serve --bind '));
      if (!serveLine?.endsWith(background) || !readme.lines.includes(serveLine.slice(0, -background.length))) {
        throw new Error(`preflight · the serve command is not the README's: ${serveLine}`);
      }
      const port = await freePort();
      const url = `http://127.0.0.1:${port}`;
      writeFileSync(join(app, 'nika.yaml'), 'nika: my-project\n');
      mkdirSync(join(app, '.nika'), { recursive: true });
      const tokenFile = join(app, '.nika/serve.token');
      const token = run('/usr/bin/openssl', ['rand', '-hex', '24']).stdout.trim();
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      expect(nika(['key', 'init']).stdout, /^run-signing key minted/m, 'key init');
      const log = join(app, 'serve.log');
      writeFileSync(log, '');
      const server = spawn(join(app, 'node_modules/.bin/nika'), [
        'serve', '--bind', `127.0.0.1:${port}`, '--workflows', '.', '--token-file', '.nika/serve.token',
      ], { cwd: app, env: cleanEnv(home), stdio: 'ignore' });
      const exited = new Promise((resolve) => server.once('exit', resolve));
      try {
        const { health, afterMs } = await waitHealth(url, 15_000);
        if (afterMs > 1500) throw new Error(`preflight · nika serve took ${afterMs} ms; the tape waits 1.8 s`);
        if (health.engineVersion !== VERSION || health.machineProtocolVersion !== 2) {
          throw new Error(`preflight · /health ${JSON.stringify(health)}`);
        }
        for (const capability of ['check', 'eventStream', 'cancel', 'jobInputs', 'compile']) {
          if (!health.supportedCapabilities?.includes(capability)) {
            throw new Error(`preflight · nika serve does not advertise ${capability}`);
          }
        }
        const remote = node(['remote.mts'], { NIKA_URL: url }).stdout;
        expect(remote, 'served   hello.nika\n', 'listWorkflows');
        expect(remote, 'check    clean', 'check by name');
        expect(remote, /^job      [0-9a-f-]{36}$/m, 'job id');
        expect(remote, '  #1 run.started running\n  #2 run.settled succeeded\n', 'two sequenced frames');
        expect(remote, 'result   succeeded · mock(echo) · Say hello from the Nika SDK.', 'result');
        expect(remote, "verify   verified · sealed (the server's verdict on its own journal)", 'server verdict');
        expect(remote, 'retry    the same job: it did not run twice', 'idempotent retry');
        expect(remote, 'bad token 401 unauthorized', 'typed 401');
        if (remote.includes(token)) throw new Error('preflight · the token reached the output');
        return {
          healthAfterMs: afterMs,
          health: {
            engineVersion: health.engineVersion,
            machineProtocolVersion: health.machineProtocolVersion,
            supportedCapabilities: health.supportedCapabilities,
          },
          remote: remote.trim().split('\n').map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, '<job uuid>')),
        };
      } finally {
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
        if (!(await portFree(port))) throw new Error(`preflight · port ${port} still held after stop`);
      }
    },
    transcript: [
      `"engineVersion":"${VERSION}"`, '"machineProtocolVersion":2', 'served   hello.nika', 'check    clean',
      '#1 run.started running', '#2 run.settled succeeded', 'result   succeeded · mock(echo) · Say hello from the Nika SDK.',
      'verify   verified · sealed', 'retry    the same job: it did not run twice', 'bad token 401 unauthorized',
    ],
  },
};

// ── transcript: the text of every screen the recording shows ─────────────
// vhs writes one text frame per tape command: the terminal buffer from its
// FIRST line, one terminal height of rows. A screen that scrolled would push
// lines into the buffer's scrollback and the frames would stop matching what
// the viewer sees, so a tape must never scroll: every screen fits, and Ctrl+L
// starts the next one. Both are checked here, not assumed.
function readFrames(file) {
  const parts = readFileSync(file, 'utf8').split(/^─{40,}\n?/m).map((part) => {
    const rows = part.split('\n').map((line) => line.trimEnd());
    if (rows[0] === '') rows.shift();
    if (rows.at(-1) === '') rows.pop();
    return rows;
  });
  // The setup frames (vhs's own prompt, before the tape's `Show`) are not part of the film.
  const first = parts.findIndex((rows) => rows.some((line) => line === '$' || line.startsWith('$ ')));
  if (first < 0) throw new Error(`${file}: no frame shows the tape's prompt`);
  const shown = parts.slice(first).filter((rows) => rows.some((line) => line !== ''));
  const height = Math.max(...shown.map((rows) => rows.length));
  const frames = shown.map((rows) => {
    const lines = [...rows];
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines;
  });
  return { frames, height };
}
function screensOf(name, frames) {
  const screens = [];
  let current = null;
  for (const frame of frames) {
    if (current && frame.length < current.length) {
      // the only way a screen may shrink is a clean Ctrl+L: a bare prompt
      if (frame.length !== 1 || frame[0] !== '$') {
        throw new Error(`${name}: the terminal scrolled or redrew; frame after\n${current.join('\n')}\nis\n${frame.join('\n')}`);
      }
      screens.push(current);
    }
    current = frame;
  }
  if (current) screens.push(current);
  for (const screen of screens) {
    if (screen.at(-1) !== '$') {
      throw new Error(`${name}: a screen does not end on the prompt (it overflowed or a command never returned):\n${screen.join('\n')}`);
    }
  }
  return screens;
}

function checkTranscript(name, text, work) {
  for (const want of SCENES[name].transcript) {
    if (!text.includes(want)) throw new Error(`${name}: the recording never shows "${want}"`);
  }
  for (const pattern of FORBIDDEN_TEXT) {
    if (pattern.test(text)) throw new Error(`${name}: the recording shows ${pattern}`);
  }
  const tokenFile = join(work, 'app/.nika/serve.token');
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (token && text.includes(token)) throw new Error(`${name}: the serve token reached the recording`);
  }
}

// ── probes ───────────────────────────────────────────────────────────────
function probe(file) {
  const res = run(TOOL.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_frames', file]);
  const data = JSON.parse(res.stdout);
  const video = data.streams.find((s) => s.codec_type === 'video');
  return {
    codec: video.codec_name,
    pixFmt: video.pix_fmt,
    width: video.width,
    height: video.height,
    frames: Number(video.nb_read_frames ?? video.nb_frames ?? 0),
    frameRate: video.avg_frame_rate,
    durationSeconds: Number(Number(data.format.duration ?? video.duration ?? 0).toFixed(2)),
    audioStreams: data.streams.filter((s) => s.codec_type === 'audio').length,
  };
}
function moovBeforeMdat(file) {
  const buf = readFileSync(file);
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    offset += size === 1 ? Number(buf.readBigUInt64BE(offset + 8)) : size;
    if (size === 0) break;
  }
  return false;
}
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function outputRecord(file, extra = {}) {
  const bytes = statSync(file).size;
  return { bytes, sha256: sha256(file), ...extra };
}

// ── one tape ─────────────────────────────────────────────────────────────
async function renderTape(name, pkg, { preflightOnly }) {
  const scene = SCENES[name];
  if (!screenshotsOf(name).includes(`${name}.png`)) {
    throw new Error(`${name}.tape takes no still named ${name}.png: the pages need it for reduced motion`);
  }
  const work = join(PROJECTS, name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'out'), { recursive: true });

  // 4 · preflight in its own copy: the recording starts from a clean state
  const pf = stage(name, join(work, 'preflight'), pkg.readme, { install: scene.install });
  const pfEnv = cleanEnv(pf.home);
  const ctx = {
    ...pf,
    env: pfEnv,
    readme: pkg.readme,
    nika: (args) => run(join(pf.app, 'node_modules/.bin/nika'), args, { cwd: pf.app, env: pfEnv }),
    node: (args, extra) => run(process.execPath, args, { cwd: pf.app, env: cleanEnv(pf.home, extra) }),
    sh: (command, args, allow = [0]) => run(command, args, { cwd: pf.app, env: pfEnv, allow }),
  };
  const started = Date.now();
  const preflight = await scene.preflight(ctx);
  console.log(`  ✔ preflight ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (preflightOnly) return { name, preflight };

  // 1–3 · the recorded project
  copyFileSync(join(HERE, 'theme.tape'), join(work, 'theme.tape'));
  copyFileSync(join(HERE, `${name}.tape`), join(work, `${name}.tape`));
  const { app, home } = stage(name, work, pkg.readme, { install: scene.install });
  if (scene.port && !(await portFree(scene.port))) {
    throw new Error(`127.0.0.1:${scene.port} is taken: refusing to record ${name}`);
  }

  // 5 · vhs with a clean environment
  const renderStart = Date.now();
  const vhs = spawnSync(TOOL.vhs, [`${name}.tape`], {
    cwd: work, env: cleanEnv(home), encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64 << 20,
  });
  const renderSeconds = Number(((Date.now() - renderStart) / 1000).toFixed(1));
  writeFileSync(join(work, 'vhs.log'), `${vhs.stdout ?? ''}${vhs.stderr ?? ''}`);
  const leftover = scene.port ? stopSceneServer(scene.port, work) : [];
  if (vhs.status !== 0) throw new Error(`vhs ${name} exited ${vhs.status} (see ${join(work, 'vhs.log')})`);

  // the recording must show what the tape is about, and nothing of this machine
  const { frames, height } = readFrames(join(work, 'out', `${name}.txt`));
  const screens = screensOf(name, frames);
  const transcript = `${screens.map((lines) => lines.join('\n')).join('\n\n── screen cleared ──\n\n')}\n`;
  checkTranscript(name, frames.map((lines) => lines.join('\n')).join('\n'), work);
  const fullest = Math.max(...screens.map((screen) => screen.length));
  const shots = screenshotsOf(name);

  // 6 · post-process into media/
  for (const dir of ['gifs', 'videos', 'stills', 'transcripts']) mkdirSync(join(MEDIA, dir), { recursive: true });
  const out = join(work, 'out');
  const gif = join(MEDIA, 'gifs', `${name}.gif`);
  const mp4 = join(MEDIA, 'videos', `${name}.mp4`);
  run(TOOL.gifsicle, ['-O3', '-o', gif, join(out, `${name}.gif`)]);
  run(TOOL.ffmpeg, ['-v', 'error', '-y', '-i', join(out, `${name}.mp4`), '-map', '0', '-c', 'copy', '-movflags', '+faststart', mp4]);
  const stills = {};
  for (const shot of shots) {
    const target = join(MEDIA, 'stills', shot);
    const quant = run(TOOL.pngquant, ['--quality=80-95', '--strip', '--speed', '1', '--force', '--output', target, join(out, shot)], { allow: [0, 98, 99] });
    if (quant.code !== 0) copyFileSync(join(out, shot), target);
    stills[`media/stills/${shot}`] = outputRecord(target, { ...pngSize(target), quantized: quant.code === 0 });
  }
  const transcriptFile = join(MEDIA, 'transcripts', `${name}.txt`);
  writeFileSync(transcriptFile, transcript);

  const outputs = {
    [`media/gifs/${name}.gif`]: outputRecord(gif, probe(gif)),
    [`media/videos/${name}.mp4`]: outputRecord(mp4, { ...probe(mp4), faststart: moovBeforeMdat(mp4) }),
    ...stills,
    [`media/transcripts/${name}.txt`]: outputRecord(transcriptFile),
  };
  for (const [file, record] of Object.entries(outputs)) {
    const kind = file.split('.').at(-1);
    const budget = BUDGET[kind];
    if (budget && record.bytes > budget) throw new Error(`${file} is ${record.bytes} bytes (budget ${budget})`);
  }
  return {
    name,
    sources: sceneSources(name),
    readmeFiles: Object.fromEntries(scene.readme.map((file) => [file, sha256Text(pkg.readme.files[file])])),
    preflight,
    renderSeconds,
    leftoverServersStopped: leftover,
    terminal: { rows: height, screens: screens.length, fullestScreenRows: fullest },
    screenshots: shots,
    outputs,
  };
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const preflightOnly = args.includes('--preflight-only');
  const names = args.filter((arg) => !arg.startsWith('--'));
  for (const name of names) if (!TAPES.includes(name)) throw new Error(`unknown tape ${name}`);
  const selected = names.length ? names : TAPES;

  mkdirSync(PROJECTS, { recursive: true });
  prepareToolbin();
  console.log(`→ ${PACKAGE}@${VERSION} from the registry`);
  const pkg = publishedPackage();
  console.log(`  ✔ ${pkg.record.payload.name} · engine ${pkg.record.engine.engineVersion} (${pkg.record.engine.buildSha}) · protocol ${pkg.record.engine.machineProtocolVersion}`);
  const stderrChecked = stderrRouting(join(PROJECTS, '_package/app'), pkg.readme);
  console.log(`  ✔ a pipe for stderr hides only the home-isolation notice (${stderrChecked.map((c) => c.command).join(', ')})`);

  const sourcesFile = join(MEDIA, 'media-sources.json');
  const manifest = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, 'utf8')) : { tapes: {} };
  for (const name of selected) {
    console.log(`→ ${name}`);
    const result = await renderTape(name, pkg, { preflightOnly });
    if (preflightOnly) continue;
    manifest.tapes[name] = { ...result, renderedAt: new Date().toISOString() };
    console.log(`  ✔ rendered ${name} in ${result.renderSeconds} s`);
  }
  if (preflightOnly) return;

  const vhsVersion = run(TOOL.vhs, ['--version']).stdout.trim();
  const ffmpegVersion = run(TOOL.ffmpeg, ['-version']).stdout.split('\n')[0];
  manifest.package = pkg.record;
  manifest.tools = {
    vhs: vhsVersion,
    ttyd: run(TOOL.ttyd, ['--version']).stdout.trim(),
    ffmpeg: ffmpegVersion,
    gifsicle: run(TOOL.gifsicle, ['--version']).stdout.split('\n')[0],
    pngquant: run(TOOL.pngquant, ['--version']).stdout.trim(),
    node: process.version,
    npm: run(TOOL.npm, ['--version'], { env: cleanEnv(join(PROJECTS, '_package/home')) }).stdout.trim(),
    zsh: run('/bin/zsh', ['--version']).stdout.trim(),
  };
  manifest.runner = { os: platform(), arch: arch(), release: release() };
  manifest.environment = {
    vars: Object.keys(cleanEnv('<scratch home>')),
    HOME: 'a fresh scratch home per render: no key, no config, no npm cache',
    PATH: 'node, npm, npx, ttyd and ffmpeg links + /usr/bin:/bin:/usr/sbin:/sbin',
    stderr: {
      route: 'exec 2> >(cat), the hidden first line of every tape',
      why: 'on a terminal, and only when HOME differs from the account home, the engine prints a home-isolation notice that names the scratch HOME',
      checked: 'on a pseudo-terminal, in fresh homes: with stderr on the terminal, removing that notice leaves exactly what a pipe shows',
      commands: stderrChecked,
    },
    model: 'mock/echo (offline rehearsal, no key, no network)',
  };
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(sourcesFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`→ ${relative(ROOT, sourcesFile)}`);
}

export {
  BUDGET, FORBIDDEN_TEXT, HERE, MEDIA, PACKAGE, PROJECTS, ROOT, SCENES, TAPES, TOOL, VERSION,
  checkTranscript, cleanEnv, listFiles, moovBeforeMdat, npmInstall, prepareToolbin, probe,
  readFrames, readmeQuickStart, run, screenshotsOf, screensOf, sha256, sha256Text,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✖ ${error.message}`);
    process.exit(1);
  });
}
