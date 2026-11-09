import { describe, expect, it } from 'vitest';

import {
  NikaProtocolError,
  readNikaAccessRequirement,
  readNikaAccessSelection,
} from '../src/index.js';
import type { NikaEvent, NikaRunEvent } from '../src/index.js';

// Contract-shaped frames, hand-built from the engine's own receipt builder
// (`nika-types` `SelectionEvidence::to_json`, engine 0.124.2): no engine wrote
// these lines. The engine writes each row as ONE compact JSON text inside a
// string field of the task's terminal frame.
const REQUIREMENT = {
  via: 'codex',
  protocol: 'acp',
  fallback: 'none',
  service_tier: 'fast',
  effort: 'low',
};

const SELECTION = {
  schema: 'nika/access-selection@1',
  protocol: 'acp',
  model: {
    requested: 'openai/gpt-6-luna',
    option: 'model',
    transmitted: 'gpt-6-luna',
    configured: 'gpt-6-luna',
    configured_source: 'confirmed_selection',
  },
  effort: {
    requested: 'low',
    option: 'reasoning_effort',
    transmitted: 'low',
    configured: 'low',
    configured_source: 'confirmed_selection',
  },
  service_tier: {
    requested: 'fast',
    option: 'fast-mode',
    offered: ['off', 'on'],
    transmitted: 'on',
    configured: 'on',
    configured_source: 'confirmed_selection',
    turn: { value: null, evidence: 'unknown' },
    effective: { value: null, evidence: 'unknown' },
  },
  responder: { model: null, evidence: 'unknown' },
};

function frame(rows: Record<string, unknown>): NikaEvent {
  return {
    kind: 'task_completed',
    fields: [
      { key: 'task', value: 'render_image' },
      { key: 'access', value: 'harness' },
      ...Object.entries(rows).map(([key, value]) => ({ key, value })),
    ],
  } as unknown as NikaEvent;
}

const text = (value: unknown): string => JSON.stringify(value);

describe('access evidence on a task frame', () => {
  it('reads the declared requirement and the selection receipt, facts kept apart', () => {
    const event = frame({
      access_requirement: text(REQUIREMENT),
      access_selection: text(SELECTION),
    });

    expect(readNikaAccessRequirement(event)).toEqual(REQUIREMENT);
    const selection = readNikaAccessSelection(event)!;
    expect(selection).toEqual(SELECTION);
    // The file's word and the route's own value are two facts.
    expect(selection.service_tier?.requested).toBe('fast');
    expect(selection.service_tier?.transmitted).toBe('on');
    expect(selection.service_tier?.offered).toEqual(['off', 'on']);
    // A configured value is not a served one: both stay unknown.
    expect(selection.service_tier?.turn).toEqual({ value: null, evidence: 'unknown' });
    expect(selection.service_tier?.effective).toEqual({ value: null, evidence: 'unknown' });
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it('reads the same rows through the stable event that wraps the frame', () => {
    const raw = frame({ access_selection: text(SELECTION) });
    const wrapped: NikaRunEvent = { kind: 'task.completed', transport: 'native-process', raw };

    expect(readNikaAccessSelection(wrapped)).toEqual(SELECTION);
  });

  it('keeps a file that declares no tier free of a tier block', () => {
    const { service_tier: _tier, ...plain } = SELECTION;
    const { service_tier: _word, ...route } = REQUIREMENT;
    const event = frame({ access_requirement: text(route), access_selection: text(plain) });

    expect(readNikaAccessSelection(event)).toEqual(plain);
    expect(readNikaAccessSelection(event)?.service_tier).toBeUndefined();
    // Absent is not `standard`: the reader invents nothing.
    expect(readNikaAccessRequirement(event)).toEqual(route);
    expect('service_tier' in readNikaAccessRequirement(event)!).toBe(false);
  });

  it('answers undefined where the frame carries no row', () => {
    // A task that called no model, or any frame from `nika serve`, which
    // keeps these rows in the sealed journal and projects none.
    expect(readNikaAccessSelection(frame({}))).toBeUndefined();
    expect(readNikaAccessRequirement(frame({}))).toBeUndefined();
    const served = { kind: 'execution.settled', status: 'succeeded' } as unknown as NikaEvent;
    expect(readNikaAccessSelection(served)).toBeUndefined();
    expect(
      readNikaAccessSelection({ kind: 'run.settled', transport: 'http', raw: served }),
    ).toBeUndefined();
  });

  it('refuses a receipt that is present and malformed', () => {
    const broken: [string, unknown][] = [
      ['not a JSON text', SELECTION],
      ['not valid JSON', '{"schema":'],
      ['not an object', '[]'],
      ['schema was not a string', text({ ...SELECTION, schema: 1 })],
      ['protocol was not a string or null', text({ ...SELECTION, protocol: 7 })],
      ['model was not an object', text({ ...SELECTION, model: 'gpt-6-luna' })],
      [
        'effort.configured was not a string or null',
        text({ ...SELECTION, effort: { ...SELECTION.effort, configured: undefined } }),
      ],
      ['responder was not an object', text({ ...SELECTION, responder: null })],
      ['service_tier was not an object', text({ ...SELECTION, service_tier: 'fast' })],
      [
        'service_tier.offered was not a list of strings or null',
        text({ ...SELECTION, service_tier: { ...SELECTION.service_tier, offered: [true] } }),
      ],
      [
        'service_tier.turn names a value and an evidence that contradict each other',
        text({
          ...SELECTION,
          service_tier: { ...SELECTION.service_tier, turn: { value: 'fast', evidence: 'unknown' } },
        }),
      ],
      [
        'service_tier.effective names a value and an evidence that contradict each other',
        text({
          ...SELECTION,
          service_tier: {
            ...SELECTION.service_tier,
            effective: { value: null, evidence: 'provider_response' },
          },
        }),
      ],
      ['changed_mid_turn was not a list of strings', text({ ...SELECTION, changed_mid_turn: 'x' })],
    ];
    for (const [detail, value] of broken) {
      const event = frame({ access_selection: value });
      expect(() => readNikaAccessSelection(event), detail).toThrowError(NikaProtocolError);
      expect(() => readNikaAccessSelection(event), detail).toThrowError(
        `Engine access_selection row was malformed: ${detail}`,
      );
    }
    expect(() => readNikaAccessRequirement(frame({ access_requirement: text({ via: 3 }) })))
      .toThrowError('Engine access_requirement row was malformed: via was not a string');
  });

  it('accepts a witnessed turn or effective tier with its source', () => {
    const witnessed = {
      ...SELECTION,
      service_tier: {
        ...SELECTION.service_tier,
        turn: { value: 'fast', evidence: 'adapter_witness' },
      },
    };

    expect(readNikaAccessSelection(frame({ access_selection: text(witnessed) }))?.service_tier?.turn)
      .toEqual({ value: 'fast', evidence: 'adapter_witness' });
  });

  it('returns a later receipt generation as read', () => {
    const later = { schema: 'nika/access-selection@2', route: { tier: 'fast' } };

    expect(readNikaAccessSelection(frame({ access_selection: text(later) }))).toEqual(later);
  });

  it('carries what the route moved during the turn', () => {
    const moved = { ...SELECTION, changed_mid_turn: ['service_tier=off'] };

    expect(readNikaAccessSelection(frame({ access_selection: text(moved) }))?.changed_mid_turn)
      .toEqual(['service_tier=off']);
  });
});
