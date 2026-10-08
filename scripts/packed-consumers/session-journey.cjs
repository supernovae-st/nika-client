'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { frameRow, landedExactly } = require('./session-scenario.cjs');

// A real intelligence's journey through one Session door, from the PACKED
// package (scripts/run-session-parity-e2e.mjs, journey phase): CREATE from
// words, Save, Run; then a new Session over the same project, EDIT in words,
// Save, Run. A test persona answers only what it was told to: the first
// intelligence screen with the configured line, a one-time cost choice only
// when the run authorized it, an authoring question only from its answer
// table, and a consent only to the proposal a leg reached. Each generation is
// judged by its own evidence and the project world's postconditions, never
// compared byte for byte with another door's or another run's.

// The harness's own observation window, never a product limit: how long it waits for one turn
// and watches one Run before it reports what it last saw (`config.waitMs` sets another).
const WAIT_MS = 1_800_000;
// The persona's own bound on the lines it answers in one leg, never the Session's.
const PERSONA_TURNS = 24;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const OBSERVATION = 'an observation bound of this harness, never a product limit';

/** A harness observation bound reached: what the Session showed then is kept, nothing is claimed. */
class HarnessBound extends Error {
  constructor(record) {
    super(record.why);
    this.name = 'HarnessBound';
    this.record = record;
  }
}

module.exports = async function sessionJourney(sdk, config) {
  const steps = [];
  const open = [];
  try {
    await journey(sdk, config, steps, open);
    return { module_system: config.moduleSystem, door: config.door, steps, error: null };
  } catch (error) {
    return { module_system: config.moduleSystem, door: config.door, steps,
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error), code: error?.code ?? null,
        at: steps.at(-1)?.step ?? null } };
  } finally {
    await Promise.allSettled(open.map((handle) => handle.close({ signal: AbortSignal.timeout(10_000) })));
  }
};

