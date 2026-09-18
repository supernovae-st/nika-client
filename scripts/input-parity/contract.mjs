// The literal input parity contract (issue #116): one pure workflow, one case
// table, and what each case must do on BOTH transports. No model seat, no
// network, no file effect: `nika:jq` echoes the bound inputs back as outputs.

export const WORKFLOW_NAME = 'input-parity.nika.yaml';

export const WORKFLOW = `nika: input-parity
inputs:
  ticket: { type: string, required: true }
  count: { type: integer, required: true }
  tags: { type: { array: string }, required: true }
  record: { type: { object: { name: string, meta: { optional: { map: string } } } }, required: true }
  note: { type: { union: [string, null] }, default: null }
  ratio: { type: number, default: 0.5 }
  approved: { type: bool, default: false }
  region: { type: string, default: eu }
permits: { tools: ['nika:jq'] }
tasks:
  echo:
    invoke:
      tool: nika:jq
      args:
        input:
          ticket: '\${{ inputs.ticket }}'
          count: '\${{ inputs.count }}'
          tags: '\${{ inputs.tags }}'
          record: '\${{ inputs.record }}'
          note: '\${{ inputs.note }}'
          ratio: '\${{ inputs.ratio }}'
          approved: '\${{ inputs.approved }}'
          region: '\${{ inputs.region }}'
        expression: '.'
outputs:
  value: '\${{ tasks.echo.output }}'
`;

/** Set in the engine's and the resident's environment: a channel that read `@env:` would show it. */
export const ENV_CANARY = { name: 'NIKA_TEST_LITERAL', value: 'fixture-environment-value' };

export const MAP_LIMIT_BYTES = 1024 * 1024;

const required = { ticket: 'T-1', count: 42, tags: ['é', '東京'], record: { name: '🦋' } };
const defaults = { note: null, ratio: 0.5, approved: false, region: 'eu' };
const fileOrigins = { note: 'file', ratio: 'file', approved: 'file', region: 'file' };
const callerOrigins = (inputs) => Object.fromEntries(
  Object.keys(inputs).map((name) => [name, 'api-caller']),
);

function settles(name, inputs) {
  return {
    name,
    inputs,
    expect: {
      outcome: 'settled',
      status: 'succeeded',
      outputs: { value: { ...defaults, ...inputs } },
      origins: { ...fileOrigins, ...callerOrigins(inputs) },
    },
  };
}

function refuses(name, inputs, code) {
  return { name, inputs, expect: { outcome: 'refused', error: 'NikaOperationError', code } };
}

/** A map whose serialized size is exactly `bytes`, grown through its `ticket` text. */
export function sizedInputs(bytes) {
  const shell = Buffer.byteLength(JSON.stringify({ ...required, ticket: '' }));
  return { ...required, ticket: 'x'.repeat(bytes - shell) };
}

/** Judged by the engine on both transports: the verdicts and the origins must agree. */
export const ENGINE_CASES = [
  settles('env-text-stays-literal', { ...required, ticket: `@env:${ENV_CANARY.name}` }),
  settles('expression-text-stays-literal', { ...required, ticket: '${{ tasks.echo.output }}' }),
  settles('numeral-string-stays-a-string', { ...required, ticket: '42' }),
  settles('quoted-text-keeps-its-quotes', { ...required, ticket: `"@env:${ENV_CANARY.name}"` }),
  settles('nested-unicode-null-bool-number', {
    ...required,
    record: { name: 'Ünï 🦋', meta: { 'clé': 'valeur', empty: '' } },
    note: null,
    ratio: 1.5,
    approved: true,
  }),
  settles('declared-defaults-apply', required),
  settles('a-default-is-overridden', { ...required, region: 'us', note: 'literal note' }),
  settles('a-map-of-exactly-1-mib', sizedInputs(MAP_LIMIT_BYTES)),
  refuses('an-empty-map-misses-required-inputs', {}, 'NIKA-1708'),
  refuses('an-undeclared-key', { ...required, ninja: true }, 'unknown_input'),
  refuses('a-string-for-an-integer', { ...required, count: '42' }, 'input_type_mismatch'),
  refuses('an-integer-for-a-string', { ...required, ticket: 42 }, 'input_type_mismatch'),
  refuses('a-null-for-a-string', { ...required, ticket: null }, 'input_type_mismatch'),
  refuses('an-object-for-an-array', { ...required, tags: { 0: 'a' } }, 'input_type_mismatch'),
];

/** Judged by the SDK alone, identically on both transports, before any spawn or request. */
export const SDK_CASES = [
  {
    name: 'a-map-one-byte-over-1-mib',
    options: { inputs: sizedInputs(MAP_LIMIT_BYTES + 1) },
    expect: { outcome: 'refused', error: 'NikaConfigurationError', message: 'exceeds 1048576 bytes' },
  },
  {
    name: 'inputs-beside-the-deprecated-vars-alias',
    options: { inputs: required, vars: { ticket: 'T-2' } },
    expect: {
      outcome: 'refused',
      error: 'NikaConfigurationError',
      message: 'inputs and the deprecated vars alias cannot be combined',
    },
  },
];

export const REQUIRED_INPUTS = required;
