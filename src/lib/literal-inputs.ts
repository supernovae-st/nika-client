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

export function encodeLiteralInputs(inputs: unknown): LiteralInputs {
  if (containerKind(inputs) !== 'object') {
    throw new NikaConfigurationError(
      'run({ inputs }): inputs must be a plain object mapping declared workflow input names '
      + `to strict JSON values; received ${describe(inputs)}`,
    );
  }

  const parts: string[] = [];
  let bytes = 0;
  const write = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > LITERAL_INPUTS_MAX_BYTES) throw tooLarge();
    parts.push(chunk);
  };

  const stack: Frame[] = [];
  const open = new Set<object>();
  const refuse = (segment: string, problem: string): NikaConfigurationError => {
    const path = stack.map((frame) => frame.segment).join('') + segment;
    const shown = path.length > PATH_LIMIT
      ? `${path.slice(0, PATH_LIMIT / 2)}…${path.slice(-PATH_LIMIT / 2)}`
      : path;
    return new NikaConfigurationError(`run({ inputs }): ${shown} ${problem}; ${STRICT_JSON}`);
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
    // The descriptor is read, never the property: no caller code runs here.
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
        if (value.length > LITERAL_INPUTS_MAX_BYTES) throw tooLarge();
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
        if (!kind) throw refuse(segment, `${describeInstance(value)}, not a plain object or array`);
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

function tooLarge(): NikaConfigurationError {
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
 */
function containerKind(value: unknown): 'array' | 'object' | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const prototype: object | null = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return prototype !== null && isNative(constructorOf(prototype), NATIVE_ARRAY)
      ? 'array'
      : undefined;
  }
  if (prototype === null) return 'object';
  return isNative(constructorOf(prototype), NATIVE_OBJECT) ? 'object' : undefined;
}

function constructorOf(prototype: object): unknown {
  return Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
}

function isNative(constructor: unknown, source: string): boolean {
  if (typeof constructor !== 'function') return false;
  try {
    return Function.prototype.toString.call(constructor) === source;
  } catch {
    return false;
  }
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
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return describeInstance(value).replace(/^is /, '');
  if (typeof value === 'undefined') return 'undefined';
  return `a ${typeof value}`;
}

function describeInstance(value: object): string {
  const prototype: object | null = Object.getPrototypeOf(value);
  const constructor = prototype === null ? undefined : constructorOf(prototype);
  const name = typeof constructor === 'function'
    ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value
    : undefined;
  return typeof name === 'string' && IDENTIFIER.test(name) && name.length <= 64
    ? `is a ${name} instance`
    : 'is an object with a custom prototype';
}