async function journey(sdk, config, steps, open) {
  const waitMs = Number.isSafeInteger(config.waitMs) && config.waitMs > 0 ? config.waitMs : WAIT_MS;
  const signal = () => AbortSignal.timeout(waitMs);
  const client = config.door === 'native'
    ? new sdk.Nika({ bin: config.bin, cwd: config.project })
    : new sdk.Nika({ url: config.url, token: config.token, allowInsecureHttp: true,
      bin: path.join(config.project, 'there-is-no-local-engine') });
  const world = (relative) => path.join(config.project, relative);
  const read = (relative) => (existsSync(world(relative)) ? readFileSync(world(relative)) : null);
  const record = (step, value) => {
    steps.push({ step, ...value });
    return value;
  };
  const persona = { choice: config.choice, acceptCost: config.acceptCost === true, answers: config.answers ?? {} };
  const opening = async () => {
    // With the conversation's own intelligence the engine opens on it and keeps nothing for the
    // operator; without, the persona may answer the first screen (`choice`).
    const started = performance.now();
    const handle = await client.openSession({ signal: signal(),
      ...(config.intelligence ? { intelligence: config.intelligence } : {}) });
    open.push(handle);
    // The open alone (a process spawned, or a Session posted), timed apart from any authoring.
    return { handle, openMs: Math.round(performance.now() - started) };
  };
  const closing = async (handle) => {
    open.splice(open.indexOf(handle), 1);
    return handle.close({ signal: signal() });
  };
  /**
   * One line, waited for within the harness's window. A cut wait never stops the turn: the leg
   * ends on that observation bound, keeping what the Session shows now.
   */
  const send = async (session, snapshot, line, command) => {
    try {
      return await session.submit(snapshot, line, { command, signal: signal() });
    } catch (error) {
      if (error?.name !== 'NikaSessionWaitError') throw error;
      const now = await session.snapshot({ signal: AbortSignal.timeout(60_000) }).catch(() => null);
      const draft = now?.work?.authoring?.draft ?? null;
      throw new HarnessBound({ bound: 'turn_wait', limit_ms: waitMs, command,
        why: `the harness stopped waiting for ${command} after ${waitMs} ms: ${OBSERVATION}`,
        busy: now?.busy ?? null, waiting: now?.work?.waiting ?? null, evidence: now ? evidence(now.work) : null,
        draft, draft_sha256: typeof draft === 'string' ? sha256(Buffer.from(draft, 'utf8')) : null,
        work: now?.work ?? null });
    }
  };

  /** One leg, or the observation bound it ended on (kept as `<leg>_harness_bound`). */
  async function leg(name, session, words) {
    try {
      return await walk(name, session, words);
    } catch (error) {
      if (!(error instanceof HarnessBound)) throw error;
      record(`${name}_harness_bound`, error.record);
      return null;
    }
  }

  /** One leg: words to a proposal, the consent, the requested Run and the report it wrote. */
  async function walk(name, session, words) {
    const started = performance.now();
    const reached = await advance((snapshot, line, command) => send(session, snapshot, line, command),
      session.opened.snapshot, words, persona, (turn) => record(`${name}_turn`, turn));
    // The whole preparation as the person waits for it, every turn between the words and the
    // frame the leg settled on (a proposal, or a held candidate), on a monotonic clock; the
    // engine's `calls.elapsed_ms` sums its authoring calls only, a lower bound of it.
    reached.summary.timing = { submit_to_settled_ms: Math.round(performance.now() - started),
      author_ms: reached.summary.evidence?.calls?.elapsed_ms ?? null };
    if (reached.waiting !== 'consent') {
      // What the Session itself says of how it got here (its details card), beside the raw work.
      reached.summary.details = await Promise.resolve().then(() => session.details({ signal: signal() }))
        .then((frame) => frame.text ?? null, (error) => ({ unavailable: String(error?.message ?? error) }));
    }
    record(`${name}_reached`, reached.summary);
    if (reached.waiting !== 'consent') return null;
    const shown = reached.snapshot;
    const files = shown.work.candidate?.files ?? [];
    // Save is never a Run: the report (absent, or an earlier leg's) must be the same bytes after it.
    const reportSha = () => {
      const bytes = read('out/report.json');
      return bytes === null ? null : sha256(bytes);
    };
    const reportBefore = reportSha();
    const consent = await send(session, shown, 'yes', `${name}-save`);
    const saved = consent.snapshot.work.saved;
    const landed = saved?.workflow === undefined ? null : read(saved.workflow);
    const previewed = files.find((file) => file.path === saved?.workflow);
    const savedSha = landed === null ? null : sha256(landed);
    const ranNothing = reportSha() === reportBefore && !frameRow(consent).outcomes.some((kind) => kind.startsWith('run'));
    // The engine's own check of the exact saved bytes in the project world, as a person runs it: a
    // world's oracle reads this real verdict, never a status assumed for it.
    const check = config.checkBin && saved?.workflow ? checked(config.checkBin, config.project, saved.workflow) : null;
    record(`${name}_save`, { ...journeyRow(consent), saved_bytes_are_previewed: landedExactly(previewed, landed),
      saved_sha256: savedSha, saved_base64: landed === null ? null : landed.toString('base64'),
      save_ran_nothing: ranNothing, check });
    const runStartedAt = Date.now();
    let run = await send(session, consent.snapshot, 'run it', `${name}-run`);
    record(`${name}_run`, journeyRow(run));
    // What the Run asks before it starts: the resident's cost review, which the persona accepts
    // (the Run is the authorized step), and a declared input's value, answered only by a persona
    // rule over its name and asking words, never guessed. Anything else is left to the person.
    for (let asked = 0; asked < 8; asked += 1) {
      const waiting = run.snapshot.work.waiting;
      if (waiting.kind === 'run_review') {
        run = await send(session, run.snapshot, 'yes', `${name}-run-review-${asked}`);
        record(`${name}_run_review`, journeyRow(run));
        continue;
      }
      const answer = waiting.kind === 'input' ? answerFor(persona.answers, { key: waiting.name }, run, 'input') : null;
      if (answer === null) break;
      run = await send(session, run.snapshot, answer.line, `${name}-run-input-${asked}`);
      record(`${name}_run_input`, { ...journeyRow(run), input: waiting.name ?? null, said: answer.why });
    }
    let after = run.snapshot;
    const said = (kinds) => steps.some((entry) => entry.step.startsWith(`${name}_run`)
      && (entry.outcomes ?? []).some((kind) => kinds.includes(kind)));
    // A Session waiting on the person (an input no rule answers, a gate) starts and ends no Run
    // until someone answers: polling stops, and the leg says what it waits on.
    const waitsOnPerson = () => after.busy === null && after.work.waiting.kind !== 'free';
    const unsettled = () => !waitsOnPerson() && (after.busy !== null
      || (after.work.run === null && !said(['run_not_started', 'run_unobserved'])));
    // Watched within the harness's window: past it the leg says what it last saw, a bound of the
    // observation, never a verdict on the Run.
    const until = Date.now() + waitMs;
    while (unsettled() && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      after = await session.snapshot({ signal: signal() });
    }
    const window = { started_at: runStartedAt, observed_at: Date.now() };
    const report = read('out/report.json');
    let parsed = null;
    try {
      parsed = report === null ? null : JSON.parse(report.toString('utf8'));
    } catch {
      parsed = { unparsable: true };
    }
    const { kind, name: input = null, key = null } = after.work.waiting;
    record(`${name}_run_observed`, { deadline: unsettled(), observation_ms: waitMs, busy: after.busy !== null,
      run: after.work.run,
      waiting: { kind, name: input, key }, saved: saved?.workflow ?? null, saved_sha256: savedSha, report: parsed,
      report_sha256: report === null ? null : sha256(report), window, snapshot: capture(name) });
    return { shown, savedSha };
  }

  /**
   * The project world's paths a world judges, copied as this leg's Run left them, before the next
   * leg changes them; outside the project, so the copy is never part of the world.
   */
  function capture(name) {
    if (!config.snapshots || !Array.isArray(config.capture)) return null;
    const dir = path.join(config.snapshots, name);
    mkdirSync(dir, { recursive: true });
    const captured = config.capture.filter((relative) => existsSync(world(relative)));
    for (const relative of captured) cpSync(world(relative), path.join(dir, relative), { recursive: true });
    return { dir, captured };
  }

  // The operator's kept choice, by digest only, before anything opens: a journey opened with the
  // conversation's own intelligence must leave it exactly as it found it.
  record('operator_choice', { when: 'before', ...keptChoice() });
  const opened = config.intelligence ? 'intelligence' : 'first_screen';

  // CREATE: a new Session, words alone.
  const { handle: first, openMs: firstOpenMs } = await opening();
  record('create_open', { ...frameRow(first.opened), intelligence: first.opened.snapshot.work.intelligence ?? null,
    opened_with: opened, open_ms: firstOpenMs });
  const created = await leg('create', first, config.create);
  await closing(first);
  if (created !== null) {
    // EDIT: a new Session over the same project world; the change in words.
    const { handle: second, openMs: secondOpenMs } = await opening();
    record('edit_open', { ...frameRow(second.opened), intelligence: second.opened.snapshot.work.intelligence ?? null,
      created_sha256: created.savedSha, opened_with: opened, open_ms: secondOpenMs });
    await leg('edit', second, config.edit);
    await closing(second);
  }
  record('operator_choice', { when: 'after', ...keptChoice() });
}

/**
 * Whether the operator's kept choice (`~/.nika/session-intelligence.json` under the HOME this
 * journey runs with) exists, and its sha256: never its content.
 */
function keptChoice() {
  const file = path.join(process.env.HOME ?? '', '.nika', 'session-intelligence.json');
  return existsSync(file) ? { present: true, sha256: sha256(readFileSync(file)) } : { present: false, sha256: null };
}

/**
 * Send `line`, then answer only what the persona was told to, until the Session waits on a
 * consent or settles otherwise. Every turn is reported; nothing is guessed for the person.
 */
