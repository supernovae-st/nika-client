import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { NikaConfigurationError } from '../src/index.js';
import {
  LITERAL_INPUTS_MAX_BYTES,
  encodeLiteralInputs,
  literalInputs,
} from '../src/lib/literal-inputs.js';

// Issue #116 · the literal input map is strict JSON or it is refused. Nothing
// `JSON.stringify` would silently drop, invent or transform may reach a wire:
// the engine (nika#1683 · nika#1642) binds exactly the bytes the caller meant.

function refusal(inputs: unknown): NikaConfigurationError {
  try {
    encodeLiteralInputs(inputs);
  } catch (cause) {
    expect(cause).toBeInstanceOf(NikaConfigurationError);
    return cause as NikaConfigurationError;
  }
  throw new Error('expected the literal input map to be refused');
}

describe('literal inputs are serialized exactly once, as strict JSON', () => {
  it('keeps every JSON type, in the caller key order, as compact UTF-8 JSON', () => {
    const encoded = encodeLiteralInputs({
      ticketId: '42',
      count: 42,
      ratio: 0.5,
      negative: -7,
      exponent: 1e21,
      approved: false,
      nothing: null,
      tags: ['a', 1, true, null, ['nested'], { deep: [] }],
      ticket: { id: 'T-1', meta: { empty: {}, list: [] } },
    });
    expect(encoded.json).toBe(
      '{"ticketId":"42","count":42,"ratio":0.5,"negative":-7,"exponent":1e+21,'
      + '"approved":false,"nothing":null,"tags":["a",1,true,null,["nested"],{"deep":[]}],'
      + '"ticket":{"id":"T-1","meta":{"empty":{},"list":[]}}}',
    );
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.json));
    // The text is what any JSON reader sees: nothing was renamed or reordered.
    expect(JSON.parse(encoded.json)).toEqual({
      ticketId: '42',
      count: 42,
      ratio: 0.5,
      negative: -7,
      exponent: 1e21,
      approved: false,
      nothing: null,
      tags: ['a', 1, true, null, ['nested'], { deep: [] }],
      ticket: { id: 'T-1', meta: { empty: {}, list: [] } },
    });
  });

  it('never interprets a string: operator syntax, expressions and numerals stay text', () => {
    const inputs = {
      env: '@env:SERVER_SECRET',
      expression: '${{ tasks.x.output }}',
      mustache: '{{ inputs.ticket }}',
      numeral: '42',
      quoted: '"@env:HOME"',
      flag: '--var other=1',
      control: 'line\nbreak\ttab\u0000nul',
    };
    const encoded = encodeLiteralInputs(inputs);
    expect(JSON.parse(encoded.json)).toEqual(inputs);
    expect(encoded.json).toContain('"env":"@env:SERVER_SECRET"');
    expect(encoded.json).toContain('"numeral":"42"');
    expect(encoded.json).toContain('\\u0000');
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const encoded = encodeLiteralInputs({ greeting: 'héllo · 你好 · 🦋', 'clé': 'naïve' });
    expect(JSON.parse(encoded.json)).toEqual({ greeting: 'héllo · 你好 · 🦋', 'clé': 'naïve' });
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.json, 'utf8'));
    expect(encoded.bytes).toBeGreaterThan(encoded.json.length);
  });

  it('serializes an empty map as the explicit empty object', () => {
    expect(encodeLiteralInputs({})).toEqual({ json: '{}', bytes: 2 });
    expect(encodeLiteralInputs(Object.create(null))).toEqual({ json: '{}', bytes: 2 });
  });

  it('accepts a null-prototype map and an own `__proto__` data key as plain data', () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    expect(encodeLiteralInputs(bare).json).toBe('{"a":1}');
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>;
    expect(encodeLiteralInputs(parsed).json).toBe('{"__proto__":{"polluted":true},"ok":1}');
  });

  it('serializes a shared, acyclic reference each time it is reached', () => {
    const shared = { id: 1 };
    expect(encodeLiteralInputs({ a: shared, b: [shared, shared] }).json)
      .toBe('{"a":{"id":1},"b":[{"id":1},{"id":1}]}');
  });

  it('writes negative zero as the JSON number 0, the one value-preserving normalization', () => {
    expect(encodeLiteralInputs({ zero: -0 }).json).toBe('{"zero":0}');
  });

  it('agrees byte for byte with JSON.stringify on every value that is strict JSON', () => {
    // The differential oracle: on strict JSON, JSON.stringify loses nothing, so
    // the two serializers must never disagree, key order and escapes included.
    const corpus: Record<string, unknown>[] = [
      { b: 1, 2: 'two', a: 1, 1: 'one', '-1': 'not an index', '01': 'nor this' },
      { escapes: 'quote " backslash \\ slash / \b\f\n\r\t \u2028 \u2029 \u007f', '"key"': '\\' },
      { numbers: [0, 1e-7, 123456789012345680000, 5e-324, -1.5, Number.MAX_SAFE_INTEGER, 2 ** 53, 1.7976931348623157e308] },
      { astral: '🦋𝒳', combining: 'e\u0301', rtl: 'שלום', cjk: '你好', surrogatePair: '\ud83e\udd8b' },
      { empty: { o: {}, a: [], s: '' }, nested: [[[]], [{}], [[{ k: [null] }]]] },
      { '': 'empty key', ' ': 'space key', 'a.b': 1, 'a[0]': 2, constructor: 'own data', hasOwnProperty: 'own data' },
    ];
    for (const inputs of corpus) {
      expect(encodeLiteralInputs(inputs).json).toBe(JSON.stringify(inputs));
    }
  });

  it('accepts plain data created in another realm, as a fetched or cloned body is under a test runner', () => {
    const foreign = runInNewContext('({ ticket: { id: "T-1", tags: ["a", { deep: null }] } })') as
      Record<string, unknown>;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect(encodeLiteralInputs(foreign).json)
      .toBe('{"ticket":{"id":"T-1","tags":["a",{"deep":null}]}}');
  });

  it('serializes nesting far beyond any call stack without a RangeError', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 100_000; depth += 1) nested = [nested];
    const encoded = encodeLiteralInputs({ nested });
    expect(encoded.bytes).toBe('{"nested":'.length + 100_000 * 2 + '"leaf"'.length + 1);
    expect(encoded.json.startsWith('{"nested":[[[[')).toBe(true);
    expect(encoded.json.endsWith(']]]]}')).toBe(true);
  });
});

