#!/usr/bin/env node
// validate.mjs · check the committed SDK media against their sources, budgets and story.
//
//   node scripts/media/validate.mjs [--typecheck]
//
//  1. `vhs validate` passes on every tape;
//  2. every tape was rendered from the sources it has now (sha256 per file);
//  3. every export exists, is the file that was rendered, fits its budget
//     (GIF ≤ 3 MB, MP4 ≤ 4 MB, PNG ≤ 1 MB) and probes as expected
//     (1600x900, H.264 yuv420p with faststart, GIF and MP4 durations that agree);
//  4. each tape's stills are its Screenshot lines, one of them named after the tape;
//  5. no scene file or tape names a machine path;
//  6. each transcript still shows the tape's facts and nothing of this machine;
//  7. every image and video has a caption and alt text in media/captions.json;
//  8. each motion clip recorded under `motion` is the file committed, within budget;
//  9. media/ holds no file the manifest does not record;
// 10. with --typecheck: the scene .mts files and the README's demo.mts pass
//     `tsc --strict --erasableSyntaxOnly` against the PUBLISHED package's types.
//
// It needs the render tools (vhs, ffprobe…) but no network, except --typecheck,
// which installs the published package and TypeScript from the registry.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUDGET, FORBIDDEN_TEXT, HERE, MEDIA, PACKAGE, PROJECTS, ROOT, SCENES, TAPES, TOOL, VERSION,
  cleanEnv, listFiles, moovBeforeMdat, prepareToolbin, probe, readmeQuickStart, run,
  screenshotsOf, sha256,
} from './render.mjs';

const failures = [];
const fail = (message) => failures.push(message);
const ok = (message) => console.log(`  ✔ ${message}`);

// 1 · tapes parse
const tapes = ['theme.tape', ...TAPES.map((name) => `${name}.tape`)];
const parsed = run(TOOL.vhs, ['validate', ...tapes], { cwd: HERE, allow: [0, 1] });
if (parsed.code === 0) ok(`vhs validate · ${tapes.length} tapes`);
else fail(`vhs validate failed:\n${parsed.stdout}${parsed.stderr}`);

const manifestFile = join(MEDIA, 'media-sources.json');
if (!existsSync(manifestFile)) {
  console.error('✖ media/media-sources.json is missing: render first');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const captions = existsSync(join(MEDIA, 'captions.json'))
  ? JSON.parse(readFileSync(join(MEDIA, 'captions.json'), 'utf8'))
  : {};
const recorded = new Set();

const MACHINE_PATH = /\/Users\/|\/private\/|\/tmp\/|\/var\/folders\/|~\/|nika-swarm|nika-sdk-media/;

// 3 and 7 for one export: present, unchanged, within budget, captioned
function checkExport(owner, file, record) {
  recorded.add(file);
  const path = join(ROOT, file);
  if (!existsSync(path)) {
    fail(`${owner}: ${file} is missing`);
    return null;
  }
  if (sha256(path) !== record.sha256) fail(`${owner}: ${file} changed after the render`);
  const kind = file.split('.').at(-1);
  const bytes = readFileSync(path).length;
  if (BUDGET[kind] && bytes > BUDGET[kind]) fail(`${owner}: ${file} is ${bytes} bytes (budget ${BUDGET[kind]})`);
  if (kind !== 'txt') {
    const entry = captions[file];
    if (!entry?.caption || !entry?.alt) fail(`${owner}: ${file} has no caption or alt text in media/captions.json`);
  }
  return kind;
}

for (const name of TAPES) {
  const tape = manifest.tapes?.[name];
  if (!tape) {
    fail(`${name}: not rendered`);
    continue;
  }
  // 2 · sources unchanged since the render
  for (const [file, digest] of Object.entries(tape.sources)) {
    const path = join(ROOT, file);
    if (!existsSync(path)) fail(`${name}: source ${file} is gone`);
    else if (sha256(path) !== digest) fail(`${name}: ${file} changed since the render`);
  }
  const sceneFiles = listFiles(join(HERE, 'scenes', name)).map((file) => `scripts/media/scenes/${name}/${file}`);
  for (const file of sceneFiles) if (!tape.sources[file]) fail(`${name}: ${file} is newer than the render`);
  for (const [file, digest] of Object.entries(tape.readmeFiles ?? {})) {
    if (!digest) fail(`${name}: no README digest for ${file}`);
  }

  // 3 · exports: present, unchanged, within budget, probing as expected
  const durations = [];
  for (const [file, record] of Object.entries(tape.outputs)) {
    const kind = checkExport(name, file, record);
    if (kind === 'gif' || kind === 'mp4') {
      const path = join(ROOT, file);
      const p = probe(path);
      if (p.width !== 1600 || p.height !== 900) fail(`${name}: ${file} is ${p.width}x${p.height}`);
      if (p.audioStreams !== 0) fail(`${name}: ${file} carries audio`);
      if (kind === 'mp4' && (p.codec !== 'h264' || p.pixFmt !== 'yuv420p')) fail(`${name}: ${file} is ${p.codec}/${p.pixFmt}`);
      if (kind === 'mp4' && !moovBeforeMdat(path)) fail(`${name}: ${file} is not faststart`);
      durations.push(p.durationSeconds);
    }
  }
  if (durations.length && Math.max(...durations) - Math.min(...durations) > 0.25) {
    fail(`${name}: the GIF and MP4 durations disagree: ${durations.join(', ')}`);
  }

  // 4 · stills follow the tape; the one named after it is the reduced-motion frame
  const shots = screenshotsOf(name);
  for (const shot of shots) if (!tape.outputs[`media/stills/${shot}`]) fail(`${name}: still ${shot} not exported`);
  if (!shots.includes(`${name}.png`)) fail(`${name}: the tape takes no still named ${name}.png`);

  // 5 · no machine path in what the repository carries
  for (const file of [`scripts/media/${name}.tape`, ...sceneFiles]) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (MACHINE_PATH.test(text)) fail(`${file} names a machine path`);
  }

  // 6 · the transcript still tells the story, and nothing of this machine
  const transcriptFile = join(MEDIA, 'transcripts', `${name}.txt`);
  const transcript = existsSync(transcriptFile) ? readFileSync(transcriptFile, 'utf8') : '';
  for (const want of SCENES[name].transcript) if (!transcript.includes(want)) fail(`${name}: transcript lacks "${want}"`);
  for (const pattern of FORBIDDEN_TEXT) if (pattern.test(transcript)) fail(`${name}: transcript shows ${pattern}`);
  ok(`${name} · ${Object.keys(tape.outputs).length} exports · ${tape.terminal?.screens} screens, fullest ${tape.terminal?.fullestScreenRows}/${tape.terminal?.rows} rows`);
}

