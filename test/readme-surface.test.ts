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
) as { exports?: Record<string, unknown> };
const page = (name: string) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
const httpApi = page('http-api.md');
const runs = page('runs.md');
const server = page('server.md');
const receipts = page('receipts.md');
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

  it('teaches a signing key the engine an app starts can read', () => {
    // That engine has no terminal and never opens an OS keychain: the quick
    // start mints file custody and names the repair for a keychain-only key.
    expect(readme).toContain('NIKA_KEYCHAIN=off ./node_modules/.bin/nika key init');
    expect(readme).toContain('./node_modules/.bin/nika key align');
    expect(receipts).toContain('`nika key align`');
    expect(receipts).toContain('NIKA_RUN_KEY_FILE');
  });

  it('reads an HTTP proof by `verified` first, in the server words', () => {
    for (const surface of [readme, receipts]) {
      expect(surface).toContain('check `proof.verified` first');
      expect(surface).toContain("['sealed', 'anchored', 'replayed'].includes(proof.verdict)");
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
  // npmjs.com rewrites a README's relative `img src` to this raw prefix but leaves a
  // relative `srcset` as it is (measured on its page for execa), so the README names
  // its reduced-motion stills by this absolute URL; docs pages, read on GitHub, stay relative.
  const OWN_RAW = 'https://raw.githubusercontent.com/supernovae-st/nika-client/HEAD/';
  // Every reference a page makes into media/: src, srcset, href, markdown links.
  const references = [...pages].flatMap(([file, text]) =>
    [...text.matchAll(/(?:src|srcset|href)="([^"]+)"|\]\(([^)\s]+)\)/g)]
      .map((match) => match[1] ?? match[2] ?? '')
      .filter((target) => target !== '' && !target.startsWith('#'))
      .filter((target) => target.startsWith(OWN_RAW) || !/^[a-z]+:/i.test(target))
      .map((target) => {
        // `?raw=true` makes GitHub serve an MP4 itself rather than its file page.
        const bare = target.split(/[?#]/)[0] ?? '';
        const path = bare.startsWith(OWN_RAW)
          ? bare.slice(OWN_RAW.length)
          : posix.normalize(posix.join(posix.dirname(file), bare));
        return { file, target, path };
      })
      .filter(({ path }) => path.startsWith('media/')),
  );
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
        if (/src="(?![a-z]+:)[^"]*media\//.test(tag)) {
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
        if (/<img\b[^>]*src="(?![a-z]+:)[^"]*media\/gifs\//.test(block)) {
          const ownStill =
            file === 'README.md'
              ? /srcset="https:\/\/raw\.githubusercontent\.com\/supernovae-st\/nika-client\/HEAD\/media\/stills\/[^"]+\.png"/
              : /srcset="(?![a-z]+:)[^"]*media\/stills\/[^"]+\.png"/;
          expect(block, `${file}: our GIF without its own still, in the form its renderer resolves`).toMatch(
            ownStill,
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
    for (const entry of Object.values(media.tapes)) {
      for (const file of Object.keys(entry.outputs).filter((name) => !name.endsWith('.txt'))) {
        expect(captions[file]?.caption, file).toContain('0.123.0');
      }
    }
  });
});
