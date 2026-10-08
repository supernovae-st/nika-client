'use strict';
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
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
    record(`${name}_save`, { ...frameRow(consent), saved_bytes_are_previewed: landedExactly(previewed, landed),
      saved_sha256: savedSha, save_ran_nothing: reportSha() === reportBefore
        && !frameRow(consent).outcomes.some((kind) => kind.startsWith('run')) });
    let run = await session.submit(consent.snapshot, 'run it', { command: `${name}-run`, signal: signal() });
    record(`${name}_run`, frameRow(run));
    if (run.snapshot.work.waiting.kind === 'run_review') {
      // The resident's cost review of the Run: the persona accepts it, as the run authorized.
      run = await session.submit(run.snapshot, 'yes', { command: `${name}-run-review`, signal: signal() });
      record(`${name}_run_review`, frameRow(run));
    }
    let after = run.snapshot;
    const said = (kinds) => steps.some((entry) => entry.step.startsWith(`${name}_run`)
      && (entry.outcomes ?? []).some((kind) => kinds.includes(kind)));
    const unsettled = () => after.busy !== null
      || (after.work.run === null && !said(['run_not_started', 'run_unobserved']));
    const until = Date.now() + WAIT_MS;
    while (unsettled() && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      after = await session.snapshot({ signal: signal() });
    }
    const report = read('out/report.json');
    let parsed = null;
    try {
      parsed = report === null ? null : JSON.parse(report.toString('utf8'));
    } catch {
      parsed = { unparsable: true };
    }
    record(`${name}_run_observed`, { deadline: unsettled(), busy: after.busy !== null, run: after.work.run,
      saved: saved?.workflow ?? null, saved_sha256: savedSha, report: parsed,
      report_sha256: report === null ? null : sha256(report) });
    return { shown, savedSha };
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
    } else if (waiting.kind === 'question' && typeof persona.answers[waiting.key] === 'string') {
      [next, said] = [persona.answers[waiting.key], `answer ${waiting.key}`];
    } else {
      return { waiting: waiting.kind, snapshot: shown,
        summary: { waiting: waiting.kind, key: waiting.key ?? null, outcomes: frameRow(result).outcomes,
          turns: turn + 1, evidence: evidence(shown.work) } };
    }
  }
  return { waiting: 'turn_bound', snapshot: shown, summary: { waiting: 'turn_bound', turns: 24 } };
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
    files: (work.candidate?.files ?? []).map((file) => ({ path: file.path, landing: file.landing ?? null,
      content_sha256: typeof file.content === 'string' ? sha256(Buffer.from(file.content, 'utf8')) : null })),
    revision: work.candidate?.revision ?? null,
  };
}

/**
 * The seat a first-screen answer names, in the Session's own vocabulary: `1 <app>[/<model>]`
 * (`acp:` before the app asks for ACP), `2 <provider>[/<model>]`, `3 <local>`, `4`.
 */
function requestedSeat(choice) {
  const [pick, name] = String(choice ?? '').trim().split(/\s+/);
  const kind = { 1: 'harness', 2: 'api', 3: 'local', 4: 'none' }[pick] ?? null;
  if (!name) return { kind, via: null, model: null, transport: null };
  const acp = name.startsWith('acp:');
  const bare = acp ? name.slice('acp:'.length) : name;
  const slash = bare.indexOf('/');
  return { kind, via: slash < 0 ? bare : bare.slice(0, slash), model: slash < 0 ? null : bare.slice(slash + 1),
    transport: acp ? 'acp' : null };
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
function judgeJourney(report, expected, requested = null) {
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

  for (const [name, ids, base] of [['create', expected.create, null], ['edit', expected.edit, 'create']]) {
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
    if (unobserved.length > 0) {
      gap(`the ${name.toUpperCase()} Run of the saved bytes succeeded`, `the Session said ${unobserved.join(', ')}`,
        observed);
      gap(`the ${name.toUpperCase()} report holds exactly the expected tickets`, 'no Run was observed', observed);
      continue;
    }
    const ran = observed.run;
    check(`the ${name.toUpperCase()} Run of the saved bytes succeeded`, observed.deadline === false
      && observed.busy === false && ran?.current === true && path.posix.normalize(String(ran.workflow))
        === path.posix.normalize(String(observed.saved)) && ran.workflow_sha256 === observed.saved_sha256
      && ran.end?.end === 'succeeded', observed);
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
