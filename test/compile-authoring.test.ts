import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Nika, NikaCompatibilityError, NikaConfigurationError, NikaProtocolError, NikaTransportError } from '../src/index.js';
import type { NikaCompileAuthoringOptions } from '../src/index.js';
import { compileOutcomeFrom, compilePayloadFrom } from '../src/lib/compile.js';
import { healthResponse } from './helpers/http-depth-harness.js';

// Protocol doubles, NOT model-generation or release evidence. Wire fields follow
// engine a8c662fa: nika-compile/{types,wire}, nika-cli-host/compile/{authoring,render}.
const wire = () => JSON.parse(readFileSync(new URL('./fixtures/compile-v2.json', import.meta.url), 'utf8'));
const bin = fileURLToPath(new URL('./fixtures/fake-nika-compile.mjs', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'nika-authoring-options-'));
const log = path.join(scratch, 'argv.jsonl');
afterEach(() => { delete process.env.NIKA_FAKE_ARGV_LOG; vi.unstubAllEnvs(); rmSync(log, { force: true }); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
const args = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const remote = (fetch: typeof globalThis.fetch) => new Nika({ url: 'https://nika.example', token: 'p'.repeat(32), bin, fetch });
const reply = (body: unknown) => vi.fn()
  .mockResolvedValueOnce(healthResponse({ supportedCapabilities: ['check', 'executionSnapshot', 'eventStream', 'trace', 'compile'] }))
  .mockResolvedValueOnce(Response.json(body));
const nativePayload = (payload: unknown, exitCode = 2) => compileOutcomeFrom({
  stdout: JSON.stringify(payload), stderr: '', exitCode, exitSignal: null,
}, 'native-process', 'protocol-double');

describe('explicit native authoring options', () => {
  it('projects every flag literally, including leading dashes, quotes, Unicode and shell syntax', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const hostile = '-雪 "quoted"\n$(touch should-not-exist); `false`';
    const authoring: NikaCompileAuthoringOptions = {
      model: hostile, strategy: 'only', repairs: 0, maxTokens: 32768, timeoutSeconds: 600,
      knowledge: { snapshot: hostile, excludeCorpus: hostile },
    };
    const result = await new Nika({ bin }).compile({ intent: 'native-v2', answers: { 'stable.question': hostile } }, { authoring });
    expect(args()[1]).toEqual(['compile', '--json', `--authoring-model=${hostile}`,
      '--authoring-strategy=only', '--authoring-repairs=0', '--authoring-max-tokens=32768',
      '--authoring-timeout=600', `--knowledge=${hostile}`, `--knowledge-exclude=${hostile}`,
      `--answer=stable.question=${JSON.stringify(hostile)}`, '--', 'native-v2']);
    expect(result).toEqual({ ...wire(), ready: false });
  });

  it('projects a request pack and keeps original intent, base bytes and stable answers on revisions', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const originalIntent = '-original 雪; $(false)\nPreserve this';
    const workflow = 'nika: accepted\r\n# exact bytes\n';
    const result = await new Nika({ bin }).compile({ workflow, change: '-change; `false`', originalIntent,
      answers: { 'trigger.overlap': 'skip', 'const.value': { x: [null, true, 1.25] } } },
    { authoring: { model: 'provider/model', strategy: 'sketch', knowledge: { pack: '-request pack.json' } } });
    const invocation = args()[1];
    expect(invocation).toContain('--knowledge-pack=-request pack.json');
    expect(invocation).toContain('--authoring-strategy=sketch');
    expect(invocation).toContain('--answer=trigger.overlap="skip"');
    expect(invocation).toContain('--answer=const.value={"x":[null,true,1.25]}');
    expect(invocation).toContain('--change=-change; `false`');
    expect(invocation.slice(-2)).toEqual(['--', originalIntent]);
    expect(result.candidate).toBe(`${workflow}\n# applied change: -change; \`false\`\n`);
    expect(existsSync(path.dirname(invocation[invocation.indexOf('--base') + 1]))).toBe(false);
  });

  it('never infers authoring consent or a model from answers or environment', async () => {
    vi.stubEnv('NIKA_OPENAI_API_KEY', 'controlled-not-a-key');
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const result = await new Nika({ bin }).compile({ intent: 'native-v2', answers: { authoring_model: 'provider/model' } });
    expect(args()[1]).toEqual(['compile', '--json', '--answer=authoring_model="provider/model"', '--', 'native-v2']);
    expect(result.provenance.authoring?.input_tokens).toBeNull();
    expect(result.provenance.authoring?.backend).toEqual(wire().provenance.authoring.backend);
  });

  it.each(['escalate', 'off'] as const)('passes the %s strategy unchanged', async (strategy) => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    await new Nika({ bin }).compile('native-v2', { authoring: { model: 'provider/model', strategy } });
    expect(args()[1]).toContain(`--authoring-strategy=${strategy}`);
  });

  it('retains operation timeout and pre-abort semantics with authoring enabled', async () => {
    const nika = new Nika({ bin });
    const authoring = { model: 'provider/model', timeoutSeconds: 600 };
    await expect(nika.compile('hostile-slow', { authoring, timeoutMs: 150 })).rejects.toThrow(/timed out/);
    process.env.NIKA_FAKE_ARGV_LOG = log;
    await expect(nika.compile('native-v2', { authoring, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(NikaTransportError);
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    null, {}, { model: '' }, { model: ' ' }, { model: 'x\0y' },
    { model: 'p/m', strategy: 'native' }, { model: 'p/m', repairs: -1 }, { model: 'p/m', repairs: 6 },
    { model: 'p/m', repairs: 1.5 }, { model: 'p/m', maxTokens: 0 }, { model: 'p/m', maxTokens: 32769 },
    { model: 'p/m', timeoutSeconds: 0 }, { model: 'p/m', timeoutSeconds: 601 }, { model: 'p/m', timeoutSeconds: NaN },
    { model: 'p/m', fallback: true }, { model: 'p/m', knowledge: {} },
    { model: 'p/m', knowledge: { snapshot: 'x', pack: 'y' } },
    { model: 'p/m', knowledge: { pack: 'x', excludeCorpus: 'y' } },
    { model: 'p/m', knowledge: { snapshot: '' } }, { model: 'p/m', knowledge: { pack: 'x\0y' } },
  ])('refuses malformed authoring configuration without I/O: %#', async (authoring) => {
    const fetch = vi.fn();
    process.env.NIKA_FAKE_ARGV_LOG = log;
    for (const nika of [new Nika({ bin }), remote(fetch)]) {
      await expect(nika.compile('hello', { authoring } as any)).rejects.toBeInstanceOf(NikaConfigurationError);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(log)).toBe(false);
  });

  it('refuses nested accessors and proxies without invoking them', async () => {
    const get = vi.fn(() => { throw new Error('getter invoked'); });
    const cases = [Object.defineProperty({}, 'model', { enumerable: true, get }),
      new Proxy({}, { ownKeys: get }),
      { model: 'p/m', knowledge: Object.defineProperty({}, 'snapshot', { enumerable: true, get }) },
      { model: 'p/m', knowledge: new Proxy({}, { getPrototypeOf: get }) }];
    for (const authoring of cases) {
      await expect(new Nika({ bin }).compile('hello', { authoring } as any)).rejects.toBeInstanceOf(NikaConfigurationError);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['', ' ', 1, 'nul\0intent'])('refuses invalid originalIntent: %#', async (originalIntent) => {
    await expect(new Nika({ bin }).compile({ workflow: 'source', change: 'change', originalIntent } as any))
      .rejects.toBeInstanceOf(NikaConfigurationError);
  });

  it('refuses unsupported HTTP controls before health, POST or local fallback', async () => {
    process.env.NIKA_FAKE_ARGV_LOG = log;
    const fetch = vi.fn();
    const nika = remote(fetch);
    for (const authoring of [{ model: 'p/m' }, { model: 'p/m', knowledge: { pack: '/host/private.json' } },
      { model: 'p/m', knowledge: { snapshot: '/host/snapshot', excludeCorpus: 'benchmark' } }]) {
      await expect(nika.compile('hello', { authoring })).rejects.toMatchObject({ name: 'NikaCompatibilityError', transport: 'http' });
    }
    await expect(nika.compile({ workflow: 'source', change: 'change', originalIntent: 'original' }))
      .rejects.toBeInstanceOf(NikaCompatibilityError);
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(log)).toBe(false);
  });
});

describe('Compile wire v2 decoding on both transports (protocol doubles)', () => {
  it('preserves exact unbound cron fields and accepts older trigger documents', () => {
    for (const transport of ['native-process', 'http'] as const) {
      const legacy = wire();
      delete legacy.requested_trigger.cron;
      expect(compilePayloadFrom(legacy, transport, 'double').requested_trigger)
        .not.toHaveProperty('cron');
      for (const cron of [null, '0 */2 * * *', '15 9 * * 2']) {
        const payload = wire();
        payload.requested_trigger.cron = cron;
        expect(compilePayloadFrom(payload, transport, 'double').requested_trigger?.cron).toBe(cron);
      }
      for (const cron of [5, false, [], {}]) {
        const payload = wire();
        payload.requested_trigger.cron = cron;
        expect(() => compilePayloadFrom(payload, transport, 'double')).toThrow(NikaProtocolError);
      }
    }
  });

  it('also preserves expanded v1 provenance without an authoring receipt', () => {
    const payload = { ...wire(), compile_version: 1 };
    delete payload.provenance.authoring;
    payload.provenance.cognition = 'explicitDecision';
    payload.provenance.strategy = 'warm';
    for (const transport of ['native-process', 'http'] as const) {
      expect(compilePayloadFrom(payload, transport, 'double')).toEqual({ ...payload, ready: false });
    }
  });
  it.each(['ready', 'incomplete', 'refused'])('preserves the complete %s envelope and unknown metering', async (status) => {
    const payload = { ...wire(), status, candidate: status === 'ready' ? 'source' : null };
    const fetch = reply(payload);
    const http = await remote(fetch).compile('original');
    const native = nativePayload({ ...payload, written: null }, status === 'ready' ? 0 : 2);
    expect(http).toEqual({ ...payload, ready: status === 'ready' });
    expect(native).toEqual(http);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ compile_version: 1, mode: 'create', intent: 'original' });
  });

  it.each([
    { calls: -1 }, { calls: 0x100000000 }, { calls: 0.5 }, { model: null }, { elapsed_ms: '2' },
    { elapsed_ms: Number.MAX_SAFE_INTEGER + 1 }, { input_tokens: 'unknown' }, { output_tokens: -1 },
    { sampling: null }, { sampling: { temperature: 0, seed: null, effective: 'providerDefaultUnknown' } },
    { sampling: { temperature: null, seed: null, effective: 'guessed' } }, { context: {} },
  ])('rejects malformed receipt fields: %#', (patch) => {
    const payload = wire();
    Object.assign(payload.provenance.authoring, patch);
    for (const transport of ['native-process', 'http'] as const) {
      expect(() => compilePayloadFrom(payload, transport, 'double')).toThrow(NikaProtocolError);
    }
  });

  it('requires every v2 receipt field and refuses receipts labelled v1', () => {
    for (const field of Object.keys(wire().provenance.authoring)) {
      const payload = wire();
      delete payload.provenance.authoring[field];
      expect(() => nativePayload({ ...payload, written: null })).toThrow(NikaProtocolError);
    }
    for (const transport of ['native-process', 'http'] as const) {
      const payload = wire();
      delete payload.provenance.authoring;
      expect(() => compilePayloadFrom(payload, transport, 'double')).toThrow(NikaProtocolError);
      expect(() => compilePayloadFrom({ ...wire(), compile_version: 1 }, transport, 'double')).toThrow(NikaProtocolError);
    }
  });

  it.each([3, 999])('refuses unknown wire %i', (compile_version) => {
    for (const transport of ['native-process', 'http'] as const) {
      expect(() => compilePayloadFrom({ ...wire(), compile_version }, transport, 'double')).toThrow(NikaCompatibilityError);
    }
  });

  it.each([['ready', 2], ['ready', 3], ['incomplete', 0], ['refused', 1], ['refused', 3]])('refuses %s with exit %i', (status, exitCode) => {
    expect(() => nativePayload({ ...wire(), status, candidate: 'source', written: null }, exitCode as number)).toThrow(NikaProtocolError);
  });

  it('checks new known question, strategy and trigger types while keeping extensions', () => {
    for (const mutate of [
      (p: any) => { p.questions[0].options[0].key = 1; },
      (p: any) => { p.questions[0].options = null; },
      (p: any) => { p.provenance.strategy = 'invented'; },
      (p: any) => { p.provenance.suggested_file = 123; },
      (p: any) => { p.requested_trigger.ceiling = 5; },
    ]) {
      const payload = wire(); mutate(payload);
      expect(() => compilePayloadFrom(payload, 'http', 'double')).toThrow(NikaProtocolError);
    }
  });
});
