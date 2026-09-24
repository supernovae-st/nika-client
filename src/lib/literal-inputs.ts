import { types } from 'node:util';
import { NikaConfigurationError } from '../errors.js';
import type { NikaRunOptions } from '../types.js';

/**
 * The literal input map of `run({ inputs })` (issue #116), serialized once for
 * both transports: the native engine reads these bytes on stdin (`nika run
 * --inputs-json -`, nika#1683) and `nika serve` reads them as `JobByName.inputs`
 * (nika#1642). The engine owns validation, typing and provenance; this module
 * only guarantees that the bytes are exactly the JSON the caller meant.
 *
 * `JSON.stringify` cannot give that guarantee: it drops `undefined`, functions
 * and symbol keys, writes `null` for a hole or a non-finite number, calls
 * `toJSON` and accessors, and flattens any class instance to its own fields.
 * So the map is judged and written in one pass, and a value JSON cannot carry
 * is refused by path before anything is spawned or sent. The offending value is
 * never quoted: an input may be a credential.
 *
 * No caller code runs while the map is judged. A member is judged from its
 * descriptor and never read, so no getter runs; and a Proxy is refused before
 * anything introspects it (the value, its prototype, that prototype's
 * constructor), because every such read would run one of its traps.
 */

/** The serialized-map bound the native engine reads; the SDK applies it to both transports. */
export const LITERAL_INPUTS_MAX_BYTES = 1024 * 1024;

export interface LiteralInputs {
  /** The compact JSON text of the map: the only input bytes either transport sends. */
  readonly json: string;
  /** Its UTF-8 size, at most `LITERAL_INPUTS_MAX_BYTES`. */
  readonly bytes: number;
}

/**
 * The literal channel a run asked for, or undefined when it asked for none. A
 * present map is the channel even when empty: the engine, not the SDK, owns
 * what an empty map means. `inputs` beside the deprecated `vars` alias is
 * refused: two channels with different semantics never merge.
 */
export function literalInputs(options: NikaRunOptions): LiteralInputs | undefined {
  if (options.inputs === undefined) return undefined;
  if (options.vars !== undefined) {
    throw new NikaConfigurationError(
      'run({ inputs, vars }): inputs and the deprecated vars alias cannot be combined; '
      + 'move every value into inputs',
    );
  }
  return encodeLiteralInputs(options.inputs);
}

/** One open array or plain object, walked without recursion so depth never meets the call stack. */
interface Frame {
  readonly value: object;
  /** How the parent named this container; `inputs` for the root. */
  readonly segment: string;
  /** A plain object's own keys; absent for an array. */
  readonly keys?: readonly (string | symbol)[];
  readonly length: number;
  index: number;
}

const STRICT_JSON = 'inputs must be strict JSON (null, booleans, finite numbers, strings, '
  + 'plain arrays and plain objects)';
const NATIVE_OBJECT = Function.prototype.toString.call(Object);
const NATIVE_ARRAY = Function.prototype.toString.call(Array);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PATH_LIMIT = 240;

