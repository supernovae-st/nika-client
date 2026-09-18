'use strict';

// One action of the literal input parity proof (issue #116), run inside a
// fresh consumer of the PACKED package. CommonJS on purpose: the ESM entry and
// the CommonJS entry both load this file and each passes the SDK namespace its
// own module system resolved, so the package under test is never loaded twice.

const { createHash } = require('node:crypto');

/** One frame may echo a 1 MiB input back: the default 64 KiB bound is for ordinary runs. */
const MACHINE_BUFFER_BYTES = 4 * 1024 * 1024;
const DIGEST_ABOVE_BYTES = 1024;

/** Long text is compared by digest so a report never carries a megabyte. */
function digested(value) {
  if (typeof value === 'string' && Buffer.byteLength(value) > DIGEST_ABOVE_BYTES) {
    return {
      $bytes: Buffer.byteLength(value),
      $sha256: createHash('sha256').update(value).digest('hex'),
    };
  }
  if (Array.isArray(value)) return value.map(digested);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, digested(item)]));
  }
  return value;
}

/** The engine's own provenance line: `inputs` on the native `workflow_started` frame. */
function nativeOrigins(frames) {
  const started = frames.find((frame) => frame.kind === 'workflow_started');
  const row = Array.isArray(started?.fields)
    ? started.fields.find((field) => field.key === 'inputs')
    : undefined;
  return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
}

/**
 * An engine ahead of this SDK's pinned wire may add fields to the resident's
 * closed projections, which the SDK rightly refuses. `dropFields` is the
 * harness's explicit, reported adapter for that ORTHOGONAL drift: it removes
 * exactly the named top-level fields from job objects and SSE frames, counts
 * every removal, and is off unless the supervisor was told to use it. It never
 * touches a request, so what the SDK sends is always what the resident reads.
 */
async function withoutFields(response, dropFields, dropped) {
  const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  const strip = (object) => {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) return object;
    for (const field of dropFields) {
      if (Object.hasOwn(object, field)) {
        delete object[field];
        dropped[field] = (dropped[field] ?? 0) + 1;
      }
    }
    return object;
  };
  const rebuilt = (body) => new Response(body, { status: response.status, headers: response.headers });
  if (type === 'application/json') return rebuilt(JSON.stringify(strip(await response.json())));
  if (type === 'text/event-stream') {
    // The resident ends the stream after the terminal frame, so it is finite.
    const text = await response.text();
    return rebuilt(text.split('\n').map((line) => (line.startsWith('data:')
      ? `data: ${JSON.stringify(strip(JSON.parse(line.slice(5))))}`
      : line)).join('\n'));
  }
  return response;
}

module.exports = async function inputParityAction(sdk, config) {
  const requests = [];
  const dropFields = config.dropFields ?? [];
  const dropped = {};
  const recordingFetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? init.body : null;
    const { pathname } = new URL(String(url));
    requests.push({
      method: init.method ?? 'GET',
      path: pathname,
      body_bytes: body === null ? null : Buffer.byteLength(body),
      body_sha256: body === null ? null : createHash('sha256').update(body).digest('hex'),
    });
    const response = await fetch(url, init);
    return dropFields.length > 0 && pathname.startsWith('/v1/jobs/')
      ? withoutFields(response, dropFields, dropped)
      : response;
  };
  const client = config.door === 'native'
    ? new sdk.Nika({ bin: config.bin, cwd: config.project, machineBufferBytes: MACHINE_BUFFER_BYTES })
    : new sdk.Nika({
        url: config.url,
        token: config.token,
        allowInsecureHttp: true,
        fetch: recordingFetch,
        machineBufferBytes: MACHINE_BUFFER_BYTES,
        // A snapshot-form run would capture with this engine; by-name never does.
        bin: config.bin,
        cwd: config.project,
      });
  const options = {
    ...config.options,
    // The ceiling is a native flag; the resident applies its own.
    ...(config.door === 'native' ? { maxCostUsd: 0 } : { idempotencyKey: config.idempotencyKey }),
  };
  // `dropped` is filled while the run is observed; the row holds the same object.
  const row = {
    case: config.case,
    door: config.door,
    module_system: config.moduleSystem,
    ...(dropFields.length > 0 ? { projection_adapter: { drop_fields: dropFields, dropped } } : {}),
  };
  try {
    const run = await client.run(config.workflow, options);
    // The Run owns its lifecycle; provenance is an engine fact, so it is read
    // from the protocol frame each lifecycle event carries on `raw`.
    const frames = [];
    for await (const event of run.events()) frames.push(event.raw);
    const result = await run.result();
    return {
      ...row,
      outcome: 'settled',
      status: result.status,
      succeeded: sdk.isNikaRunSucceeded(result),
      outputs: digested(result.outputs ?? null),
      origins: config.door === 'native' ? nativeOrigins(frames) : null,
      execution_id: result.receipt?.execution_id ?? null,
      requests,
    };
  } catch (error) {
    return {
      ...row,
      outcome: 'refused',
      error: error.name,
      typed: {
        operation: error instanceof sdk.NikaOperationError,
        compatibility: error instanceof sdk.NikaCompatibilityError,
        configuration: error instanceof sdk.NikaConfigurationError,
      },
      code: error.code ?? null,
      machine_code: error.machineCode ?? null,
      status: error.status ?? null,
      capability: error.capability ?? null,
      transport: error.transport ?? null,
      message: error.message,
      requests,
    };
  }
};

module.exports.digested = digested;
module.exports.withoutFields = withoutFields;