describe('a root that is not a plain JSON object is refused', () => {
  it.each([
    ['null', null],
    ['an array', ['a']],
    ['a string', '{"a":1}'],
    ['a number', 42],
    ['a boolean', true],
    ['a Map', new Map([['a', 1]])],
    ['a Date', new Date(0)],
    ['a class instance', new (class Ticket { id = 1; })()],
    ['a function', () => ({})],
  ])('refuses %s', (_name, value) => {
    const error = refusal(value);
    expect(error.message).toMatch(/^run\(\{ inputs \}\): inputs must be a plain object/);
  });
});

describe('values JSON cannot carry are refused by path, never dropped or transformed', () => {
  class Money {
    constructor(readonly cents: number) {}
  }
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = { back: cyclic };
  const cyclicArray: unknown[] = [];
  cyclicArray.push([cyclicArray]);
  const sparse = [1, 2, 3];
  delete sparse[1];
  const holeAtEnd: unknown[] = [];
  holeAtEnd.length = 2;
  const decorated: unknown[] & { label?: string } = [1];
  decorated.label = 'dropped by JSON.stringify';
  const accessor = Object.defineProperty({}, 'now', { enumerable: true, get: () => Date.now() });
  const hidden = Object.defineProperty({ shown: 1 }, 'hidden', { enumerable: false, value: 2 });
  const symbolKeyed = { visible: 1, [Symbol('secret')]: 2 };
  const withToJson = { toJSON: () => 'something else' };

  it.each([
    ['undefined in a map', { a: { b: undefined } }, 'inputs.a.b', 'undefined'],
    ['undefined in an array', { list: [1, undefined] }, 'inputs.list[1]', 'undefined'],
    ['a function', { fn: () => 1 }, 'inputs.fn', 'function'],
    ['a toJSON hook', { when: withToJson }, 'inputs.when.toJSON', 'function'],
    ['a symbol value', { s: Symbol('x') }, 'inputs.s', 'symbol'],
    ['a bigint', { big: 10n }, 'inputs.big', 'bigint'],
    ['NaN', { n: Number.NaN }, 'inputs.n', 'non-finite number'],
    ['Infinity', { n: [Number.POSITIVE_INFINITY] }, 'inputs.n[0]', 'non-finite number'],
    ['-Infinity', { n: Number.NEGATIVE_INFINITY }, 'inputs.n', 'non-finite number'],
    ['a Date', { at: new Date(0) }, 'inputs.at', 'Date'],
    ['a Map', { m: new Map() }, 'inputs.m', 'Map'],
    ['a Set', { s: new Set([1]) }, 'inputs.s', 'Set'],
    ['a RegExp', { r: /x/ }, 'inputs.r', 'RegExp'],
    ['a class instance', { price: new Money(5) }, 'inputs.price', 'Money'],
    ['a Buffer', { bytes: Buffer.from('ab') }, 'inputs.bytes', 'Buffer'],
    ['a typed array', { bytes: new Uint8Array(2) }, 'inputs.bytes', 'Uint8Array'],
    ['a boxed string', { s: new String('x') }, 'inputs.s', 'String'],
    ['a boxed number', { n: new Number(1) }, 'inputs.n', 'Number'],
    ['an Array subclass', { list: new (class Tags extends Array<string> {})() }, 'inputs.list', 'Tags'],
    ['inherited data', { o: Object.create({ inherited: 1 }) }, 'inputs.o', 'custom prototype'],
    ['a foreign-realm Date', { at: runInNewContext('new Date(0)') }, 'inputs.at', 'Date'],
    ['a foreign-realm class', { v: runInNewContext('new (class Money {})()') }, 'inputs.v', 'Money'],
    ['an object cycle', cyclic, 'inputs.self.back', 'cycle'],
    ['an array cycle', { list: cyclicArray }, 'inputs.list[0][0]', 'cycle'],
    ['an array hole', { list: sparse }, 'inputs.list[1]', 'array hole'],
    ['a trailing array hole', { list: holeAtEnd }, 'inputs.list[0]', 'array hole'],
    ['a named array property', { list: decorated }, 'inputs.list.label', 'array property'],
    ['an accessor', { clock: accessor }, 'inputs.clock.now', 'accessor'],
    ['a non-enumerable property', { o: hidden }, 'inputs.o.hidden', 'non-enumerable'],
    ['a symbol key', { o: symbolKeyed }, 'inputs.o[Symbol(secret)]', 'symbol key'],
    ['a lone surrogate value', { s: 'bad \ud800 text' }, 'inputs.s', 'lone surrogate'],
    ['a lone surrogate key', { 'k\udc00': 1 }, 'inputs["k\\udc00"]', 'lone surrogate'],
    ['a key that is not an identifier', { 'a key': { 'b.c': undefined } }, 'inputs["a key"]["b.c"]', 'undefined'],
  ])('refuses %s', (_name, inputs, path, reason) => {
    const error = refusal(inputs);
    expect(error.name).toBe('NikaConfigurationError');
    expect(error.message).toContain(`${path} `);
    expect(error.message).toContain(reason);
    expect(error.message).toContain('strict JSON');
  });

  it('never quotes the offending value, which may be a credential', () => {
    const error = refusal({ auth: { token: new (class Secret { value = 'sk-live-do-not-print'; })() } });
    expect(error.message).toContain('inputs.auth.token ');
    expect(error.message).not.toContain('sk-live-do-not-print');
    const surrogate = refusal({ auth: 'sk-live-do-not-print \ud800' });
    expect(surrogate.message).not.toContain('sk-live-do-not-print');
  });

  it('never runs caller code while it judges: an accessor is refused unread', () => {
    let reads = 0;
    const trap = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    refusal({ trap });
    expect(reads).toBe(0);
  });
});

