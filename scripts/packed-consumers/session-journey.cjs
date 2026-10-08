'use strict';
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
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

const WAIT_MS = 1_800_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
  const signal = () => AbortSignal.timeout(WAIT_MS);
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
    const handle = await client.openSession({ signal: signal() });
    open.push(handle);
    return handle;
  };
  const closing = async (handle) => {
    open.splice(open.indexOf(handle), 1);
    return handle.close({ signal: signal() });
  };

  /** One leg: words to a proposal, the consent, the requested Run and the report it wrote. */
  async function leg(name, session, words) {
    const reached = await advance(session, session.opened.snapshot, words, persona, signal, (turn) =>
      record(`${name}_turn`, turn));
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
    const consent = await session.submit(shown, 'yes', { command: `${name}-save`, signal: signal() });
    const saved = consent.snapshot.work.saved;
    const landed = saved?.workflow === undefined ? null : read(saved.workflow);
    const previewed = files.find((file) => file.path === saved?.workflow);
    const savedSha = landed === null ? null : sha256(landed);
    const ranNothing = reportSha() === reportBefore && !frameRow(consent).outcomes.some((kind) => kind.startsWith('run'));
    // The engine's own check of the exact saved bytes in the project world, as a person runs it: a
    // world's oracle reads this real verdict, never a status assumed for it.
    const check = config.checkBin && saved?.workflow ? checked(config.checkBin, config.project, saved.workflow) : null;
    record(`${name}_save`, { ...frameRow(consent), saved_bytes_are_previewed: landedExactly(previewed, landed),
      saved_sha256: savedSha, saved_base64: landed === null ? null : landed.toString('base64'),
      save_ran_nothing: ranNothing, check });
    const runStartedAt = Date.now();
    let run = await session.submit(consent.snapshot, 'run it', { command: `${name}-run`, signal: signal() });
    record(`${name}_run`, frameRow(run));
    // What the Run asks before it starts: the resident's cost review, which the persona accepts
    // (the Run is the authorized step), and a declared input's value, answered only by a persona
    // rule over its name and asking words, never guessed. Anything else is left to the person.
    for (let asked = 0; asked < 8; asked += 1) {
      const waiting = run.snapshot.work.waiting;
      if (waiting.kind === 'run_review') {
        run = await session.submit(run.snapshot, 'yes', { command: `${name}-run-review-${asked}`, signal: signal() });
        record(`${name}_run_review`, frameRow(run));
        continue;
      }
      const answer = waiting.kind === 'input' ? answerFor(persona.answers, { key: waiting.name }, run, 'input') : null;
      if (answer === null) break;
      run = await session.submit(run.snapshot, answer.line, { command: `${name}-run-input-${asked}`, signal: signal() });
      record(`${name}_run_input`, { ...frameRow(run), input: waiting.name ?? null, said: answer.why });
    }
    let after = run.snapshot;
    const said = (kinds) => steps.some((entry) => entry.step.startsWith(`${name}_run`)
      && (entry.outcomes ?? []).some((kind) => kinds.includes(kind)));
    // A Session waiting on the person (an input no rule answers, a gate) starts and ends no Run
    // until someone answers: polling stops, and the leg says what it waits on.
    const waitsOnPerson = () => after.busy === null && after.work.waiting.kind !== 'free';
    const unsettled = () => !waitsOnPerson() && (after.busy !== null
      || (after.work.run === null && !said(['run_not_started', 'run_unobserved'])));
    const until = Date.now() + WAIT_MS;
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
    record(`${name}_run_observed`, { deadline: unsettled(), busy: after.busy !== null, run: after.work.run,
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

  // CREATE: a new Session, words alone.
  const first = await opening();
  record('create_open', { ...frameRow(first.opened), intelligence: first.opened.snapshot.work.intelligence ?? null });
  const created = await leg('create', first, config.create);
  await closing(first);
  if (created === null) return;

  // EDIT: a new Session over the same project world; the change in words.
  const second = await opening();
  record('edit_open', { ...frameRow(second.opened), intelligence: second.opened.snapshot.work.intelligence ?? null,
    created_sha256: created.savedSha });
  await leg('edit', second, config.edit);
  await closing(second);
}

/**
 * Submit `line`, then answer only what the persona was told to, until the Session waits on a
 * consent or settles otherwise. Every turn is reported; nothing is guessed for the person.
 */
async function advance(session, snapshot, line, persona, signal, report) {
  let shown = snapshot;
  let next = line;
  let said = 'words';
  // A harness bound against a door that never settles, not a product quota.
  for (let turn = 0; turn < 24; turn += 1) {
    const result = await session.submit(shown, next, { command: `${said}-${turn}`, signal: signal() });
    shown = result.snapshot;
    const waiting = shown.work.waiting;
    report({ turn, said, ...frameRow(result), evidence: evidence(shown.work) });
    if (waiting.kind === 'intelligence_choice' && persona.choice) {
      [next, said] = [persona.choice, 'intelligence_choice'];
    } else if (waiting.kind === 'cost_choice' && persona.acceptCost) {
      [next, said] = ['yes', 'cost_choice'];
    } else if (waiting.kind === 'question' && answerFor(persona.answers, waiting, result) !== null) {
      const answer = answerFor(persona.answers, waiting, result);
      [next, said] = [answer.line, `answer ${waiting.key} (${answer.why})`];
    } else {
      return { waiting: waiting.kind, snapshot: shown,
        summary: { waiting: waiting.kind, key: waiting.key ?? null, outcomes: frameRow(result).outcomes,
          turns: turn + 1, evidence: evidence(shown.work) } };
    }
  }
  return { waiting: 'turn_bound', snapshot: shown, summary: { waiting: 'turn_bound', turns: 24 } };
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

/** What a snapshot says of who prepared the candidate and of the candidate itself. */
function evidence(work) {
  const calls = work.authoring?.calls ?? null;
  return {
    intelligence: work.intelligence ?? null,
    calls: calls === null ? null : { requested_model: calls.requested_model, calls: calls.calls,
      input_tokens: calls.input_tokens ?? null, output_tokens: calls.output_tokens ?? null,
      elapsed_ms: calls.elapsed_ms, backend: calls.backend ?? null },
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
 * names the first-screen answer, the journey counts for that seat only if the Session's own
 * selection is it: a choice kept from elsewhere is never relabelled as the one requested.
 */
function judgeJourney(report, expected, requested = null, worldChecks = null) {
  if (report.error !== null) {
    return { verdict: 'failed', checks: [{ name: 'the journey completed', verdict: 'failed', observed: report.error }] };
  }
  const step = (name) => report.steps.find((entry) => entry.step === name);
  const checks = [];
  const check = (name, passed, observed) => checks.push({ name, verdict: passed ? 'passed' : 'failed', observed });
  const gap = (name, why, observed) => checks.push({ name, verdict: 'not_exercised', why, observed });
  const authored = (evidence) => evidence?.calls !== null && evidence?.calls?.calls >= 1
    && ['provider', 'harness'].includes(evidence?.intelligence?.author?.kind);
  if (requested !== null) {
    const seat = requestedSeat(requested);
    const reached = step('create_reached');
    const selected = reached?.evidence?.intelligence?.selected ?? null;
    const answered = report.steps.some((entry) => entry.step === 'create_turn' && entry.said === 'intelligence_choice');
    if (reached === undefined || selected === null) {
      gap('the Session prepared with the requested intelligence', 'no selection was observed', reached ?? null);
    } else if (isRequestedSeat(selected, seat)) {
      check('the Session prepared with the requested intelligence', true, { requested: seat, selected });
    } else if (answered) {
      // The persona gave the first screen this answer and the Session selected another seat.
      check('the Session prepared with the requested intelligence', false, { requested: seat, selected });
    } else {
      gap('the Session prepared with the requested intelligence',
        'the Session opened on a choice kept before this journey, never asked the first screen', { requested: seat,
          selected });
    }
  }

  // The tickets ids judge the built-in world only; a world module brings its own checks instead.
  for (const [name, ids, base] of [['create', expected?.create ?? [], null], ['edit', expected?.edit ?? [], 'create']]) {
    const reached = step(`${name}_reached`);
    if (reached === undefined) {
      gap(`the ${name.toUpperCase()} leg reached a proposal`, 'an earlier leg stopped first', null);
      continue;
    }
    if (reached.waiting !== 'consent') {
      gap(`the ${name.toUpperCase()} leg reached a proposal`,
        `the Session waits on ${reached.waiting}${reached.key ? ` (${reached.key})` : ''}`, reached);
      continue;
    }
    check(`the ${name.toUpperCase()} leg reached a proposal`, true, reached);
    if (authored(reached.evidence)) {
      check(`a model authored the ${name.toUpperCase()} proposal`, true, reached.evidence);
    } else {
      gap(`a model authored the ${name.toUpperCase()} proposal`,
        `the author was ${reached.evidence?.intelligence?.author?.kind ?? 'unknown'} with no call receipt`,
        reached.evidence);
    }
    const save = step(`${name}_save`);
    if (save.saved_bytes_are_previewed === null) {
      gap(`the ${name.toUpperCase()} consent saved exactly the proposed bytes`, 'no candidate content projected', save);
    } else {
      check(`the ${name.toUpperCase()} consent saved exactly the proposed bytes`,
        save.saved_bytes_are_previewed === true && save.save_ran_nothing === true, save);
    }
    if (base !== null) {
      // The revision binds the document the consent saved and the Run ran: its base is the created
      // bytes, its candidate the saved workflow's exact bytes, proposed under that same path. A
      // digest matching some other proposed file is another document, never this one.
      const created = step('edit_open')?.created_sha256 ?? null;
      const revision = reached.evidence?.revision ?? null;
      const savedPath = save.saved ?? null;
      const proposed = (reached.evidence?.files ?? []).find((file) => file.path === savedPath);
      check('the EDIT proposal revises the created bytes into the saved workflow', revision !== null
        && created !== null && revision.base_sha256 === created
        && typeof save.saved_sha256 === 'string' && revision.candidate_sha256 === save.saved_sha256
        && proposed !== undefined && proposed.content_sha256 === revision.candidate_sha256,
      { created, revision, saved: savedPath, saved_sha256: save.saved_sha256, proposed: proposed ?? null });
    }
    const runs = report.steps.filter((entry) => entry.step.startsWith(`${name}_run`) && entry.outcomes);
    const unobserved = runs.flatMap((entry) => entry.outcomes)
      .filter((kind) => kind === 'run_not_started' || kind === 'run_unobserved');
    const observed = step(`${name}_run_observed`);
    const LEG = name.toUpperCase();
    // A world module states its own postconditions; the built-in world's are the tickets report.
    const worldName = `the ${LEG} world postconditions hold`;
    const postconditions = worldChecks ? worldName : `the ${LEG} report holds exactly the expected tickets`;
    const runChecks = [`the ${LEG} Run of the saved workflow succeeded`, `the ${LEG} Run ran the saved bytes`];
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
    check(runChecks[0], observed.deadline === false && observed.busy === false && ran?.current === true
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
          checks.push(entry);
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
  const verdict = checks.some((entry) => entry.verdict === 'failed') ? 'failed'
    : checks.some((entry) => entry.verdict === 'not_exercised') ? 'not_exercised' : 'passed';
  return { verdict, checks };
}

module.exports.judgeJourney = judgeJourney;
module.exports.advance = advance;
module.exports.requestedSeat = requestedSeat;
module.exports.journeyDoors = journeyDoors;
module.exports.sessionResult = sessionResult;

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
