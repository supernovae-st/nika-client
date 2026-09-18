import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_CASES,
  MAP_LIMIT_BYTES,
  SDK_CASES,
  WORKFLOW,
  sizedInputs,
} from '../scripts/input-parity/contract.mjs';
import { LITERAL_INPUTS_MAX_BYTES, encodeLiteralInputs } from '../src/lib/literal-inputs.ts';

// The literal input parity gauntlet (scripts/run-input-parity-e2e.mjs) needs a
// real engine, so it does not run here. What runs here is what would make it
// lie: a case table that no longer means what it says, and a projection adapter
// that could hide a fault instead of naming a drift.

const require = createRequire(import.meta.url);
const { digested, withoutFields } = require('../scripts/input-parity/consumer-scenario.cjs');

describe('the parity case table means what it says', () => {
  it('sizes its boundary maps with the SDK serializer, to the byte', () => {
    expect(MAP_LIMIT_BYTES).toBe(LITERAL_INPUTS_MAX_BYTES);
    expect(encodeLiteralInputs(sizedInputs(MAP_LIMIT_BYTES)).bytes).toBe(MAP_LIMIT_BYTES);
    expect(() => encodeLiteralInputs(sizedInputs(MAP_LIMIT_BYTES + 1))).toThrow(/exceeds 1048576 bytes/);
    const over = SDK_CASES.find((scenario) => scenario.name === 'a-map-one-byte-over-1-mib');
    expect(Buffer.byteLength(JSON.stringify(over.options.inputs))).toBe(MAP_LIMIT_BYTES + 1);
  });

  it('only sends the engine maps the SDK itself accepts, so every verdict is the engine\'s', () => {
    for (const scenario of ENGINE_CASES) {
      expect(() => encodeLiteralInputs(scenario.inputs), scenario.name).not.toThrow();
    }
    expect(new Set(ENGINE_CASES.map((scenario) => scenario.name)).size).toBe(ENGINE_CASES.length);
  });

  it('expects a settled run to echo its literal inputs over the declared defaults', () => {
    const settled = ENGINE_CASES.filter((scenario) => scenario.expect.outcome === 'settled');
    expect(settled.length).toBeGreaterThanOrEqual(6);
    for (const { name, inputs, expect: expected } of settled) {
      for (const [key, value] of Object.entries(inputs)) {
        expect(expected.outputs.value[key], `${name}.${key}`).toEqual(value);
        expect(expected.origins[key], `${name}.${key}`).toBe('api-caller');
      }
      for (const key of ['note', 'ratio', 'approved', 'region']) {
        if (!Object.hasOwn(inputs, key)) expect(expected.origins[key], `${name}.${key}`).toBe('file');
      }
    }
  });

  it('covers the literal strings an operator channel would reinterpret', () => {
    const tickets = ENGINE_CASES.map((scenario) => scenario.inputs.ticket);
    expect(tickets).toContain('@env:NIKA_TEST_LITERAL');
    expect(tickets).toContain('"@env:NIKA_TEST_LITERAL"');
    expect(tickets).toContain('${{ tasks.echo.output }}');
    expect(tickets).toContain('42');
  });

  it('expects one engine code for each refused map', () => {
    const refused = Object.fromEntries(ENGINE_CASES
      .filter((scenario) => scenario.expect.outcome === 'refused')
      .map((scenario) => [scenario.name, scenario.expect.code]));
    expect(refused).toEqual({
      'an-empty-map-misses-required-inputs': 'NIKA-1708',
      'an-undeclared-key': 'unknown_input',
      'a-string-for-an-integer': 'input_type_mismatch',
      'an-integer-for-a-string': 'input_type_mismatch',
      'a-null-for-a-string': 'input_type_mismatch',
      'an-object-for-an-array': 'input_type_mismatch',
    });
  });

  it('declares a pure workflow: one builtin, no model seat, no file or network grant', () => {
    expect(WORKFLOW).toContain("permits: { tools: ['nika:jq'] }");
    for (const forbidden of ['infer:', 'agent:', 'exec:', 'nika:fetch', 'nika:write', 'secrets:', 'model:']) {
      expect(WORKFLOW, forbidden).not.toContain(forbidden);
    }
  });
});

describe('long text is compared by digest, never dropped', () => {
  it('digests only text over the threshold, at any depth', () => {
    const long = 'x'.repeat(2048);
    const report = digested({ value: { ticket: long, tags: ['short', long], count: 1, none: null } });
    expect(report.value.count).toBe(1);
    expect(report.value.none).toBeNull();
    expect(report.value.tags[0]).toBe('short');
    expect(report.value.ticket).toEqual({ $bytes: 2048, $sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(report.value.tags[1]).toEqual(report.value.ticket);
    expect(digested({ t: `${long}y` }).t.$sha256).not.toBe(report.value.ticket.$sha256);
  });
});

describe('the projection adapter names a drift and hides nothing else', () => {
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const sse = (frames) => new Response(
    frames.map((frame) => `id: ${frame.sequence}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );

  it('drops exactly the named top-level fields from a job object, and counts them', async () => {
    const dropped = {};
    const body = await (await withoutFields(json({
      id: 'job-1',
      status: 'succeeded',
      evidence: { kept: false },
      outputs: { at: 'an output named like a dropped field stays', evidence: 1 },
    }), ['at', 'evidence'], dropped)).json();
    expect(body).toEqual({
      id: 'job-1',
      status: 'succeeded',
      outputs: { at: 'an output named like a dropped field stays', evidence: 1 },
    });
    expect(dropped).toEqual({ evidence: 1 });
  });

  it('drops them from every SSE frame and keeps the framing a parser needs', async () => {
    const dropped = {};
    const text = await (await withoutFields(sse([
      { sequence: 1, kind: 'execution.started', status: 'running', at: '2026-09-18T00:00:00Z' },
      { sequence: 2, kind: 'execution.settled', status: 'succeeded', at: 'later', outputs: { at: 1 } },
    ]), ['at', 'evidence'], dropped)).text();
    expect(text).toBe(
      'id: 1\ndata: {"sequence":1,"kind":"execution.started","status":"running"}\n\n'
      + 'id: 2\ndata: {"sequence":2,"kind":"execution.settled","status":"succeeded","outputs":{"at":1}}\n\n',
    );
    expect(dropped).toEqual({ at: 2 });
  });

  it('keeps the status and headers, so a refusal is still the resident\'s refusal', async () => {
    const refusal = new Response(
      JSON.stringify({ error: { code: 'unknown_input', message: 'x' }, at: 'now' }),
      { status: 422, headers: { 'Content-Type': 'application/json', 'Retry-After': '3' } },
    );
    const adapted = await withoutFields(refusal, ['at'], {});
    expect(adapted.status).toBe(422);
    expect(adapted.headers.get('Retry-After')).toBe('3');
    await expect(adapted.json()).resolves.toEqual({ error: { code: 'unknown_input', message: 'x' } });
  });

  it('leaves any other body untouched', async () => {
    const plain = new Response('at evidence', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    expect(await withoutFields(plain, ['at'], {})).toBe(plain);
  });
});
