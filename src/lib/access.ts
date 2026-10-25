import { types } from 'node:util';
import { NikaConfigurationError } from '../errors.js';

/**
 * The `access` option of `run()` and `check()`: the engine's access pin, the
 * value `nika run --access` and `nika check --access` take and the one
 * `JobByName.access` / `CheckByName.access` carry over HTTP.
 *
 * The engine owns its meaning. A class it does not know, a retired wrapper id,
 * a pin its model cannot use, and an empty or blank pin are the engine's to
 * refuse (NIKA-1802, NIKA-1801), on both doors, so this module never judges the
 * vocabulary or the length. It refuses only what neither door can carry
 * unchanged, before anything is spawned or sent: a value that is not a string,
 * a NUL byte (no argv carries one), and a lone surrogate (not valid Unicode, so
 * neither argv nor JSON would hold the caller's value). The value is never
 * quoted: it names an access path, but a refusal still says only what is wrong.
 */

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function accessPin(value: unknown, operation: 'run' | 'check'): string | undefined {
  if (value === undefined) return undefined;
  const label = `${operation}({ access })`;
  if (typeof value !== 'string') {
    throw new NikaConfigurationError(
      `${label}: access must be a string naming an access class or a harness seat, `
      + `the value \`nika ${operation} --access\` takes; received ${kindOf(value)}`,
    );
  }
  if (value.includes('\0')) {
    throw new NikaConfigurationError(`${label}: access contains a NUL byte, which no argv can carry`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw new NikaConfigurationError(
      `${label}: access contains a lone surrogate, which is not valid Unicode`,
    );
  }
  return value;
}

/**
 * The native flag, as one argv element: `--access=<pin>`. The `=` form keeps a
 * pin that starts with `-` a value instead of another flag (measured on engine
 * 0.123.1: `--access -x` is a usage error, `--access=-x` the engine's NIKA-1802),
 * and it carries an empty pin to the engine, which refuses it.
 */
export function accessFlag(pin: string): string {
  return `--access=${pin}`;
}

/** The kind of a refused value, never the value. A Proxy is named before anything reads it. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (types.isProxy(value)) return 'a Proxy';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