export function encodeLiteralInputs(
  inputs: unknown,
  label: 'run({ inputs })' | 'schedule({ inputs })' | 'compile({ answers })' | 'compile({ change })' = 'run({ inputs })',
): LiteralInputs {
  if (containerKind(inputs) !== 'object') {
    const subject = label === 'run({ inputs })' || label === 'schedule({ inputs })'
      ? 'inputs must be a plain object mapping declared workflow input names'
      : 'answers must be a plain object mapping stable question keys';
    throw new NikaConfigurationError(
      `${label}: ${subject} to strict JSON values; received ${describe(inputs)}`,
    );
  }

  const parts: string[] = [];
  let bytes = 0;
  const write = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > LITERAL_INPUTS_MAX_BYTES) throw tooLarge(label);
    parts.push(chunk);
  };

  const stack: Frame[] = [];
  const open = new Set<object>();
  const refuse = (segment: string, problem: string): NikaConfigurationError => {
    const path = stack.map((frame) => frame.segment).join('') + segment;
    const shown = path.length > PATH_LIMIT
      ? `${path.slice(0, PATH_LIMIT / 2)}…${path.slice(-PATH_LIMIT / 2)}`
      : path;
    return new NikaConfigurationError(`${label}: ${shown} ${problem}; ${STRICT_JSON}`);
  };
  const enter = (value: object, segment: string, kind: 'array' | 'object'): void => {
    open.add(value);
    if (kind === 'array') {
      write('[');
      stack.push({ value, segment, length: (value as unknown[]).length, index: 0 });
    } else {
      write('{');
      const keys = Reflect.ownKeys(value);
      stack.push({ value, segment, keys, length: keys.length, index: 0 });
    }
  };

  enter(inputs as object, 'inputs', 'object');
  for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
    if (frame.index === frame.length) {
      // An array's named members are judged once its elements fit the bound,
      // so a hostile length never costs more than the bound allows.
      if (!frame.keys) {
        const named = Reflect.ownKeys(frame.value).find((key) => !isArrayMember(key, frame.length));
        if (named !== undefined) {
          stack.pop();
          throw refuse(frame.segment + keySegment(named), typeof named === 'symbol'
            ? 'is a symbol key, which JSON cannot carry'
            : 'is a named array property, which JSON cannot carry');
        }
      }
      write(frame.keys ? '}' : ']');
      open.delete(frame.value);
      stack.pop();
      continue;
    }

    const position = frame.index;
    frame.index += 1;
    if (position > 0) write(',');
    const key = frame.keys ? frame.keys[position]! : String(position);
    const segment = frame.keys ? keySegment(key) : `[${position}]`;
    if (typeof key === 'symbol') throw refuse(segment, 'is a symbol key, which JSON cannot carry');
    // The member is judged from its descriptor and never read, and this
    // container is no Proxy (refused on entry): no getter and no trap can run.
    const member = Object.getOwnPropertyDescriptor(frame.value, key);
    if (!member) {
      throw refuse(segment, frame.keys
        ? 'is not an own data property'
        : 'is an array hole, which JSON cannot carry');
    }
    if ('get' in member || 'set' in member) {
      throw refuse(segment, 'is an accessor property, which JSON cannot carry');
    }
    if (frame.keys) {
      if (!member.enumerable) {
        throw refuse(segment, 'is a non-enumerable property, which JSON cannot carry');
      }
      if (LONE_SURROGATE.test(key)) {
        throw refuse(segment, 'is a key with a lone surrogate, which is not valid Unicode');
      }
      write(`${JSON.stringify(key)}:`);
    }

    const value: unknown = member.value;
    switch (typeof value) {
      case 'string':
        // Every UTF-16 unit is at least one UTF-8 byte: refuse before copying.
        if (value.length > LITERAL_INPUTS_MAX_BYTES) throw tooLarge(label);
        if (LONE_SURROGATE.test(value)) {
          throw refuse(segment, 'contains a lone surrogate, which is not valid Unicode');
        }
        write(JSON.stringify(value));
        break;
      case 'number':
        if (!Number.isFinite(value)) {
          throw refuse(segment, 'is a non-finite number, which JSON cannot carry');
        }
        write(JSON.stringify(value));
        break;
      case 'boolean':
        write(value ? 'true' : 'false');
        break;
      case 'object': {
        if (value === null) {
          write('null');
          break;
        }
        if (open.has(value)) throw refuse(segment, 'is a cycle, which JSON cannot carry');
        const kind = containerKind(value);
        if (!kind) throw refuse(segment, refusedObject(value));
        enter(value, segment, kind);
        break;
      }
      default:
        // undefined · function · symbol · bigint
        throw refuse(segment, `is ${typeof value === 'undefined' ? '' : 'a '}${typeof value}, `
          + 'which JSON cannot carry');
    }
  }

  return { json: parts.join(''), bytes };
}

