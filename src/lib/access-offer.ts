import { NikaProtocolError } from '../errors.js';
import type {
  NikaAccessOffer,
  NikaAccessOfferListing,
  NikaAccessOfferRoute,
  NikaAccessRequirement,
  NikaTransportKind,
} from '../types.js';

/** The `/health` token of `GET /v1/access-offers/{name}`. */
export const ACCESS_OFFER_CAPABILITY = 'accessSessionOffer';

/** The one schema word this package reads. */
export const ACCESS_OFFER_SCHEMA = 'nika/access-offer@1';

/**
 * How long one `accessOffer()` call may take by default. The server bounds a
 * request at 90 s (a reading opens one session per route, 30 s each at most);
 * the default leaves it room to answer.
 */
export const ACCESS_OFFER_TIMEOUT_MS = 100_000;

const DOCUMENT_KEYS = new Set([
  'schema', 'workflow', 'status', 'reason', 'declared', 'prompts_sent', 'routes', 'routes_omitted',
]);
const DECLARED_KEYS = new Set(['via', 'protocol', 'fallback', 'effort', 'service_tier']);
const ROUTE_KEYS = new Set([
  'via', 'protocol', 'profile', 'tasks', 'status', 'observed_at', 'fresh_until', 'code', 'reason',
  'adapter', 'model', 'effort', 'service_tier',
]);
const ADAPTER_KEYS = new Set(['name', 'version']);
const MODEL_KEYS = new Set(['requested', 'status', 'current', 'offered', 'omitted']);
const LISTING_KEYS = new Set(['status', 'option', 'offered', 'omitted', 'current', 'reason']);
const MODEL_STATES = new Set([
  'confirmed', 'session_default', 'legacy_list', 'not_offered', 'not_confirmed',
]);
const LISTING_STATES = new Set(['offered', 'not_offered', 'unobserved']);

/** A value an adapter listed: one to 160 graphic ASCII bytes, as the server carries it. */
const TOKEN = /^[!-~]{1,160}$/;
const MAX_ROUTES = 8;
const MAX_LISTED = 64;

class Malformed extends Error {}

function fail(what: string): never {
  throw new Malformed(what);
}

function object(value: unknown, what: string, keys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} is not an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !keys.has(key));
  if (unknown !== undefined) fail(`${what} carries the unknown key ${JSON.stringify(unknown)}`);
  return record;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${what} is not a non-empty string`);
  return value as string;
}

function optionalText(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : text(value, what);
}

function token(value: unknown, what: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail(`${what} is not a token`);
  return value as string;
}

function optionalToken(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : token(value, what);
}

function tokens(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LISTED) fail(`${what} is not a bounded list`);
  return (value as unknown[]).map((entry, index) => token(entry, `${what}[${index}]`));
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${what} is not a count`);
  }
  return value as number;
}

function instant(value: unknown, what: string): string {
  const stamp = text(value, what);
  if (Number.isNaN(Date.parse(stamp))) fail(`${what} is not a time`);
  return stamp;
}

function declared(value: unknown): NikaAccessRequirement {
  const record = object(value, 'declared', DECLARED_KEYS);
  const out: NikaAccessRequirement = {};
  for (const key of DECLARED_KEYS) {
    if (record[key] !== undefined) out[key] = text(record[key], `declared.${key}`);
  }
  return out;
}

function listing(value: unknown, what: string): NikaAccessOfferListing {
  const record = object(value, what, LISTING_KEYS);
  const status = text(record.status, `${what}.status`);
  if (!LISTING_STATES.has(status)) fail(`${what}.status is the unknown word ${JSON.stringify(status)}`);
  const out: NikaAccessOfferListing = { status: status as NikaAccessOfferListing['status'] };
  const option = optionalToken(record.option, `${what}.option`);
  if (option !== undefined) out.option = option;
  if (record.offered !== undefined) out.offered = tokens(record.offered, `${what}.offered`);
  if (record.omitted !== undefined) out.omitted = count(record.omitted, `${what}.omitted`);
  const current = optionalToken(record.current, `${what}.current`);
  if (current !== undefined) out.current = current;
  const reason = optionalText(record.reason, `${what}.reason`);
  if (reason !== undefined) out.reason = reason;
  if (out.status === 'offered' && out.offered === undefined) fail(`${what} is offered and lists nothing`);
  return out;
}