async function advance(send, snapshot, line, persona, report) {
  let shown = snapshot;
  let next = line;
  let said = 'words';
  for (let turn = 0; turn < PERSONA_TURNS; turn += 1) {
    const sent = performance.now();
    const result = await send(shown, next, `${said}-${turn}`);
    // This line alone, sent to settled, on a monotonic clock.
    const ms = Math.round(performance.now() - sent);
    shown = result.snapshot;
    const waiting = shown.work.waiting;
    report({ turn, said, ms, ...journeyRow(result), evidence: evidence(shown.work) });
    if (waiting.kind === 'intelligence_choice' && persona.choice) {
      [next, said] = [persona.choice, 'intelligence_choice'];
    } else if (waiting.kind === 'cost_choice' && persona.acceptCost) {
      [next, said] = ['yes', 'cost_choice'];
    } else if (waiting.kind === 'question' && answerFor(persona.answers, waiting, result) !== null) {
      const answer = answerFor(persona.answers, waiting, result);
      [next, said] = [answer.line, `answer ${waiting.key} (${answer.why})`];
    } else {
      // Where no proposal waits, the compiler's own draft (shown, never offered) is kept with its
      // digest, so a candidate a judge held stays inspectable after the scratch is gone.
      // The raw work rides with it, every member as the engine wrote it, unknown ones included.
      const draft = waiting.kind === 'consent' ? null : shown.work.authoring?.draft ?? null;
      return { waiting: waiting.kind, snapshot: shown,
        summary: { waiting: waiting.kind, key: waiting.key ?? null, ...outcomesOf(result),
          turns: turn + 1, evidence: evidence(shown.work), draft,
          draft_sha256: typeof draft === 'string' ? sha256(Buffer.from(draft, 'utf8')) : null,
          ...(waiting.kind === 'consent' ? {} : { work: shown.work }) } };
    }
  }
  // The persona's own bound, never the Session's: what the Session shows now is kept.
  const draft = shown.work.authoring?.draft ?? null;
  return { waiting: 'harness_bound', snapshot: shown,
    summary: { waiting: shown.work.waiting.kind, key: shown.work.waiting.key ?? null, turns: PERSONA_TURNS,
      harness: { bound: 'persona_turns', limit: PERSONA_TURNS,
        why: `the persona answered ${PERSONA_TURNS} lines and stopped: ${OBSERVATION}` },
      evidence: evidence(shown.work), draft,
      draft_sha256: typeof draft === 'string' ? sha256(Buffer.from(draft, 'utf8')) : null, work: shown.work } };
}

/**
 * The persona's answer to one authoring question (or, with `asking: 'input'`, to a Run's declared
 * input, keyed by its name): an exact key from an answer table (`{ key: line }`), or the first
 * rule (`[{ key, text, line, why }]`, `key` and `text` regular expressions over the key and the
 * asking words) that matches. `null` when nothing the persona was told answers it.
 */
function answerFor(answers, waiting, result, asking = 'question') {
  if (Array.isArray(answers)) {
    const asked = (result.outcomes ?? []).find((outcome) => outcome.kind === asking)?.text ?? '';
    const rule = answers.find((each) => (each.key !== undefined && new RegExp(each.key, 'i').test(waiting.key ?? ''))
      || (each.text !== undefined && new RegExp(each.text, 'i').test(asked)));
    return rule === undefined ? null : { line: rule.line, why: rule.why ?? 'a persona rule' };
  }
  const line = answers?.[waiting.key];
  return typeof line === 'string' ? { line, why: 'the answer table' } : null;
}

/** The engine's own check of one saved workflow, run where it lives; its words are kept as said. */
function checked(bin, cwd, workflow) {
  const result = spawnSync(bin, ['check', workflow], { cwd, env: process.env, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024 });
  return { rc: result.status, signal: result.signal, error: result.error?.code ?? null,
    text: `${result.stdout ?? ''}`.slice(0, 65_536) };
}

/**
 * One result frame as the journey keeps it: the scenario's row, plus the Session's own outcomes
 * verbatim under `raw` (a refusal's reason, a fact's text), so a leg that stops says why in the
 * engine's words, never only by kind.
 */
function journeyRow(frame) {
  return { ...frameRow(frame), ...outcomesOf(frame) };
}

/** A frame's outcome kinds, and the outcomes themselves as the engine wrote them. */
function outcomesOf(frame) {
  return { outcomes: frameRow(frame).outcomes, raw: { outcomes: frame.outcomes ?? [] } };
}

/** What a snapshot says of who prepared the candidate and of the candidate itself. */
function evidence(work) {
  const calls = work.authoring?.calls ?? null;
  return {
    intelligence: work.intelligence ?? null,
    // Each call as the receipt recorded it, kept apart from the totals and never summed into them;
    // `null` when the engine projects no calls.
    calls: calls === null ? null : { requested_model: calls.requested_model, calls: calls.calls,
      input_tokens: calls.input_tokens ?? null, output_tokens: calls.output_tokens ?? null,
      elapsed_ms: calls.elapsed_ms, backend: calls.backend ?? null, per_call: calls.per_call ?? null },
    authoring_status: work.authoring?.status ?? null,
    questions: work.authoring?.questions ?? null,
    diagnostics: (work.authoring?.diagnostics ?? []).map((note) => ({ kind: note.kind ?? null,
      target: note.target ?? null, message: note.message ?? null })),
    files: (work.candidate?.files ?? []).map((file) => ({ path: file.path, landing: file.landing ?? null,
      content_sha256: typeof file.content === 'string' ? sha256(Buffer.from(file.content, 'utf8')) : null })),
    revision: work.candidate?.revision ?? null,
  };
}

/**
 * The doors a journey walks: a nonempty list of `native` and `http`, each named once; unset means
 * both. Anything else is a configuration refusal, so an empty selection can never report a
 * journey that walked no door.
 */
function journeyDoors(value) {
  if (value === undefined) return ['native', 'http'];
  const doors = String(value).split(',').map((door) => door.trim());
  if (doors.some((door) => door !== 'native' && door !== 'http') || new Set(doors).size !== doors.length) {
    throw new Error('NIKA_SESSION_JOURNEY_DOORS names native and/or http, comma-separated, each once');
  }
  return doors;
}

