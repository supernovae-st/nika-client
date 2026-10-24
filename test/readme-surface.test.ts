import { readdirSync, readFileSync } from 'node:fs';
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
    expect(readme).toContain('supernovae-st/nika/v0.123.0/media/gifs/typescript-client.optimized.gif');
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