function tooLarge(label: 'run({ inputs })' | 'schedule({ inputs })' | 'compile({ answers })' | 'compile({ change })'): NikaConfigurationError {
  if (label === 'schedule({ inputs })') {
    return new NikaConfigurationError(`schedule({ inputs }): the serialized inputs map exceeds ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB)`);
  }
  if (label === 'compile({ change })') {
    return new NikaConfigurationError(
      `compile({ change }): the serialized literal exceeds ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB)`,
    );
  }
  if (label === 'compile({ answers })') {
    return new NikaConfigurationError(
      `compile({ answers }): the serialized answers exceed ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB); `
      + 'answers ride argv, one KEY=JSON element each, never a wire',
    );
  }
  return new NikaConfigurationError(
    `run({ inputs }): the serialized inputs map exceeds ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB), `
    + 'the bound both transports share with the native engine',
  );
}

/**
 * `array` or `object` for the two containers JSON has, in any realm: a body
 * fetched or cloned under a test runner carries another realm's prototypes.
 * Anything else (a class instance, a Date, a Map, a subclass) has state or
 * behavior JSON would silently discard.
 *
 * A Proxy is refused first, before `Array.isArray` (which throws on a revoked
 * one) and before `getPrototypeOf` (a trap): it cannot be read without running
 * caller code, and what it would answer twice need not agree.
 */
function containerKind(value: unknown): 'array' | 'object' | undefined {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const prototype: object | null = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return isRealmPrototype(prototype, NATIVE_ARRAY) ? 'array' : undefined;
  if (prototype === null) return 'object';
  return isRealmPrototype(prototype, NATIVE_OBJECT) ? 'object' : undefined;
}

/**
 * Whether `prototype` IS some realm's `Object.prototype` (or `Array.prototype`),
 * not merely an object that names that constructor: `Object.create({ constructor:
 * Object })` has a custom prototype whose inherited data JSON would drop. Two
 * facts a caller cannot arrange together decide it: the constructor's source is
 * the native one, and that constructor's own `prototype` is this very object. A
 * native constructor's `prototype` is non-writable and non-configurable, so it
 * can never be pointed at a caller's object. Nothing here reads a Proxy.
 */
function isRealmPrototype(prototype: object | null, source: string): boolean {
  if (prototype === null || types.isProxy(prototype)) return false;
  const constructor = ownValue(prototype, 'constructor');
  if (typeof constructor !== 'function' || types.isProxy(constructor)) return false;
  let native: boolean;
  try {
    native = Function.prototype.toString.call(constructor) === source;
  } catch {
    return false;
  }
  return native && ownValue(constructor, 'prototype') === prototype;
}

/** An own data property's value, from its descriptor: never a getter, and never on a Proxy. */
function ownValue(target: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

function isArrayMember(key: string | symbol, length: number): boolean {
  if (typeof key === 'symbol') return false;
  if (key === 'length') return true;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function keySegment(key: string | symbol): string {
  if (typeof key === 'symbol') return `[${String(key)}]`;
  return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** The kind of a refused value, never the value. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value !== 'object') return `a ${typeof value}`;
  // Before Array.isArray: it throws on a revoked Proxy.
  if (types.isProxy(value)) return 'a Proxy';
  if (Array.isArray(value)) return 'an array';
  return refusedObject(value).replace(/^is /, '').replace(/, not a plain object or array$/, '');
}

/**
 * Why an object that is no plain container is refused. A constructor is named
 * only when the prototype really is that constructor's own, so a prototype that
 * merely claims `Object` reads as what it is: custom. Nothing reads a Proxy.
 */
function refusedObject(value: object): string {
  if (types.isProxy(value)) return 'is a Proxy, which cannot be read without running its traps';
  const custom = 'is an object with a custom prototype, not a plain object or array';
  const prototype: object | null = Object.getPrototypeOf(value);
  if (prototype === null || types.isProxy(prototype)) return custom;
  const constructor = ownValue(prototype, 'constructor');
  if (typeof constructor !== 'function' || types.isProxy(constructor)) return custom;
  if (ownValue(constructor, 'prototype') !== prototype) return custom;
  const name = ownValue(constructor, 'name');
  return typeof name === 'string' && IDENTIFIER.test(name) && name.length <= 64
    ? `is a ${name} instance, not a plain object or array`
    : custom;
}