/**
 * The seat a first-screen answer names, projected as the Session projects its selection
 * (`nika-session` `intelligence.rs` `choose`, `choose_app`, `split_seat`; `work.rs` `Selected`):
 * `1 <app>[/<model>]` reaches the app natively unless `acp:` asks for ACP, `2 <provider>[/<model>]`,
 * `3 <local>`, `4`. A `<via>/<name>` names the provider (or app) AND the model, the model kept
 * whole; an empty side names no model. Only a harness has a transport.
 */
function requestedSeat(choice) {
  const [pick, name] = String(choice ?? '').trim().split(/\s+/);
  const kind = { 1: 'harness', 2: 'api', 3: 'local', 4: 'none' }[pick] ?? null;
  const acp = kind === 'harness' && name !== undefined && name.startsWith('acp:');
  const transport = kind === 'harness' ? (acp ? 'acp' : 'native') : null;
  if (!name) return { kind, via: null, model: null, transport };
  const bare = acp ? name.slice('acp:'.length) : name;
  const slash = bare.indexOf('/');
  const named = slash > 0 && slash < bare.length - 1;
  return { kind, via: named ? bare.slice(0, slash) : bare, model: named ? bare : null, transport };
}

/**
 * Every frame of one leg's Session that shows a selection, in order: the opened frame, each turn's
 * snapshot, the frame the leg reached and the one the harness saw when it stopped waiting. A turn
 * index `fromTurn` drops the opened frame and the turns before it. A selection must be observed
 * at the frame the leg reached, and at the opened frame when `openRequired`.
 */
function legSelections(report, name, fromTurn, openRequired) {
  const step = (at) => report.steps.find((entry) => entry.step === at);
  const selection = (evidence) => evidence?.intelligence?.selected ?? null;
  const frames = [];
  if (fromTurn === null) {
    frames.push({ at: `${name}_open`, selected: step(`${name}_open`)?.intelligence?.selected ?? null,
      required: openRequired });
  }
  report.steps.filter((entry) => entry.step === `${name}_turn`).forEach((entry, index) => {
    if (fromTurn === null || index >= fromTurn) {
      frames.push({ at: `${name}_turn ${entry.turn ?? index}`, selected: selection(entry.evidence), required: false });
    }
  });
  frames.push({ at: `${name}_reached`, selected: selection(step(`${name}_reached`)?.evidence), required: true });
  const bound = step(`${name}_harness_bound`);
  if (bound !== undefined) {
    frames.push({ at: `${name}_harness_bound`, selected: selection(bound.evidence), required: false });
  }
  return frames;
}

/** How the harness seat ends one authoring call in its receipt (`HarnessAuthoring::infer`). */
const CALL_ENDS = new Set(['returned', 'failed', 'cancelled', 'timed_out']);

/**
 * The frames of one leg that may carry an authoring receipt, in order: each turn (each may hold
 * its own compile's calls), the frame the leg reached (required: its configured effort must be
 * named) and the one the harness saw when it stopped waiting.
 */
function effortFrames(report, name) {
  const step = (at) => report.steps.find((entry) => entry.step === at);
  const turns = report.steps.filter((entry) => entry.step === `${name}_turn`)
    .map((entry, index) => ({ at: `${name}_turn ${entry.turn ?? index}`, evidence: entry.evidence, required: false }));
  const bound = step(`${name}_harness_bound`);
  return [...turns, { at: `${name}_reached`, evidence: step(`${name}_reached`)?.evidence, required: true },
    ...(bound ? [{ at: `${name}_harness_bound`, evidence: bound.evidence, required: false }] : [])];
}

/**
 * Whether every authoring call a leg's frames receipt carried `effort`. A frame's receipt is the
 * harness seat's own sequence for one compile: each call's `invoking` record, then its end
 * (`returned`, `failed`, `cancelled`, `timed_out`), paired by position, never by an invented id.
 * Every call must have asked the effort (`requested_effort`), every returned call must have had
 * it taken (`transmitted_effort`) and read back (`configured_effort`), and the Session's
 * configured `intelligence.effort` must name it where it is named (always at the reached frame).
 * Another value anywhere fails. An incomplete receipt proves nothing: a frame counting calls its
 * receipt does not hold, a call with no end (or another invocation before it), an end with no
 * invocation before it; nor does a receipt naming no effort, or no returned call. A compile's
 * receipt seen on several frames is read once.
 */
function carriedEffort(frames, effort) {
  const other = [];
  const unnamed = [];
  const incomplete = [];
  const seen = new Set();
  let returned = 0;
  const name = (at, value) => {
    if (typeof value !== 'string') unnamed.push(at);
    else if (value !== effort) other.push({ at, value });
  };
  for (const { at, evidence, required } of frames) {
    const configured = evidence?.intelligence?.effort;
    if (required || typeof configured === 'string') name(`${at} intelligence.effort`, configured);
    const observed = evidence?.calls?.backend?.observed;
    const records = Array.isArray(observed) ? observed : [];
    // An ACP harness counts its invocations: each counted call must have its receipt.
    const counted = typeof evidence?.calls?.calls === 'number' ? evidence.calls.calls : 0;
    const invocations = records.filter((record) => record?.status === 'invoking').length;
    if (counted !== invocations) {
      incomplete.push(`${at} counts ${counted} authoring call(s) but its receipt holds ${invocations} invocation(s)`);
    }
    if (records.length === 0 || seen.has(JSON.stringify(records))) continue;
    seen.add(JSON.stringify(records));
    let call = -1;
    let open = false;
    for (const record of records) {
      const status = typeof record?.status === 'string' ? record.status : 'unnamed';
      if (status === 'invoking') {
        if (open) incomplete.push(`${at} call ${call} has no end before the next invocation`);
        [call, open] = [call + 1, true];
        name(`${at} call ${call} requested_effort`, record.requested_effort);
      } else if (!CALL_ENDS.has(status)) {
        // Only the documented ends close a call: any other record is no end of it.
        incomplete.push(`${at} ${status} record is neither an invocation nor a call end`);
      } else if (!open) {
        incomplete.push(`${at} ${status} record with no invocation before it`);
      } else {
        open = false;
        if (record.status !== 'returned') continue;
        returned += 1;
        name(`${at} call ${call} transmitted_effort`, record.transmitted_effort);
        name(`${at} call ${call} configured_effort`, record.configured_effort);
      }
    }
    if (open) incomplete.push(`${at} call ${call} has no end`);
  }
  if (other.length > 0) return { verdict: 'failed', observed: { requested: effort, other } };
  if (incomplete.length > 0) {
    return { verdict: 'not_exercised', why: `the receipts are incomplete: ${incomplete.join('; ')}`,
      observed: { requested: effort } };
  }
  if (returned === 0) {
    return { verdict: 'not_exercised', why: 'no authoring call returned on this leg', observed: { requested: effort } };
  }
  if (unnamed.length > 0) {
    return { verdict: 'not_exercised', why: `the receipts name no effort at ${unnamed.join(', ')}`,
      observed: { requested: effort } };
  }
  return { verdict: 'passed', observed: { requested: effort, calls: returned } };
}

