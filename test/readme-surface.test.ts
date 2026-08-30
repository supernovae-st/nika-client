import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

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
  });

  it('does not regress to removed APIs or claim a webhook verifier', () => {
    expect(readme).not.toContain("from '@supernovae-st/nika-client/local'");
    expect(readme).not.toContain('new LocalNika');
    expect(readme).not.toContain('nika.jobs.');
    expect(readme).toContain('does not export a webhook-signature verifier');
  });
});