describe('the serialized map is bounded at 1 MiB on every transport', () => {
  const envelope = '{"blob":""}'.length;

  it('names the bound the engine reads: 1 MiB of serialized map bytes', () => {
    expect(LITERAL_INPUTS_MAX_BYTES).toBe(1024 * 1024);
  });

  it('accepts a map of exactly 1 MiB', () => {
    const encoded = encodeLiteralInputs({ blob: 'x'.repeat(LITERAL_INPUTS_MAX_BYTES - envelope) });
    expect(encoded.bytes).toBe(LITERAL_INPUTS_MAX_BYTES);
    expect(Buffer.byteLength(encoded.json)).toBe(LITERAL_INPUTS_MAX_BYTES);
  });

  it('refuses a map one byte over 1 MiB', () => {
    const error = refusal({ blob: 'x'.repeat(LITERAL_INPUTS_MAX_BYTES - envelope + 1) });
    expect(error.message).toContain('1048576');
    expect(error.message).toContain('serialized');
  });

  it('measures multi-byte text in bytes: 1 MiB of characters is over the bound', () => {
    // 'é' is two UTF-8 bytes, so half a MiB of characters already fills the map.
    const half = (LITERAL_INPUTS_MAX_BYTES - envelope) / 2;
    expect(Number.isInteger(half)).toBe(false);
    const fits = Math.floor(half);
    expect(encodeLiteralInputs({ blob: 'é'.repeat(fits) }).bytes).toBe(LITERAL_INPUTS_MAX_BYTES - 1);
    expect(refusal({ blob: 'é'.repeat(fits + 1) }).message).toContain('1048576');
  });

  it('stops a shared-reference expansion at the bound instead of materializing it', () => {
    // 2^40 leaves if fully expanded: only a running byte count can refuse this.
    let node: unknown = 'x'.repeat(64);
    for (let level = 0; level < 40; level += 1) node = [node, node];
    const started = performance.now();
    const error = refusal({ node });
    expect(error.message).toContain('1048576');
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('inputs and the deprecated vars alias never combine', () => {
  it('returns nothing when the caller supplied no inputs', () => {
    expect(literalInputs({})).toBeUndefined();
    expect(literalInputs({ vars: { locale: 'fr-FR' } })).toBeUndefined();
    expect(literalInputs({ inputs: undefined })).toBeUndefined();
  });

  it('treats a present map as the literal channel, even when it is empty', () => {
    expect(literalInputs({ inputs: {} })).toEqual({ json: '{}', bytes: 2 });
    expect(literalInputs({ inputs: { ticketId: '42' } })).toEqual({
      json: '{"ticketId":"42"}',
      bytes: 17,
    });
  });

  it.each([
    ['two maps', { inputs: { a: 1 }, vars: { b: 2 } }],
    ['an empty vars alias', { inputs: { a: 1 }, vars: {} }],
    ['an empty inputs map', { inputs: {}, vars: { b: 2 } }],
    ['the same key on both', { inputs: { a: 1 }, vars: { a: 1 } }],
  ])('refuses %s: no merge, no last-wins', (_name, options) => {
    expect(() => literalInputs(options)).toThrow(NikaConfigurationError);
    expect(() => literalInputs(options)).toThrow(/inputs.*vars|vars.*inputs/);
  });

  it('refuses a present null instead of reading it as absent', () => {
    expect(() => literalInputs({ inputs: null as unknown as Record<string, unknown> }))
      .toThrow(/inputs must be a plain object/);
  });
});