/**
 * How a leg's authoring calls ended, each compile's receipt read once: the harness seat's own
 * records (`invoking`, then `returned`, `failed`, `cancelled` or `timed_out`), else the engine's
 * per-call rows (a `failure_kind` is a failed call, `timeout` a timed-out one; a `stop_reason` an
 * answer). `known` is false when no receipt says how any call ended.
 */
function callEnds(frames) {
  const ends = { invoked: 0, returned: 0, failed: 0, cancelled: 0, timed_out: 0, known: false };
  const seen = new Set();
  for (const { evidence } of frames) {
    const calls = evidence?.calls;
    const observed = Array.isArray(calls?.backend?.observed) ? calls.backend.observed : [];
    const rows = Array.isArray(calls?.per_call) ? calls.per_call : [];
    const receipt = JSON.stringify({ observed, rows });
    if ((observed.length === 0 && rows.length === 0) || seen.has(receipt)) continue;
    seen.add(receipt);
    ends.known = true;
    if (observed.length > 0) {
      for (const record of observed) {
        if (record?.status === 'invoking') ends.invoked += 1;
        else if (CALL_ENDS.has(record?.status)) ends[record.status] += 1;
      }
      continue;
    }
    for (const row of rows) {
      ends.invoked += 1;
      if (row?.failure_kind === 'timeout') ends.timed_out += 1;
      else if (typeof row?.failure_kind === 'string') ends.failed += 1;
      else if (typeof row?.stop_reason === 'string') ends.returned += 1;
    }
  }
  return ends;
}

/**
 * The component reuse a leg's proposal witnesses, read from the revision the Session states for
 * its bytes: each component with the engine's witness on those bytes (`expanded`, `revised`,
 * `absent`, `unwitnessed`). Structural reuse (`reused`) is a component expanded in the very bytes
 * the consent saved, never one retrieved or merely similar; `present_in_run` keeps the whole byte
 * chain: those of them in the bytes a succeeded Run ran (`ran_exact`). Neither proves that each of
 * a component's nodes executed (a branch or a skip may leave one unrun): with no task or trace
 * witness read here, that stays unknown. A proposal whose Session states no revision witnesses
 * nothing: not observable, never "none".
 */
function reuseOf(report, name) {
  const step = (at) => report.steps.find((entry) => entry.step === at);
  const revision = step(`${name}_reached`)?.evidence?.revision ?? null;
  if (revision === null) {
    return { observable: false, why: 'the Session states no document revision for this proposal', components: [],
      reused: [], present_in_run: [] };
  }
  const bound = typeof revision.candidate_sha256 === 'string' ? revision.candidate_sha256 : null;
  const saved = step(`${name}_save`)?.saved_sha256;
  const run = step(`${name}_run_observed`)?.run ?? null;
  const savedExact = typeof saved === 'string' && bound !== null ? saved === bound : null;
  const ranExact = typeof run?.workflow_sha256 === 'string' && bound !== null ? run.workflow_sha256 === bound : null;
  const components = (Array.isArray(revision.components) ? revision.components : []).map((use) => ({
    id: use?.id ?? null, version: use?.version ?? null, release: use?.release ?? null,
    file_sha256: use?.file_sha256 ?? null, bindings: use?.bindings ?? [], witness: use?.witness ?? null }));
  const reused = savedExact === true ? components.filter((use) => use.witness === 'expanded').map((use) => use.id)
    : [];
  return { observable: true, candidate_sha256: bound, saved_exact: savedExact, ran_exact: ranExact, components,
    reused, present_in_run: ranExact === true && run?.end?.end === 'succeeded' ? reused : [] };
}

/**
 * One leg as a requalification table counts it, from its own checks and receipts, never
 * relabelled: `not_attempted` (its words were never sent: an earlier leg stopped first; it counts
 * in no denominator), `passed` (every check of the leg passed), `failed` (a check of the leg
 * failed: seat, effort, bytes, Run or postcondition), `provider_failure` (no proposal, and every
 * authoring call invoked ended without an answer), `semantic_hold` (no proposal, the Session free,
 * though an authoring call answered: the verifier held it) or `not_exercised` (anything else left
 * unproven, with the first reason; a leg whose requested seat went unproven is never attributed a
 * hold or a failure of that seat). Its calls' ends, monotonic timing and reuse witnesses ride along.
 */
