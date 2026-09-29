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

  it('teaches the published Run-owned lifecycle and keeps its compatibility doors', () => {
    for (const member of ['run.events()', 'run.result()', 'run.status()', 'run.cancel()']) {
      expect(readme).toContain(`\`${member}\``);
    }
    expect(readme).toContain('isNikaRunSucceeded(result)');
    expect(readme).toContain('`run.done` is its compatibility');
    for (const door of ['nika.events(run)', 'nika.cancel(run)', 'nika.status(run)']) {
      expect(readme).toContain(`\`${door}\``);
    }
    expect(readme).toContain('### Migrating to the Run-owned lifecycle');
    // One bound, two named refusals, never a silently shortened view.
    expect(readme).toContain('**4096 by default**');
    expect(readme).toContain('`replay_truncated`');
    expect(readme).toContain('`live_backpressure`');
    expect(readme).not.toContain('observer ceiling, default 256');
    // What a published 0.120.3 program must not assume on this line.
    expect(readme).toContain('Four published 0.120.3 surfaces differ on this line');
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
