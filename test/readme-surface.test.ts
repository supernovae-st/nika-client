import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = (path: string) => new URL(`../${path}`, import.meta.url);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The programs the recordings run and the script that renders them are public surfaces too.
const mediaScripts = [
  'scripts/media/render.mjs',
  ...readdirSync(repo('scripts/media/scenes'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.mts'))
    .map((file) => `scripts/media/scenes/${file}`),
].map((file) => readFileSync(repo(file), 'utf8'));
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports?: Record<string, unknown>; files?: string[] };
const page = (name: string) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
const httpApi = page('http-api.md');
const runs = page('runs.md');
const server = page('server.md');
const receipts = page('receipts.md');
const errors = page('errors.md');
// The pages the package ships under docs/ (package.json `files`), the README with them.
const shipped = [
  readme,
  ...['README.md', 'runs.md', 'server.md', 'receipts.md', 'errors.md', 'compile.md',
    'http-api.md', 'upgrading-to-0.123.md', 'glossary.md', 'architecture.md', 'testing.md']
    .map(page),
];

describe('packed public documentation', () => {
  it('names the exported One SDK surface and current runtime floor', () => {
    for (const operation of [
      'check',
      'run',
      'events',
      'cancel',
      'schedule',
      'scheduleStatus',
      'traceVerify',
    ]) {
      expect(readme).toContain(`\`${operation}\``);
    }
    expect(readme).toContain('Node.js 22 or newer');
    expect(readme).toContain('NIKA_BIN');
    // The schedule declaration and its pause live on the server page.
    expect(server).toContain('maxCostUsd: 0.01');
    expect(server).toContain('pauseUntil:');
  });

  it('teaches literal inputs without promising an engine that lacks the channel', () => {
    // Issue #116: the public word is `inputs`, with the same meaning on both
    // transports, and it is honest about what the connected engine must advertise.
    for (const surface of [readme, runs]) {
      expect(surface).toContain("inputs: { ticketId: '42' }");
      expect(surface).toContain('`inputsLiteral`');
      expect(surface).toContain('`jobInputs`');
      expect(surface).toContain('never falls back to `--var`');
      expect(surface).toMatch(/`vars`[^.]*deprecated/);
    }
    // The two sentences that described the world before the envelope.
    for (const surface of shipped) {
      expect(surface).not.toContain('request envelopes for per-call `vars`');
      expect(surface).not.toContain('yes; `vars`, `model`, `maxCostUsd` allowed');
    }
    expect(httpApi).toContain('`jobInputs`');
    expect(httpApi).not.toContain('remote `run()` refuses\n  `vars`, `model`, and `maxCostUsd` until');
  });

  it('teaches access, the 16 MiB buffer, the queued frame, the schedule codes and the cancel grace (NIK-267)', () => {
    // `access` on both doors, with the engine's refusals.
    for (const surface of [readme, runs]) {
      expect(surface).toContain("{ access: 'codex' }");
      expect(surface).toContain('`NIKA-1802`');
      expect(surface).toContain('`NIKA-1801`');
    }
    expect(runs).toContain("`capability: 'snapshotAccess'`");
    expect(runs).toContain('`verdicts.access_ready: false`');
    expect(server).toContain('`access`');
    // The default holds any result a server settles, and the refusal names the option.
    expect(readme).toContain('| `machineBufferBytes` | 16 MiB |');
    expect(runs).toContain('exceeded 65536 bytes (machineBufferBytes): it is 200756 bytes');
    for (const surface of shipped) {
      expect(surface).not.toContain('keep the default 64 KiB');
      expect(surface).not.toContain('`machineBufferBytes` (64 KiB');
    }
    // A job with inputs streams `execution.queued` first: never "two frames" in every case.
    for (const surface of [readme, runs, server, httpApi]) expect(surface).toContain('execution.queued');
    // The server's 412 code is schedule_precondition_failed; schedule_conflict is the package's name.
    expect(errors).not.toContain('`malformed_snapshot`, `schedule_conflict`');
    for (const surface of [errors, server]) {
      expect(surface).toContain("'schedule_precondition_failed'");
      expect(surface).toContain('schedule_conflict');
    }
    expect(errors).toContain('`schedule_refused`');
    // The fixed cancel grace and what a client sees past it.
    for (const surface of [server, runs]) {
      expect(surface).toMatch(/fixed 5-second grace|fixed 5 seconds/);
      expect(surface).toContain('`run.interrupted`');
    }
  });

  it('teaches the data engine 0.124 changes for an app', () => {
    // nika#1845 and #1850: the composed sheet, and an agent image saved by
    // `images: { save: }`, listed beside the image it was written from.
    for (const surface of [runs, server]) {
      expect(surface).toContain('`nika:image_compose`');
      expect(surface).toContain('images: { save: ./out/banner.png }');
      expect(surface).toContain('the same bytes under two names');
    }
    expect(httpApi).toContain('Names are unique, digests need not be');
    // nika#1845: the keyless voice is unpriced local work, never free.
    expect(runs).toContain('`cost_unpriced: local_model`');
    // nika#1844: a refused `vars` pair names the codes `inputs` already did.
    expect(runs).toMatch(/`vars` pair the engine refuses carries the\s+same code as `inputs`/);
    // nika#1842: the pause question, and failed harness turns as failures.
    expect(runs).toContain('`workflow_paused`');
    for (const code of ['`NIKA-1804`', '`NIKA-1805`', '`NIKA-1803`', '`NIKA-AGENT-007`', '`NIKA-SEC-014`']) {
      expect(errors).toContain(code);
    }
    // nika#1848: a finding's span; nika#1840: the composed calls ride untyped.
    expect(runs).toContain('`span`');
    expect(runs).toContain('`composed_calls`');
    // nika#1849: doctor names the binary that runs.
    expect(readme).toContain('`installer: npm-payload`');
  });

  it('teaches paid media under a cost cap as engine 0.124 merged it', () => {
    // nika#1846 (engine main 89606a28d): what stays unpriced is refused under
    // any cap, and the ways out are named.
    for (const word of ['`NIKA-1709`', '`NIKA-1704`', '`gpt-4o-mini-tts`', '`gpt-image-1.5`',
      '`gpt-image-1-mini`', '`provider: system`', '`gpt-image-2`', '`tts-1-hd`']) {
      expect(errors).toContain(word);
    }
    // The server door, read from the engine: the job is admitted, then the
    // runtime's launch gate refuses it before any task, with no settlement.
    for (const surface of [server, httpApi, runs]) {
      expect(surface).toContain('`NIKA-1709`');
      expect(surface).toMatch(/no\s+`settlement`/);
    }
    expect(server).toMatch(/admits\s+such a job \(`202`\)/);
    // What the spend reads: the bill under the tool's key, an unpriced call never zero.
    expect(runs).toContain("spend.by_source['nika:image_generate']");
    expect(runs).toContain('`cost_unpriced: missing_catalog_price`');
    expect(runs).toContain('`cost.media`');
    // The keyless voice runs under any cap, so "no cap" is scoped to the
    // paid calls the table cannot price.
    expect(errors).not.toContain('only a run with no cap makes an unpriced call');
    expect(errors).toMatch(/Only a run with no cap makes a paid call the table cannot\s+price/);
  });

  it('keeps the release stance word for word where it is stated', () => {
    const stance = '0.124 is the current release line. Work stays focused on maintenance, '
      + 'security and the media capabilities workflows need; native video is planned for 0.125.';
    const flat = (text: string) => text.replace(/\s+/g, ' ');
    for (const file of ['README.md', 'SECURITY.md', 'AGENTS.md']) {
      expect(flat(readFileSync(repo(file), 'utf8')), file).toContain(stance);
    }
  });

  it('documents the resident frame fields as the pinned 0.123 contract, and evidence as no verdict', () => {
    for (const word of ['`at`', '`evidence`', '`mirror_lost`', '`write_failed`', '`record_refused`']) {
      expect(httpApi).toContain(word);
    }
    // Engine 0.123.0 writes them and the pinned openapi.json declares them: the
    // page no longer calls them ahead of every released engine.
    expect(httpApi).toContain('declared in the pinned `openapi.json`');
    expect(httpApi).not.toContain('no released engine');
    // And about what it means: it reports a loss, it never judges the run.
    expect(httpApi).toContain('never changes `result.status`');
    expect(httpApi).toContain('absence claims nothing');
  });

  it('teaches a signing key the engine an app starts can read, on macOS and on Linux', () => {
    // That engine and `nika serve` read ~/.nika/keys/ (or the explicit pair), never a
    // keychain. Measured on the released 0.123.0 npm payload from a terminal, on macOS:
    // `nika` opens no keychain either (`nika doctor`: "not opened by this ad-hoc build"),
    // plain `nika key init` writes the files or refuses over an older release's keychain
    // key, and `nika key align` exits 2. From its source, on a Linux terminal: plain
    // `nika key init` refuses and `--force` stores the key in the Secret Service.
    // NIKA_KEYCHAIN=off writes the files on both, so the quick start keeps it.
    expect(readme).toContain('NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init');
    expect(readme).toContain('refuses on a Linux terminal');
    expect(receipts).toContain('the keychain is not opened by this ad-hoc build');
    expect(receipts).toContain('run-signing key material already exists');
    expect(receipts).toContain('NIKA_RUN_KEY_FILE');
    // `nika key align` is a Linux repair, and no released binary completes it on macOS:
    // each paragraph, item or row that names it says Linux (or that it cannot succeed),
    // and no clause in it sends a Mac there.
    for (const [name, surface] of [['README.md', readme], ['docs/receipts.md', receipts], ['docs/errors.md', errors]]) {
      for (const block of surface.split(/\n\s*\n|\n>\s*\n|\n(?=\s*(?:- |\|))/)) {
        if (!block.includes('key align')) continue;
        expect(block, `${name}: ${block}`).toMatch(/Linux|cannot succeed/);
        for (const clause of block.split(/(?<=[.;])\s+/)) {
          if (clause.includes('key align') && /\bmac(?:os)?\b/i.test(clause)) {
            expect(clause, `${name}: ${clause}`).toMatch(/cannot/);
          }
        }
      }
    }
  });

  it('reads an HTTP proof by `verified` first, in the server words', () => {
    // The sealed check the pages teach is the one examples/server-recovery.ts runs, which
    // check:package-surface compiles with --strict against the packed types: `verdict` is
    // optional, so a bare `.includes(proof.verdict)` does not compile.
    const sealedCheck = "proof.verified && ['sealed', 'anchored', 'replayed'].includes(proof.verdict ?? '')";
    expect(readFileSync(repo('examples/server-recovery.ts'), 'utf8')).toContain(sealedCheck);
    for (const surface of [readme, receipts]) {
      expect(surface).toContain('check `proof.verified` first');
      expect(surface).toContain(sealedCheck);
      expect(surface).not.toContain('.includes(proof.verdict)');
      expect(surface).toContain("verdict: 'ok', reason: 'unsealed'");
    }
  });

  it('describes the released 0.123.0, not a source tree waiting for npm', () => {
    for (const surface of shipped) {
      expect(surface).not.toMatch(/in no release yet|no released engine carries|not yet released/);
      expect(surface).not.toContain('is not on npm until the release');
      expect(surface).not.toMatch(/(?:measured|captured)[^.]*on engine 0\.120\.3/i);
    }
    // Engine media is pinned to the release tag that carries it, never to a moving branch.
    expect(readme).not.toContain('supernovae-st/nika/main/media/');
    // The hero is this repository's recording of the quick start on 0.123.0, not
    // the engine's typescript-client clip captured with 0.120.3.
    expect(readme).not.toContain('typescript-client.optimized.gif');
    expect(readme).toContain('src="media/gifs/sdk-quickstart.gif"');
    // The engine's nika-hero clip joins two captures: its check from 0.121.0 and the
    // committed run-meeting capture from 0.109.2 (engine 247ffad20, 2026-08-19).
    expect(readme).toContain('The audit was captured on engine 0.121.0; the run was captured on engine 0.109.2');
  });

  it('runs the quick start that examples/quick-start.ts holds, byte for byte', () => {
    const example = readFileSync(new URL('../examples/quick-start.ts', import.meta.url), 'utf8');
    expect(readme).toContain(`\`\`\`ts\n${example}\`\`\``);
  });

  it('exports package metadata so consumers can prove the installed pin', () => {
    expect(manifest.exports?.['./package.json']).toBe('./package.json');
    expect(readme).toContain("require('@supernovae-st/nika/package.json').version");
  });

  it('does not regress to removed APIs or claim a webhook verifier', () => {
    for (const publicSurface of [...shipped, ...mediaScripts]) {
      expect(publicSurface).not.toContain("from '@supernovae-st/nika/local'");
      expect(publicSurface).not.toContain('new LocalNika');
      expect(publicSurface).not.toContain('runToEnd(');
    }
    expect(readme).not.toContain('nika.jobs.');
    expect(readme).toContain('does not export a webhook-signature verifier');
  });
});

describe('media the pages embed', () => {
  type Outputs = Record<string, { sha256: string }>;
  const media = JSON.parse(readFileSync(repo('media/media-sources.json'), 'utf8')) as {
    tapes: Record<string, { outputs: Outputs }>;
    motion?: Record<string, { kind: string; outputs: Outputs }>;
    package: { version: string };
  };
  const captions = JSON.parse(readFileSync(repo('media/captions.json'), 'utf8')) as Record<
    string,
    { caption?: string; alt?: string }
  >;
  const pages = new Map<string, string>([
    ['README.md', readme],
    ...readdirSync(repo('docs'))
      .filter((file) => file.endsWith('.md'))
      .map((file): [string, string] => [`docs/${file}`, page(file)]),
  ]);
  // This repository by absolute URL: its raw files at HEAD (image embeds), and its file
  // and folder pages on main (links). npmjs.com rewrites a README's relative `img src`
  // to the raw prefix but leaves a relative `srcset` as it is (measured on its page for
  // execa), so every page names its reduced-motion stills by their raw URL. The docs
  // pages ship in the package and are read in node_modules too, where media/,
  // examples/ and scripts/ do not exist, so they name those files by their URL.
  const OWN = [
    'https://raw.githubusercontent.com/supernovae-st/nika-client/HEAD/',
    'https://github.com/supernovae-st/nika-client/blob/main/',
    'https://github.com/supernovae-st/nika-client/tree/main/',
  ];
  // A src naming one of our media files: relative, or by its raw HEAD URL.
  const OWN_MEDIA = String.raw`(?:(?![a-z]+:)[^"]*|https://raw\.githubusercontent\.com/supernovae-st/nika-client/HEAD/)media/`;
  // Every reference a page makes into this repository: src, srcset, href, markdown links.
  const ownReferences = [...pages].flatMap(([file, text]) =>
    [...text.matchAll(/(?:src|srcset|href)="([^"]+)"|\]\(([^)\s]+)\)/g)]
      .map((match) => match[1] ?? match[2] ?? '')
      .filter((target) => target !== '' && !target.startsWith('#'))
      .flatMap((target) => {
        // `?raw=true` makes GitHub serve an MP4 itself rather than its file page.
        const bare = target.split(/[?#]/)[0] ?? '';
        const own = OWN.find((prefix) => bare.startsWith(prefix));
        if (own) return [{ file, target, path: bare.slice(own.length), relative: false }];
        if (/^[a-z]+:/i.test(target)) return [];
        return [{ file, target, path: posix.normalize(posix.join(posix.dirname(file), bare)), relative: true }];
      }),
  );
  const references = ownReferences.filter(({ path }) => path.startsWith('media/'));
  const assets = references.filter(({ path }) => /^media\/(?:gifs|videos|stills|transcripts)\//.test(path));
  const recorded = new Map<string, string>();
  for (const entry of [...Object.values(media.tapes), ...Object.values(media.motion ?? {})]) {
    for (const [file, output] of Object.entries(entry.outputs)) recorded.set(file, output.sha256);
  }
  const committed = ['gifs', 'videos', 'stills', 'transcripts'].flatMap((dir) =>
    existsSync(repo(`media/${dir}`))
      ? readdirSync(repo(`media/${dir}`)).map((file) => `media/${dir}/${file}`)
      : [],
  );

  it('resolves every page reference to a committed file the render recorded', () => {
    expect(assets.length).toBeGreaterThan(0);
    for (const { file, target, path } of references) {
      expect(existsSync(repo(path)), `${file} → ${target}`).toBe(true);
    }
    for (const { file, target, path } of assets) {
      expect(recorded.has(path), `${file} → ${target} is not in media/media-sources.json`).toBe(true);
    }
  });

  it('resolves every link a page makes into this repository, relative or by URL', () => {
    expect(ownReferences.some(({ relative }) => !relative)).toBe(true);
    for (const { file, target, path } of ownReferences) {
      expect(existsSync(repo(path)), `${file} → ${target}`).toBe(true);
    }
  });

  it('keeps a shipped page relative only to files the package ships', () => {
    // npm packs package.json `files` (docs, dist…) plus package.json, README and LICENSE.
    const files = manifest.files ?? [];
    expect(files).toContain('docs');
    const shipped = (path: string) =>
      ['package.json', 'README.md', 'LICENSE'].includes(path) ||
      files.some((entry) => path === entry || path.startsWith(`${entry}/`));
    for (const { file, target, path, relative } of ownReferences) {
      if (file.startsWith('docs/') && relative) {
        expect(shipped(path), `${file} → ${target} is not in the package: link it by its GitHub URL`).toBe(true);
      }
    }
  });

  it('commits each recorded file byte for byte, and only files a page uses', () => {
    const used = new Set(assets.map(({ path }) => path));
    expect([...committed].sort()).toEqual([...recorded.keys()].sort());
    for (const file of committed) {
      const digest = createHash('sha256').update(readFileSync(repo(file))).digest('hex');
      expect(digest, `${file} is not the file the render recorded`).toBe(recorded.get(file));
      expect(used.has(file), `${file} is used by no page`).toBe(true);
    }
  });

  it('gives every image alt text and a caption, and every GIF a still for reduced motion', () => {
    for (const [file, text] of pages) {
      for (const [tag] of text.matchAll(/<img\b[^>]*>/g)) {
        if (new RegExp(`src="${OWN_MEDIA}`).test(tag)) {
          expect(tag, `${file}: an image without descriptive alt text`).toMatch(/\balt="[^"]{40,}"/);
        }
      }
      // Every animated image, ours or the engine's, has a still for reduced motion;
      // this repository's GIFs fall back to their own still under media/stills/.
      const gifs = [...text.matchAll(/<img\b[^>]*src="[^"]+\.gif"/g)].length;
      const pictures = [...text.matchAll(/<picture>[\s\S]*?<\/picture>/g)]
        .map(([block]) => block)
        .filter((block) => /<img\b[^>]*src="[^"]+\.gif"/.test(block));
      for (const block of pictures) {
        expect(block, `${file}: a GIF without a reduced-motion still`).toMatch(
          /<source media="\(prefers-reduced-motion: reduce\)" srcset="[^"]+\.png">/,
        );
        if (new RegExp(`<img\\b[^>]*src="${OWN_MEDIA}gifs/`).test(block)) {
          expect(block, `${file}: our GIF without its own still, in the form its renderer resolves`).toMatch(
            /srcset="https:\/\/raw\.githubusercontent\.com\/supernovae-st\/nika-client\/HEAD\/media\/stills\/[^"]+\.png"/,
          );
        }
      }
      expect(pictures.length, `${file}: a GIF outside a <picture>`).toBe(gifs);
    }
    for (const file of committed.filter((name) => !name.endsWith('.txt'))) {
      expect(captions[file]?.caption, `${file} has no caption`).toBeTruthy();
      expect(captions[file]?.alt, `${file} has no alt text`).toBeTruthy();
    }
  });

  it('labels the illustration as one, and every recording with the release it ran', () => {
    for (const [name, clip] of Object.entries(media.motion ?? {})) {
      expect(clip.kind, name).toBe('illustration');
      for (const file of Object.keys(clip.outputs)) {
        expect(captions[file]?.caption, file).toMatch(/illustration/i);
      }
    }
    // The release the render installed, as media-sources.json records it.
    const recordedRelease = media.package.version;
    expect(recordedRelease).toMatch(/^\d+\.\d+\.\d+$/);
    for (const entry of Object.values(media.tapes)) {
      for (const file of Object.keys(entry.outputs).filter((name) => !name.endsWith('.txt'))) {
        expect(captions[file]?.caption, file).toContain(recordedRelease);
      }
    }
    // A re-render relabels every caption and alt text: none names another release.
    for (const [file, entry] of Object.entries(captions)) {
      const text = typeof entry === 'string' ? entry : `${entry.caption ?? ''} ${entry.alt ?? ''}`;
      for (const [version] of text.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?!\.?\d)/g)) {
        expect(version, `${file} names ${version}, not the recorded ${recordedRelease}`).toBe(recordedRelease);
      }
    }
  });
});