function legSummary(report, name, legChecks) {
  const step = (at) => report.steps.find((entry) => entry.step === at);
  const reached = step(`${name}_reached`);
  const attempted = reached !== undefined || report.steps.some((entry) => entry.step === `${name}_turn`);
  const calls = callEnds(effortFrames(report, name));
  const timing = { open_ms: step(`${name}_open`)?.open_ms ?? null,
    submit_to_settled_ms: reached?.timing?.submit_to_settled_ms ?? null, author_ms: reached?.timing?.author_ms ?? null };
  const rows = reached?.evidence?.calls?.per_call;
  const summary = (outcome, why) => ({ attempted, outcome, why, calls, timing,
    per_call: Array.isArray(rows) ? rows.map((row) => ({ call: row?.call ?? null, elapsed_ms: row?.elapsed_ms ?? null,
      stop_reason: row?.stop_reason ?? null, failure_kind: row?.failure_kind ?? null })) : null,
    reuse: reuseOf(report, name) });
  if (!attempted) return summary('not_attempted', 'an earlier leg stopped first');
  const failed = legChecks.find((entry) => entry.verdict === 'failed');
  if (failed !== undefined) return summary('failed', failed.name);
  const unproven = legChecks.find((entry) => entry.verdict === 'not_exercised');
  if (unproven === undefined && legChecks.length > 0) return summary('passed', null);
  const unseated = legChecks.find((entry) => entry.verdict === 'not_exercised'
    && entry.name.includes('the requested intelligence'));
  if (unseated !== undefined) return summary('not_exercised', unseated.why);
  // The leg's own state, as the Session said it, is why it reached no proposal.
  const own = legChecks.find((entry) => entry.name === `the ${name.toUpperCase()} leg reached a proposal`);
  if (reached !== undefined && reached.waiting !== 'consent' && calls.known) {
    const answered = calls.returned;
    const unanswered = calls.failed + calls.cancelled + calls.timed_out;
    if (calls.invoked > 0 && answered === 0 && unanswered === calls.invoked) {
      return summary('provider_failure', own?.why ?? null);
    }
    if (answered > 0 && reached.waiting === 'free') return summary('semantic_hold', own?.why ?? null);
  }
  return summary('not_exercised', unproven?.why ?? 'the leg judged nothing');
}

/**
 * A report's CREATE and EDIT denominators over its exercised doors: each leg counted only where
 * its words were sent, so an EDIT behind a stopped CREATE counts in no EDIT denominator; a full
 * route is a door whose CREATE and EDIT both passed.
 */
function journeyDenominators(doors) {
  const exercised = doors.filter((door) => door?.exercised === true && door.legs);
  const count = (name) => {
    const legs = exercised.map((door) => door.legs[name]).filter((leg) => leg?.attempted === true);
    const by = (outcome) => legs.filter((leg) => leg.outcome === outcome).length;
    return { attempted: legs.length, passed: by('passed'), semantic_hold: by('semantic_hold'),
      provider_failure: by('provider_failure'), failed: by('failed'), not_exercised: by('not_exercised') };
  };
  return { create: count('create'), edit: count('edit'),
    full_routes: { passed: exercised.filter((door) => door.legs.create?.outcome === 'passed'
      && door.legs.edit?.outcome === 'passed').length, of: exercised.length },
    law: 'an EDIT behind a stopped CREATE was never attempted and counts in no EDIT denominator' };
}

/** Whether the Session's own selection is the seat that was requested. */
function isRequestedSeat(selected, requested) {
  return selected !== null && selected !== undefined && selected.kind === requested.kind
    && (requested.via === null || selected.via === requested.via)
    && (requested.model === null || selected.model === requested.model)
    && (requested.transport === null || selected.transport === requested.transport);
}

/**
 * What one door's journey must show, per leg. A leg that never reached a proposal, a proposal
 * no model authored, or a Run the Session did not start or observe is `not_exercised` with the
 * engine's own words; a wrong digest, base, bytes or report is `failed`. When `requested`
 * names the seat (the opener's words, or the first-screen answer), each leg counts for it only
 * if its Session's own selection is that seat at the frame the leg reached (with an opener, at
 * the opened frame too, held for the conversation alone) and in every turn from the open (or
 * from the journey's answer) that shows a selection: a required frame showing none proves
 * nothing, a turn showing none is not read, and a choice kept from elsewhere is never
 * relabelled as the one requested. When `effort` names the reasoning effort asked of a seat
 * reached over ACP, each leg also requires every authoring call to have carried it.
 */
