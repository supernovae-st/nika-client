import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaConfigurationError } from '../src/index.js';
import type { NikaCompileOptions } from '../src/index.js';
import { normalizeCompileOptions } from '../src/lib/compile.js';

// CLI contract: nika-cli-host/src/compile.rs at c153d7d9. Protocol double only;
// no installed engine or provider is invoked by these tests.
const bin = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-cognition-options-'));
const log = path.join(scratch, 'argv.jsonl');
afterEach(() => { vi.unstubAllEnvs(); delete process.env.NIKA_FAKE_ARGV_LOG; rmSync(log, { force: true }); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const args = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('explicit native cognition selection', () => {
  it.each([1, 5])('projects both seats and %i samples literally', async (samples) => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const model = '-provider/雪 "quoted"\n$(false); `false`';
    await new Nika({ bin }).compile('native-v2', {
      decisionModel: model, authoring: { model: 'explicit/model', samples },
    });
    expect(args()).toEqual([['--sdk-identity'], ['compile', '--json',
      `--decision-model=${model}`, '--authoring-model=explicit/model',
      `--authoring-samples=${samples}`, '--', 'native-v2']]);
  });

  it('can select a decision seat without selecting an authoring provider', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    await new Nika({ bin }).compile('hello', { decisionModel: 'typesafe/jev-1.13.0' });
    expect(args()[1]).toEqual(['compile', '--json', '--decision-model=typesafe/jev-1.13.0', '--', 'hello']);
  });

  it('does not infer seats or samples from answers or ambient configuration', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    vi.stubEnv('TYPESAFE_API_KEY', 'fixture-not-a-credential');
    vi.stubEnv('NIKA_DECISION_MODEL', 'unselected/model');
    await new Nika({ bin }).compile({ intent: 'hello', answers: { decision_model: 'unselected/model', authoring_samples: 5 } });
    expect(args()[1]).toEqual(['compile', '--json', '--answer=decision_model="unselected/model"',
      '--answer=authoring_samples=5', '--', 'hello']);
  });

  it('keeps the engine default samples implicit and permits explicit samples on edits', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const client = new Nika({ bin });
    await client.compile('hello', { authoring: { model: 'explicit/model' } });
    expect(args()[1]).not.toContain('--authoring-samples=1');
    await client.compile({ workflow: 'nika: hello\n', change: 'change', originalIntent: 'hello' },
      { authoring: { model: 'explicit/model', samples: 2 } });
    expect(args().at(-1)).toContain('--authoring-samples=2');
    expect(args().at(-1)).toContain('--base');
  });

  it.each([
    { decisionModel: '' }, { decisionModel: '  ' }, { decisionModel: 'x\0y' },
    { decisionModel: null }, { decisionModel: 7 },
    ...[0, 6, -1, 1.5, NaN, Infinity, '2', null].map((samples) => ({ authoring: { model: 'explicit/model', samples } })),
    { authoring: { samples: 2 } }, { samples: 2 }, { decision_model: 'model' },
    { args: ['--decision-model=model'] },
  ])('refuses malformed or unscoped controls before any I/O: %j', async (options) => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const fetch = vi.fn();
    for (const client of [new Nika({ bin }), new Nika({ url: 'https://nika.example', token: 'a'.repeat(32), fetch, bin })]) {
      await expect(client.compile('hello', options as NikaCompileOptions)).rejects.toBeInstanceOf(NikaConfigurationError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(log)).toBe(false);
  });

  it('refuses a decision model on edits before probing or writing a base', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    await expect(new Nika({ bin }).compile({ workflow: 'nika: hello\n', change: 'change' },
      { decisionModel: 'explicit/model' })).rejects.toThrow(/only supported for CREATE/);
    expect(existsSync(log)).toBe(false);
  });

  it.each([{ decisionModel: 'explicit/model' }, { authoring: { model: 'explicit/model', samples: 2 } }])(
    'refuses local controls over HTTP before health: %j', async (options) => {
      const fetch = vi.fn();
      const client = new Nika({ url: 'https://nika.example', token: 'a'.repeat(32), fetch, bin });
      await expect(client.compile('hello', options)).rejects.toBeInstanceOf(NikaCompatibilityError);
      await expect(client.compile('hello', { ...options, remoteAuthoring: { cognition: 'explicitProvider' } }))
        .rejects.toBeInstanceOf(NikaConfigurationError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('snapshots controls and refuses accessors or Proxy traps without running them', () => {
    const source = { decisionModel: 'explicit/model', authoring: { model: 'author/model', samples: 2 } };
    const normalized = normalizeCompileOptions(source);
    source.decisionModel = 'changed/model'; source.authoring.samples = 5;
    expect(normalized).toMatchObject({ decisionModel: 'explicit/model', authoring: { samples: 2 } });
    const getter = vi.fn(() => 'hidden/model');
    const trap = vi.fn();
    expect(() => normalizeCompileOptions(Object.defineProperty({}, 'decisionModel', { enumerable: true, get: getter })))
      .toThrow(NikaConfigurationError);
    expect(() => normalizeCompileOptions({ authoring: Object.defineProperty({ model: 'model' }, 'samples', { enumerable: true, get: getter }) }))
      .toThrow(NikaConfigurationError);
    expect(() => normalizeCompileOptions(new Proxy({}, { ownKeys: trap }))).toThrow(NikaConfigurationError);
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });
});
