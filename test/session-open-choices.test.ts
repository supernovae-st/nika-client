import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NikaProtocolError } from '../src/index.js';
import type { NikaSessionAskedQuestion, NikaSessionResult, NikaSessionWork } from '../src/index.js';
import { sessionFrame } from '../src/lib/session-host.js';

// NIK-16 change 5 (the ADR-153 amendment whose wire the writer fixed on 2026-10-10; the engine side is
// pending): a proposal may leave choices open, each shown with its default. The machine door's work
// carries them as `open_choices`, questions of the `questions` shape whose one recommended option is
// the default the candidate already holds. A consenting line binds the shown defaults as `offered`
// bindings cited to it; a line picking another option binds that pick, and the proposal waits for the
// author's revision. The frames are written here to that shape by hand: no engine writes them yet.

const CONTRACT = 'nika/session-host@1';
const SESSION = `ses_${'0c'.repeat(16)}`;
const SECRET = 'sk-planted-secret-value-0123456789';
const HN = 'https://news.ycombinator.com/';
const TECHCRUNCH = 'https://techcrunch.com/';
const DIGEST = './news/digest.md';
const clone = <T>(value: T): T => structuredClone(value);

type Option = [key: string, label: string, recommended: boolean, values: Record<string, string>[]];
function openChoice(id: string, key: string, role: string, question: string, options: Option[]):
  NikaSessionAskedQuestion {
  return { id, key, question, role, state: 'open', free_text: false, multi_select: false,
    options: options.map(([option, label, recommended, values]) => ({ key: option, label, recommended, values })) };
}
const SOURCE = openChoice('c'.repeat(64), 'source', 'read_source', 'Which site do the news come from?', [
  ['hn', 'Hacker News', true, [{ role: 'read_source', value: HN, name: 'Hacker News' }]],
  ['techcrunch', 'TechCrunch', false, [{ role: 'read_source', value: TECHCRUNCH, name: 'TechCrunch' }]]]);
const OUTPUT = openChoice('d'.repeat(64), 'output', 'output_path', 'Where is the digest written?', [
  ['news', DIGEST, true, [{ role: 'output_path', value: DIGEST }]],
  ['root', './digest.md', false, [{ role: 'output_path', value: './digest.md' }]]]);
// The candidate carries every default as literal bytes, as the Session checks before it shows them.
const CANDIDATE = { files: [{ path: 'news.nika', bytes: 'e'.repeat(64),
  content: `nika: news\n# reads ${HN}\n# writes ${DIGEST}\n` }] };

function work(extra: Record<string, unknown>): Record<string, any> {
  return { contract: 'nika/session-work@0', root: '/srv/project', request: { goal: null, decisions: [], unresolved: [] },
    authoring: null, waiting: { kind: 'free' }, candidate: null, saved: null, requested: null, run: null,
    rail: { draft: 'pending', saved: 'pending', checked: 'pending', active: 'pending', run: 'pending' }, ...extra };
}
const result = (seq: number, outcomes: unknown[], extra: Record<string, unknown>) => ({ contract: CONTRACT,
  session: SESSION, frame: 'result', event: seq, command: `c-${seq}`, op: 'submit', replayed: false, outcomes,
  snapshot: { snapshot: `snp_${String(seq).padStart(32, '0')}`, seq, busy: null, work: work(extra) } });
const decoded = (frame: Record<string, unknown>) => sessionFrame(frame, 'http') as unknown as NikaSessionResult;
const proposed = (proposal: string, extra: Record<string, unknown> = {}) => result(1,
  [{ kind: 'proposal', proposal, text: 'Save news.nika?' }],
  { waiting: { kind: 'consent', proposal }, candidate: clone(CANDIDATE), open_choices: [clone(SOURCE), clone(OUTPUT)],
    ...extra });

function refusal(value: unknown): NikaProtocolError {
  try {
    sessionFrame(value, 'http');
  } catch (error) {
    expect(error).toBeInstanceOf(NikaProtocolError);
    return error as NikaProtocolError;
  }
  throw new Error('expected a protocol refusal');
}

