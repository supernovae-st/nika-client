import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const mediaScript = readFileSync(new URL('../scripts/media/render.sh', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports?: Record<string, unknown> };

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
    expect(readme).toContain('maxCostUsd: 0.01');
    expect(readme).toContain('pauseUntil:');
  });

  it('teaches literal inputs without promising an engine that lacks the channel', () => {
    // Issue #116: the public word is `inputs`, with the same meaning on both
    // transports, and it is honest about what the connected engine must advertise.
    expect(readme).toContain("inputs: { ticketId: '42' }");
    expect(readme).toContain('`inputsLiteral`');
    expect(readme).toContain('`jobInputs`');
    expect(readme).toContain('never falls back to `--var`');
    expect(readme).toMatch(/`vars`[^.]*deprecated/);
    // The two sentences that described the world before the envelope.
    expect(readme).not.toContain('request envelopes for per-call `vars`');
    expect(readme).not.toContain('yes; `vars`, `model`, `maxCostUsd` allowed');
    const httpApi = readFileSync(new URL('../docs/http-api.md', import.meta.url), 'utf8');
    expect(httpApi).toContain('`jobInputs`');
    expect(httpApi).not.toContain('remote `run()` refuses\n  `vars`, `model`, and `maxCostUsd` until');
  });

  it('documents the engine-main frame fields as ahead of the pin, and evidence as no verdict', () => {
    const httpApi = readFileSync(new URL('../docs/http-api.md', import.meta.url), 'utf8');
    for (const word of ['`at`', '`evidence`', '`mirror_lost`', '`write_failed`', '`record_refused`']) {
      expect(httpApi).toContain(word);
    }
    // Honest about where the wire comes from: not the contract this package pins.
    expect(httpApi).toContain('ahead of the pinned `openapi.json`');
    expect(httpApi).toContain('no released engine');
    // And about what it means: it reports a loss, it never judges the run.
    expect(httpApi).toContain('never changes `result.status`');
    expect(httpApi).toContain('absence claims nothing');
  });

  it('exports package metadata so consumers can prove the installed pin', () => {
    expect(manifest.exports?.['./package.json']).toBe('./package.json');
    expect(readme).toContain("require('@supernovae-st/nika/package.json').version");
  });

  it('does not regress to removed APIs or claim a webhook verifier', () => {
    for (const publicSurface of [readme, mediaScript]) {
      expect(publicSurface).not.toContain("from '@supernovae-st/nika/local'");
      expect(publicSurface).not.toContain('new LocalNika');
      expect(publicSurface).not.toContain('runToEnd(');
    }
    expect(readme).not.toContain('nika.jobs.');
    expect(readme).toContain('does not export a webhook-signature verifier');
  });
});
