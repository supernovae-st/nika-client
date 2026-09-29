import { types } from 'node:util';
import { NikaConfigurationError } from '../errors.js';

/*
 * The strict JSON literal encoder of @supernovae-st/nika 0.120.3 as published
 * on npm (its literal-inputs module): one serialization, done once, of a map
 * of literal values. Only null, booleans, finite numbers, strings, plain
 * arrays and plain objects pass, exactly as given (false, 0, "" and null stay
 * themselves); anything JSON cannot carry refuses with the path that holds
 * it, and no caller code runs while the map is judged: no getter is invoked,
 * and a Proxy is refused before it is read.
 */

/** The bound both transports share with the native engine. */
export const LITERAL_INPUTS_MAX_BYTES = 1024 * 1024;

export type LiteralLabel = 'run({ inputs })' | 'compile({ answers })' | 'compile({ change })';

export interface EncodedLiterals {
  json: string;
  bytes: number;
}

const STRICT_JSON = 'inputs must be strict JSON (null, booleans, finite numbers, strings, plain arrays and plain objects)';
const NATIVE_OBJECT = Function.prototype.toString.call(Object);
const NATIVE_ARRAY = Function.prototype.toString.call(Array);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PATH_LIMIT = 240;

type Container = 'object' | 'array';

interface Frame {
  value: object;
  segment: string;
  keys?: (string | symbol)[];
  length: number;
  index: number;
}

/** The caller's literal run inputs, encoded once, or `undefined` when none were given. */
export function literalInputs(options: { inputs?: unknown; vars?: unknown }): EncodedLiterals | undefined {
  if (options.inputs === undefined) return undefined;
  if (options.vars !== undefined) {
    throw new NikaConfigurationError(
      'run({ inputs, vars }): inputs and the deprecated vars alias cannot be combined; move every value into inputs',
    );
  }
  return encodeLiteralInputs(options.inputs);
}

/** Encode a plain map of strict JSON literals once, or refuse with the path that breaks the law. */
export function encodeLiteralInputs(inputs: unknown, label: LiteralLabel = 'run({ inputs })'): EncodedLiterals {
  if (containerKind(inputs) !== 'object') {
    const subject = label === 'run({ inputs })'
      ? 'inputs must be a plain object mapping declared workflow input names'
      : 'answers must be a plain object mapping stable question keys';
    throw new NikaConfigurationError(`${label}: ${subject} to strict JSON values; received ${describe(inputs)}`);
  }
  const parts: string[] = [];
  let bytes = 0;
  const write = (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > LITERAL_INPUTS_MAX_BYTES) throw tooLarge(label);
    parts.push(chunk);
  };
  const stack: Frame[] = [];
  const open = new Set<object>();
  const refuse = (segment: string, problem: string) => {
    const path = stack.map((frame) => frame.segment).join('') + segment;
    const shown = path.length > PATH_LIMIT
      ? `${path.slice(0, PATH_LIMIT / 2)}…${path.slice(-PATH_LIMIT / 2)}`
      : path;
    return new NikaConfigurationError(`${label}: ${shown} ${problem}; ${STRICT_JSON}`);
  };
  const enter = (value: object, segment: string, kind: Container) => {
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
      if (!frame.keys) {
        const length = frame.length;
        const named = Reflect.ownKeys(frame.value).find((key) => !isArrayMember(key, length));
        if (named !== undefined) {
          const segment = frame.segment + keySegment(named);
          stack.pop();
          throw refuse(segment, typeof named === 'symbol'
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
    const key = frame.keys ? frame.keys[position] : String(position);
    const segment = frame.keys ? keySegment(key) : `[${position}]`;
    if (typeof key === 'symbol') throw refuse(segment, 'is a symbol key, which JSON cannot carry');
    const member = Object.getOwnPropertyDescriptor(frame.value, key);
    if (!member) {
      throw refuse(segment, frame.keys ? 'is not an own data property' : 'is an array hole, which JSON cannot carry');
    }
    if ('get' in member || 'set' in member) {
      throw refuse(segment, 'is an accessor property, which JSON cannot carry');
    }
    if (frame.keys) {
      if (!member.enumerable) throw refuse(segment, 'is a non-enumerable property, which JSON cannot carry');
      if (LONE_SURROGATE.test(key)) {
        throw refuse(segment, 'is a key with a lone surrogate, which is not valid Unicode');
      }
      write(`${JSON.stringify(key)}:`);
    }
    const value: unknown = member.value;
    switch (typeof value) {
      case 'string':
        if (value.length > LITERAL_INPUTS_MAX_BYTES) throw tooLarge(label);
        if (LONE_SURROGATE.test(value)) {
          throw refuse(segment, 'contains a lone surrogate, which is not valid Unicode');
        }
        write(JSON.stringify(value));
        break;
      case 'number':
        if (!Number.isFinite(value)) throw refuse(segment, 'is a non-finite number, which JSON cannot carry');
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
        throw refuse(segment, `is ${typeof value === 'undefined' ? '' : 'a '}${typeof value}, which JSON cannot carry`);
    }
  }
  return { json: parts.join(''), bytes };
}

function tooLarge(label: LiteralLabel): NikaConfigurationError {
  if (label === 'compile({ change })') {
    return new NikaConfigurationError(
      `compile({ change }): the serialized literal exceeds ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB)`,
    );
  }
  if (label === 'compile({ answers })') {
    return new NikaConfigurationError(
      `compile({ answers }): the serialized answers exceed ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB)`,
    );
  }
  return new NikaConfigurationError(
    `run({ inputs }): the serialized inputs map exceeds ${LITERAL_INPUTS_MAX_BYTES} bytes (1 MiB), the bound both transports share with the native engine`,
  );
}

function containerKind(value: unknown): Container | undefined {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) return isRealmPrototype(prototype, NATIVE_ARRAY) ? 'array' : undefined;
  if (prototype === null) return 'object';
  return isRealmPrototype(prototype, NATIVE_OBJECT) ? 'object' : undefined;
}

function isRealmPrototype(prototype: unknown, source: string): boolean {
  if (prototype === null || typeof prototype !== 'object' || types.isProxy(prototype)) return false;
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

/** What a refused root value is, in words, without reading it. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value !== 'object') return `a ${typeof value}`;
  if (types.isProxy(value)) return 'a Proxy';
  if (Array.isArray(value)) return 'an array';
  return refusedObject(value).replace(/^is /, '').replace(/, not a plain object or array$/, '');
}

function refusedObject(value: object): string {
  if (types.isProxy(value)) return 'is a Proxy, which cannot be read without running its traps';
  const custom = 'is an object with a custom prototype, not a plain object or array';
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || typeof prototype !== 'object' || types.isProxy(prototype)) return custom;
  const constructor = ownValue(prototype, 'constructor');
  if (typeof constructor !== 'function' || types.isProxy(constructor)) return custom;
  if (ownValue(constructor, 'prototype') !== prototype) return custom;
  const name = ownValue(constructor, 'name');
  return typeof name === 'string' && IDENTIFIER.test(name) && name.length <= 64
    ? `is a ${name} instance, not a plain object or array`
    : custom;
}