describe('the choices a proposal leaves open (work.open_choices)', () => {
  it('types each open choice as an asked question whose recommended option is its default', () => {
    const frame = proposed('a'.repeat(64));
    const raw = JSON.stringify(frame);
    const typed = decoded(frame);
    expect(typed).toBe(frame);
    expect(JSON.stringify(frame)).toBe(raw);
    const choices: NikaSessionAskedQuestion[] = typed.snapshot.work.open_choices!;
    expect(choices.map((choice) => [choice.key, choice.role, choice.state])).toEqual([
      ['source', 'read_source', 'open'], ['output', 'output_path', 'open']]);
    // Exactly one default each, and the candidate already carries its values.
    const content = (typed.snapshot.work.candidate as { files: { content: string }[] }).files[0]!.content;
    for (const choice of choices) {
      const defaults = choice.options.filter((option) => option.recommended);
      expect(defaults).toHaveLength(1);
      for (const value of defaults[0]!.values) expect(content).toContain(value.value);
    }
    // The questions the person is asked stay apart: a proposal with open choices asks none.
    expect(typed.snapshot.work.questions).toBeUndefined();
  });

  it('reads what a consent and a pick leave, in the members the work already has', () => {
    // A consenting line (`u2`) binds the shown defaults as offered picks cited to it; the choices close.
    const consented = decoded(result(2, [{ kind: 'proposal', proposal: 'a'.repeat(64), text: 'saved' }], {
      candidate: clone(CANDIDATE),
      bindings: [
        { key: 'source', role: 'read_source', value: HN,
          provenance: { kind: 'offered', message: 'u2', excerpt: 'oui', question: 'source', option: 'hn' } },
        { key: 'output', role: 'output_path', value: DIGEST,
          provenance: { kind: 'offered', message: 'u2', excerpt: 'oui', question: 'output', option: 'news' } }],
    })).snapshot.work as NikaSessionWork;
    expect(consented.open_choices).toBeUndefined();
    expect(consented.bindings!.map((binding) => [binding.key, binding.provenance.kind, binding.provenance.message,
      binding.provenance.option])).toEqual([['source', 'offered', 'u2', 'hn'], ['output', 'offered', 'u2', 'news']]);
    // A line picking another option binds that pick; the author's revision is a new proposal.
    const revised = decoded(proposed('b'.repeat(64), { open_choices: [clone(OUTPUT)], bindings: [
      { key: 'source', role: 'read_source', value: TECHCRUNCH,
        provenance: { kind: 'offered', message: 'u2', excerpt: 'plutôt TechCrunch', question: 'source',
          option: 'techcrunch' } }] }));
    expect(revised.snapshot.work.waiting).toEqual({ kind: 'consent', proposal: 'b'.repeat(64) });
    expect(revised.snapshot.work.open_choices!.map((choice) => choice.key)).toEqual(['output']);
  });

  it('carries a member this SDK has not met, and none when a proposal leaves nothing open', () => {
    const later = { ...clone(SOURCE), future_choice_member: { shown: true } };
    const typed = decoded(proposed('a'.repeat(64), { open_choices: [later] }));
    expect(typed.snapshot.work.open_choices![0]).toEqual(later);
    expect(decoded(result(3, [], { candidate: clone(CANDIDATE) })).snapshot.work.open_choices).toBeUndefined();
  });

  const broken: [string, (choices: any[]) => unknown, RegExp][] = [
    ['open choices as an object', () => ({ source: SECRET }), /work\.open_choices is not a list/],
    ['a choice without its identity', (choices) => { delete choices[0].id; return choices; },
      /work\.open_choices\[0\]\.id is absent/],
    ['an option without its recommendation', (choices) => { delete choices[1].options[0].recommended; return choices; },
      /work\.open_choices\[1\]\.options\[0\]\.recommended is absent/],
    ['a value as a number', (choices) => { choices[0].options[1].values[0].value = 7; return choices; },
      /work\.open_choices\[0\]\.options\[1\]\.values\[0\]\.value is not text/],
    ['a free answer flag as text', (choices) => { choices[0].free_text = SECRET; return choices; },
      /work\.open_choices\[0\]\.free_text is not a boolean/],
  ];
  it.each(broken)('refuses %s as a protocol fault naming its path, never its value', (_name, mutate, message) => {
    const frame = proposed('a'.repeat(64));
    frame.snapshot.work.open_choices = mutate(frame.snapshot.work.open_choices);
    const error = refusal(JSON.parse(JSON.stringify(frame)));
    expect(error.message).toMatch(message);
    expect(inspect(error)).not.toContain(SECRET);
  });
});