function judgeJourney(report, expected, requested = null, worldChecks = null, effort = null) {
  const legsOf = (byLeg) => ({ create: legSummary(report, 'create', byLeg.create),
    edit: legSummary(report, 'edit', byLeg.edit) });
  if (report.error !== null) {
    const completed = { name: 'the journey completed', verdict: 'failed', observed: report.error };
    return { verdict: 'failed', checks: [completed], legs: legsOf({ create: [completed], edit: [completed] }) };
  }
  const step = (name) => report.steps.find((entry) => entry.step === name);
  const checks = [];
  // Each check is also the leg's it judges, for that leg's summary.
  const byLeg = { create: [], edit: [] };
  let leg = null;
  const record = (entry) => {
    checks.push(entry);
    if (leg !== null) byLeg[leg].push(entry);
  };
  const check = (name, passed, observed) => record({ name, verdict: passed ? 'passed' : 'failed', observed });
  const gap = (name, why, observed) => record({ name, verdict: 'not_exercised', why, observed });
  const authored = (evidence) => evidence?.calls !== null && evidence?.calls?.calls >= 1
    && ['provider', 'harness'].includes(evidence?.intelligence?.author?.kind);
  if (requested !== null) {
    const seat = requestedSeat(requested);
    // Opened with the conversation's own intelligence, each leg's Session must show it at its
    // opened and reached frames and in every turn that shows a selection; answered on the first
    // screen, at its reached frame and in every turn from the journey's own answer on.
    const byOpener = step('create_open')?.opened_with === 'intelligence';
    let answeredEarlier = false;
    for (const name of ['create', 'edit']) {
      leg = name;
      const LEG = name.toUpperCase();
      const seatName = `the ${LEG} Session prepared with the requested intelligence`;
      const scopeName = `the ${LEG} Session holds the requested intelligence for this conversation alone`;
      const effortName = `the ${LEG} Session carried the requested effort on every authoring call`;
      // An ACP seat applies a named effort through its advertised option and reads it back.
      const asksEffort = effort !== null && seat.transport === 'acp';
      const answeredAt = report.steps.filter((entry) => entry.step === `${name}_turn`)
        .findIndex((entry) => entry.said === 'intelligence_choice');
      const answered = byOpener || answeredAt >= 0 || answeredEarlier;
      answeredEarlier = answeredEarlier || answeredAt >= 0;
      if (step(`${name}_open`) === undefined) {
        gap(seatName, 'an earlier leg stopped first', null);
        if (byOpener) gap(scopeName, 'an earlier leg stopped first', null);
        if (asksEffort) gap(effortName, 'an earlier leg stopped first', null);
        continue;
      }
      // Before this leg's own first-screen answer the Session had no choice to show.
      const frames = legSelections(report, name, answeredAt >= 0 && !byOpener ? answeredAt : null, byOpener);
      const shown = frames.map(({ at, selected }) => ({ at, selected }));
      const other = shown.filter((frame) => frame.selected !== null && !isRequestedSeat(frame.selected, seat));
      const unseen = frames.filter((frame) => frame.required && frame.selected === null).map((frame) => frame.at);
      if (other.length > 0 && answered) {
        // The opener named it, or the persona gave the first screen this answer, and the Session
        // showed another seat in at least one frame.
        check(seatName, false, { requested: seat, other });
      } else if (other.length > 0) {
        gap(seatName, 'the Session opened on a choice kept before this journey, never asked the first screen',
          { requested: seat, other });
      } else if (unseen.length > 0) {
        // A required frame (reached; opened, with an opener) showing no selection proves no seat:
        // never a pass.
        gap(seatName, `no selection was observed at ${unseen.join(', ')}`, { requested: seat, frames: shown });
      } else {
        check(seatName, true, { requested: seat, frames: shown });
      }
      if (byOpener) {
        // The engine holds the opener's words for this conversation alone: at the opened and
        // reached frames, and in every turn that shows a scope.
        const scopes = frames.map(({ at, selected }) => ({ at, scope: selected?.scope ?? null }));
        const elsewhere = scopes.filter((frame) => typeof frame.scope === 'string' && frame.scope !== 'conversation');
        const unscoped = frames.filter((frame) => frame.required && typeof frame.selected?.scope !== 'string')
          .map((frame) => frame.at);
        if (elsewhere.length > 0) {
          check(scopeName, false, { scopes: elsewhere });
        } else if (unscoped.length > 0) {
          gap(scopeName, `no selection scope was observed at ${unscoped.join(', ')}`, { scopes });
        } else {
          check(scopeName, true, { scopes });
        }
      }
      if (asksEffort) {
        const carried = carriedEffort(effortFrames(report, name), effort);
        if (carried.verdict === 'not_exercised') gap(effortName, carried.why, carried.observed);
        else check(effortName, carried.verdict === 'passed', carried.observed);
      }
    }
    leg = null;
    if (byOpener) {
      // The engine keeps nothing for the operator: the kept choice reads the same at both ends of
      // the journey.
      const [before, after] = ['before', 'after'].map((when) =>
        report.steps.find((entry) => entry.step === 'operator_choice' && entry.when === when));
      const kept = 'the operator\'s kept choice is byte-identical across the journey';
      if (before === undefined || after === undefined) {
        gap(kept, 'the journey did not read it at both ends', { before: before ?? null, after: after ?? null });
      } else {
        check(kept, before.present === after.present && before.sha256 === after.sha256, { before, after });
      }
    }
  }

  // The tickets ids judge the built-in world only; a world module brings its own checks instead.
  for (const [name, ids, base] of [['create', expected?.create ?? [], null], ['edit', expected?.edit ?? [], 'create']]) {
    leg = name;
    const LEG = name.toUpperCase();
    // A world module states its own postconditions; the built-in world's are the tickets report.
    const worldName = `the ${LEG} world postconditions hold`;
    const postconditions = worldChecks ? worldName : `the ${LEG} report holds exactly the expected tickets`;
    const consentName = `the ${LEG} consent saved exactly the proposed bytes`;
    const revisionName = 'the EDIT proposal revises the created bytes into the saved workflow';
    const runChecks = [`the ${LEG} Run of the saved workflow succeeded`, `the ${LEG} Run ran the saved bytes`];
    // A harness observation bound ends a leg without a verdict on what it did not see.
    const bound = step(`${name}_harness_bound`);
    const stopped = bound?.why ?? 'an earlier leg stopped first';
    const withhold = (names, why, observed) => names.forEach((entry) => gap(entry, why, observed));
    const reached = step(`${name}_reached`);
    if (reached === undefined) {
      gap(`the ${LEG} leg reached a proposal`, stopped, bound ?? null);
      continue;
    }
    if (reached.waiting !== 'consent') {
      const waits = `the Session waits on ${reached.waiting}${reached.key ? ` (${reached.key})` : ''}`;
      gap(`the ${LEG} leg reached a proposal`, reached.harness ? `${reached.harness.why}; ${waits}` : waits, reached);
      continue;
    }
    check(`the ${LEG} leg reached a proposal`, true, reached);
    if (authored(reached.evidence)) {
      check(`a model authored the ${name.toUpperCase()} proposal`, true, reached.evidence);
    } else {
      gap(`a model authored the ${name.toUpperCase()} proposal`,
        `the author was ${reached.evidence?.intelligence?.author?.kind ?? 'unknown'} with no call receipt`,
        reached.evidence);
    }
    const save = step(`${name}_save`);
    if (save === undefined) {
      withhold([consentName, ...(base !== null ? [revisionName] : []), ...runChecks, postconditions], stopped,
        bound ?? null);
      continue;
    }
    if (save.saved_bytes_are_previewed === null) {
      gap(consentName, 'no candidate content projected', save);
    } else {
      check(consentName, save.saved_bytes_are_previewed === true && save.save_ran_nothing === true, save);
    }
    if (base !== null) {
      // The revision binds the document the consent saved and the Run ran: its base is the created
      // bytes, its candidate the saved workflow's exact bytes, proposed under that same path. A
      // digest matching some other proposed file is another document, never this one.
      const created = step('edit_open')?.created_sha256 ?? null;
      const revision = reached.evidence?.revision ?? null;
      const savedPath = save.saved ?? null;
      const proposed = (reached.evidence?.files ?? []).find((file) => file.path === savedPath);
      check(revisionName, revision !== null
        && created !== null && revision.base_sha256 === created
        && typeof save.saved_sha256 === 'string' && revision.candidate_sha256 === save.saved_sha256
        && proposed !== undefined && proposed.content_sha256 === revision.candidate_sha256,
      { created, revision, saved: savedPath, saved_sha256: save.saved_sha256, proposed: proposed ?? null });
    }
    const runs = report.steps.filter((entry) => entry.step.startsWith(`${name}_run`) && entry.outcomes);
    const unobserved = runs.flatMap((entry) => entry.outcomes)
      .filter((kind) => kind === 'run_not_started' || kind === 'run_unobserved');
    const observed = step(`${name}_run_observed`);
    if (observed === undefined) {
      withhold([...runChecks, postconditions], stopped, bound ?? null);
      continue;
    }
    if (observed.deadline === true) {
      // The harness stopped watching while the Run was still unsettled: what it last saw is kept.
      withhold([...runChecks, postconditions], `the harness stopped watching the Run after ${observed.observation_ms
        ?? 'its window in'} ms: ${OBSERVATION}`, observed);
      continue;
    }
    const waiting = observed.waiting ?? { kind: 'free' };
    if (unobserved.length > 0 || (observed.run === null && waiting.kind !== 'free')) {
      // The engine's own word (no Run started, or its end unobserved), or a Run waiting on what
      // the persona was never told to answer: nothing about the Run or its world is claimed.
      const why = unobserved.length > 0 ? `the Session said ${unobserved.join(', ')}`
        : `the Session waits on ${waiting.kind} ${waiting.name ?? waiting.key ?? ''}`.trim()
          + ', which the persona does not answer';
      for (const entry of runChecks) gap(entry, why, observed);
      gap(postconditions, 'no Run was observed', observed);
      continue;
    }
    const ran = observed.run;
    check(runChecks[0], observed.busy === false && ran?.current === true
      && path.posix.normalize(String(ran.workflow)) === path.posix.normalize(String(observed.saved))
      && ran.end?.end === 'succeeded', observed);
    // The bytes a Run ran are proven only by the source hash the Session names for it; a Session
    // that names none leaves them unproven, never assumed to be the saved ones.
    if (ran === null) {
      gap(runChecks[1], 'no Run was observed', observed);
    } else if (typeof ran.workflow_sha256 !== 'string') {
      gap(runChecks[1], 'the Session names no source hash of the bytes its Run ran', observed);
    } else {
      check(runChecks[1], ran.workflow_sha256 === observed.saved_sha256, observed);
    }
    if (worldChecks) {
      const stated = worldChecks[name];
      if (!Array.isArray(stated) || stated.length === 0) gap(worldName, 'the world judged nothing for this leg', null);
      for (const entry of stated ?? []) {
        if (['passed', 'failed', 'not_exercised'].includes(entry?.verdict) && typeof entry.name === 'string') {
          record(entry);
        } else {
          check(worldName, false, { malformed_world_check: entry ?? null });
        }
      }
      continue;
    }
    check(`the ${name.toUpperCase()} report holds exactly the expected tickets`, observed.report !== null
      && observed.report.count === ids.length && JSON.stringify(observed.report.ids) === JSON.stringify(ids),
    { report: observed.report, expected: ids });
  }
  leg = null;
  const verdict = checks.some((entry) => entry.verdict === 'failed') ? 'failed'
    : checks.some((entry) => entry.verdict === 'not_exercised') ? 'not_exercised' : 'passed';
  return { verdict, checks, legs: legsOf(byLeg) };
}