function model(value: unknown, what: string): NikaAccessOfferRoute['model'] {
  const record = object(value, what, MODEL_KEYS);
  const out: NikaAccessOfferRoute['model'] = { requested: text(record.requested, `${what}.requested`) };
  if (record.status !== undefined) {
    const status = text(record.status, `${what}.status`);
    if (!MODEL_STATES.has(status)) fail(`${what}.status is the unknown word ${JSON.stringify(status)}`);
    out.status = status as NonNullable<NikaAccessOfferRoute['model']['status']>;
  }
  const current = optionalToken(record.current, `${what}.current`);
  if (current !== undefined) out.current = current;
  if (record.offered !== undefined) out.offered = tokens(record.offered, `${what}.offered`);
  if (record.omitted !== undefined) out.omitted = count(record.omitted, `${what}.omitted`);
  return out;
}

function route(value: unknown, index: number): NikaAccessOfferRoute {
  const what = `routes[${index}]`;
  const record = object(value, what, ROUTE_KEYS);
  if (record.protocol !== 'acp') fail(`${what}.protocol is not acp`);
  if (record.profile !== 'completion' && record.profile !== 'agent') fail(`${what}.profile is unknown`);
  if (record.status !== 'observed' && record.status !== 'unavailable') fail(`${what}.status is unknown`);
  if (!Array.isArray(record.tasks)) fail(`${what}.tasks is not a list`);
  const out: NikaAccessOfferRoute = {
    via: text(record.via, `${what}.via`),
    protocol: 'acp',
    profile: record.profile,
    tasks: (record.tasks as unknown[]).map((task, at) => text(task, `${what}.tasks[${at}]`)),
    status: record.status,
    observed_at: instant(record.observed_at, `${what}.observed_at`),
    fresh_until: instant(record.fresh_until, `${what}.fresh_until`),
    model: model(record.model, `${what}.model`),
  };
  const code = optionalText(record.code, `${what}.code`);
  if (code !== undefined) out.code = code;
  const reason = optionalText(record.reason, `${what}.reason`);
  if (reason !== undefined) out.reason = reason;
  if (record.adapter !== undefined) {
    const adapter = object(record.adapter, `${what}.adapter`, ADAPTER_KEYS);
    out.adapter = {};
    const name = optionalToken(adapter.name, `${what}.adapter.name`);
    if (name !== undefined) out.adapter.name = name;
    const version = optionalToken(adapter.version, `${what}.adapter.version`);
    if (version !== undefined) out.adapter.version = version;
  }
  if (record.effort !== undefined) out.effort = listing(record.effort, `${what}.effort`);
  if (record.service_tier !== undefined) {
    out.service_tier = listing(record.service_tier, `${what}.service_tier`);
  }
  // An observed row answers about its model and its two listings; an unavailable one says why.
  if (out.status === 'observed') {
    if (out.model.status === undefined || out.effort === undefined || out.service_tier === undefined) {
      fail(`${what} is observed without its model state and listings`);
    }
  } else if (out.code === undefined) {
    fail(`${what} is unavailable without a code`);
  }
  return out;
}

/**
 * Read the answer of `GET /v1/access-offers/{name}` for `workflow`: the closed
 * `nika/access-offer@1` document, or a protocol error naming what is wrong.
 * Nothing is coerced: a key, a word or a schema this package does not know is
 * refused, never guessed around.
 */
export function parseAccessOffer(
  value: unknown,
  workflow: string,
  kind: NikaTransportKind,
): NikaAccessOffer {
  try {
    const record = object(value, 'the document', DOCUMENT_KEYS);
    if (record.schema !== ACCESS_OFFER_SCHEMA) fail(`schema is not ${ACCESS_OFFER_SCHEMA}`);
    if (record.workflow !== workflow) fail('workflow is not the one asked');
    if (record.status !== 'read' && record.status !== 'not_applicable') fail('status is unknown');
    if (record.prompts_sent !== 0) fail('prompts_sent is not 0');
    if (!Array.isArray(record.routes) || record.routes.length > MAX_ROUTES) {
      fail('routes is not a bounded list');
    }
    const out: NikaAccessOffer = {
      schema: ACCESS_OFFER_SCHEMA,
      workflow,
      status: record.status,
      prompts_sent: 0,
      routes: (record.routes as unknown[]).map(route),
      routes_omitted: count(record.routes_omitted, 'routes_omitted'),
    };
    const reason = optionalText(record.reason, 'reason');
    if (reason !== undefined) out.reason = reason;
    if (record.declared !== undefined) out.declared = declared(record.declared);
    if (out.status === 'not_applicable' && (out.reason === undefined || out.routes.length > 0)) {
      fail('a document that asked no route names a reason and no route');
    }
    return out;
  } catch (cause) {
    if (!(cause instanceof Malformed)) throw cause;
    throw new NikaProtocolError(kind, `Access offer response was malformed: ${cause.message}`);
  }
}
