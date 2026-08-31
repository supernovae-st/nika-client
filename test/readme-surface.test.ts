import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const mediaScript = readFileSync(new URL('../scripts/media/render.sh', import.meta.url), 'utf8');

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

  it('does not regress to removed APIs or claim a webhook verifier', () => {
    for (const publicSurface of [readme, mediaScript]) {
      expect(publicSurface).not.toContain("from '@supernovae-st/nika-client/local'");
      expect(publicSurface).not.toContain('new LocalNika');
      expect(publicSurface).not.toContain('runToEnd(');
    }
    expect(readme).not.toContain('nika.jobs.');
    expect(readme).toContain('does not export a webhook-signature verifier');
  });
});