module.exports.judgeJourney = judgeJourney;
module.exports.journeyDenominators = journeyDenominators;
module.exports.advance = advance;
module.exports.requestedSeat = requestedSeat;
module.exports.journeyDoors = journeyDoors;
module.exports.sessionResult = sessionResult;
module.exports.keepDoor = keepDoor;

/**
 * One door's own files, copied out of its scratch (`base`) into `keep/<door>` before the scratch
 * goes, so a held or failed leg stays inspectable: the project's `.nika/` (the Session's record,
 * consents, compile plans and run traces), a resident's state root, each leg's captured world,
 * and each draft a leg settled on without a proposal, as a file. Nothing under HOME is read.
 * Returns what was kept, named relative to `keep`; a copy that fails is named with its reason.
 */
function keepDoor({ keep, door, base, project, transcript }) {
  const into = path.join(keep, door);
  mkdirSync(into, { recursive: true });
  const kept = [];
  const copy = (from, to) => {
    if (!existsSync(from)) return;
    try {
      cpSync(from, path.join(into, to), { recursive: true });
      kept.push(`${door}/${to}`);
    } catch (error) {
      kept.push(`${door}/${to}: not kept (${error?.code ?? 'error'})`);
    }
  };
  copy(path.join(project, '.nika'), 'project-nika');
  copy(path.join(base, 'state'), 'resident-state');
  copy(path.join(base, 'legs'), 'legs');
  for (const step of transcript?.steps ?? []) {
    if (!/_reached$/.test(step.step) || typeof step.draft !== 'string') continue;
    const file = `${step.step.replace(/_reached$/, '')}-draft.nika`;
    writeFileSync(path.join(into, file), step.draft);
    kept.push(`${door}/${file}`);
  }
  return kept;
}

/**
 * The runner's result: `failed` when a walk, a comparison or a journey door failed;
 * `not_exercised` when any of them was not exercised, or a requested journey walked no door;
 * `green` only when everything requested was exercised and passed.
 */
function sessionResult(walks, comparisons, journey) {
  const doors = journey.ran ? journey.doors : [];
  const journeyVerdicts = doors.map((entry) => (entry.exercised ? entry.verdict : 'not_exercised'));
  if (walks.some((entry) => entry.exercised && entry.verdict === 'failed')
    || comparisons.some((entry) => entry.equal === false) || journeyVerdicts.includes('failed')) return 'failed';
  if (walks.length === 0 || walks.some((entry) => !entry.exercised || entry.verdict === 'not_exercised')
    || comparisons.some((entry) => entry.equal === null) || journeyVerdicts.includes('not_exercised')
    || (journey.ran && doors.length === 0)) return 'not_exercised';
  return 'green';
}