// 8 · motion clips: illustrations rendered elsewhere, recorded here by hash
for (const [name, clip] of Object.entries(manifest.motion ?? {})) {
  if (clip.kind !== 'illustration') fail(`${name}: a motion clip must be recorded as an illustration`);
  const durations = [];
  for (const [file, record] of Object.entries(clip.outputs ?? {})) {
    const kind = checkExport(name, file, record);
    if (kind === 'gif' || kind === 'mp4') {
      const p = probe(join(ROOT, file));
      if (p.width !== record.width || p.height !== record.height) fail(`${name}: ${file} is ${p.width}x${p.height}`);
      if (kind === 'mp4' && (p.codec !== 'h264' || p.pixFmt !== 'yuv420p')) fail(`${name}: ${file} is ${p.codec}/${p.pixFmt}`);
      durations.push(p.durationSeconds);
    }
  }
  if (durations.length && Math.max(...durations) - Math.min(...durations) > 0.25) {
    fail(`${name}: the GIF and MP4 durations disagree: ${durations.join(', ')}`);
  }
  ok(`${name} · illustration · ${Object.keys(clip.outputs ?? {}).length} exports`);
}

// 9 · nothing in media/ that no render or clip record names
for (const dir of ['gifs', 'videos', 'stills', 'transcripts']) {
  if (!existsSync(join(MEDIA, dir))) continue;
  for (const file of readdirSync(join(MEDIA, dir))) {
    if (!recorded.has(`media/${dir}/${file}`)) fail(`media/${dir}/${file} is recorded by no render or clip`);
  }
}
for (const file of Object.keys(captions)) {
  if (!file.startsWith('_') && !recorded.has(file)) fail(`media/captions.json captions ${file}, which no render or clip records`);
}

// The scripts may name system tools (/usr/bin/…) but never a user's or a scratch path.
const SCRIPT_PATH = /\/Users\/|\/private\/|\/var\/folders\//;
for (const file of ['scripts/media/theme.tape', 'scripts/media/render.mjs', 'scripts/media/validate.mjs', 'media/media-sources.json', 'media/captions.json']) {
  if (SCRIPT_PATH.test(readFileSync(join(ROOT, file), 'utf8'))) fail(`${file} names a machine path`);
}

// 10 · the scene TypeScript compiles strictly against the published types
if (process.argv.includes('--typecheck')) {
  prepareToolbin();
  const dir = join(PROJECTS, '_typecheck');
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const app = join(dir, 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: 'scene-typecheck', private: true, type: 'module' }, null, 2)}\n`);
  run(TOOL.npm, ['install', `${PACKAGE}@${VERSION}`, 'typescript@5', '@types/node@26'], {
    cwd: app, env: cleanEnv(home), timeout: 300_000,
  });
  // The quick start as this repository's README states it: the page the recordings sit in.
  const readme = readmeQuickStart(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  const files = [];
  mkdirSync(join(app, 'scenes/readme'), { recursive: true });
  writeFileSync(join(app, 'scenes/readme/demo.mts'), readme.files['demo.mts']);
  files.push('scenes/readme/demo.mts');
  for (const name of TAPES) {
    cpSync(join(HERE, 'scenes', name), join(app, 'scenes', name), { recursive: true });
    for (const file of listFiles(join(HERE, 'scenes', name))) {
      if (file.endsWith('.mts')) files.push(`scenes/${name}/${file}`);
    }
  }
  writeFileSync(join(app, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: 'es2024', lib: ['es2024'], module: 'nodenext',
      moduleResolution: 'nodenext', types: ['node'], erasableSyntaxOnly: true,
      verbatimModuleSyntax: true, skipLibCheck: false,
    },
    files,
  }, null, 2)}\n`);
  const tsc = run(join(app, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], { cwd: app, env: cleanEnv(home), allow: [0, 1, 2] });
  const version = run(join(app, 'node_modules/.bin/tsc'), ['--version'], { cwd: app, env: cleanEnv(home) }).stdout.trim();
  if (tsc.code === 0) ok(`tsc --strict (${version}) · ${files.length} files against ${PACKAGE}@${VERSION}`);
  else fail(`tsc --strict failed:\n${tsc.stdout}${tsc.stderr}`);
}

if (failures.length) {
  console.error(`✖ ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('✔ SDK media valid');
