'use strict';
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

// The authoring Session through one real door (`nika session --json` in the
// project, or a served project's `/v1/sessions`), from the PACKED package of
// one module system (scripts/run-session-parity-e2e.mjs). The engine's
// deterministic compiler answers: no provider is seated and none is reachable,
// so both doors and both module systems must walk the same sequence. This
// module only observes: it sends the lines, keeps what the engine answered and
// reads the project world afterwards. `judgeSession` below states what must
// hold; the runner compares the doors.

/** An explicit request the deterministic compiler makes ready at once. */
const COPY = 'Read ./notes/brief.md and write it to ./out/copy.md';
/** A second request, sent with a Stop right behind it. */
const SECOND = 'Read ./notes/brief.md and write it to ./out/second.md';
const WAIT_MS = 120_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

module.exports = async function sessionScenario(sdk, config) {
  const steps = [];
  const open = [];
  try {
    const session = await walk(sdk, config, steps, open);
    return { module_system: config.moduleSystem, door: config.door, session, steps, error: null };
  } catch (error) {
    // The transcript so far, and what stopped it: the judge reads both, nothing is lost.
    return { module_system: config.moduleSystem, door: config.door, session: open[0]?.id ?? null, steps,
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error), code: error?.code ?? null,
        at: steps.at(-1)?.step ?? null } };
  } finally {
    await Promise.allSettled(open.map((handle) => handle.close({ signal: AbortSignal.timeout(10_000) })));
  }
};

async function walk(sdk, config, steps, open) {
  const signal = () => AbortSignal.timeout(WAIT_MS);
  const client = config.door === 'native'
    ? new sdk.Nika({ bin: config.bin, cwd: config.project })
    : new sdk.Nika({ url: config.url, token: config.token, allowInsecureHttp: true,
      // If the Session ever fell back to a local engine, this path could not resolve one.
      bin: path.join(config.project, 'there-is-no-local-engine') });
  const world = (relative) => path.join(config.project, relative);
  const read = (relative) => (existsSync(world(relative)) ? readFileSync(world(relative)) : null);
  const record = (step, value) => {
    steps.push({ step, ...value });
    return value;
  };
  const refused = async (action) => {
    try {
      const result = await action();
      return { error: null, result };
    } catch (error) {
      return { error };
    }
  };
  // Every handle this walk opened, until it closes it: the caller closes what an error left open.
  const opening = async (from) => {
    const handle = await from.openSession({ signal: signal() });
    open.push(handle);
    return handle;
  };
  const closing = async (handle) => {
    open.splice(open.indexOf(handle), 1);
    return handle.close({ signal: signal() });
  };

  const a = await opening(client);
  const opened = a.opened.snapshot;
  record('open', { ...frameRow(a.opened), root_is_project: samePath(opened.work.root, config.project) });
  // Every event from the start, and (below) a view resumed after the proposal: both until `closed`.
  const viewing = AbortSignal.timeout(10 * WAIT_MS);
  const full = collect(a.events({ signal: viewing }));

  const proposal = await a.submit(opened, COPY, { command: 'c-1', signal: signal() });
  record('proposal', frameRow(proposal));
  const resumed = collect(a.events({ after: proposal.cursor ?? `${a.id}:${proposal.event}`, signal: viewing }));
  const files = proposal.snapshot.work.candidate?.files ?? [];
  record('preview', { files: files.map(fileRow),
    landed_before_consent: files.map((file) => existsSync(world(file.path))) });

  const stale = await refused(() => a.submit(opened, 'yes', { command: 'c-2', signal: signal() }));
  record('stale_answer', { ...errorRow(stale.error), saved_after: (await a.snapshot()).work.saved });

  const replay = await a.submit(opened, COPY, { command: 'c-1', signal: signal() });
  record('same_command_same_bytes', { ...frameRow(replay),
    same_outcomes: JSON.stringify(replay.outcomes) === JSON.stringify(proposal.outcomes) });

  const conflict = await refused(() => a.submit(proposal.snapshot, 'no', { command: 'c-1', signal: signal() }));
  record('same_command_other_bytes', { ...errorRow(conflict.error), seq_after: (await a.snapshot()).seq });

  const details = await a.details({ signal: signal() });
  record('details', { names_current_snapshot: details.snapshot === proposal.snapshot.snapshot,
    has_text: typeof details.text === 'string' && details.text.length > 0 });

  // Another Session's snapshot is never an answer here. Natively another project's Session runs
  // beside this one; a resident holds one live Session per project and says so.
  if (config.door === 'native') {
    const other = await opening(new sdk.Nika({ bin: config.bin, cwd: config.other }));
    const foreign = await refused(() => other.submit(proposal.snapshot, 'yes', { command: 'x-1', signal: signal() }));
    record('cross_session_answer', { ...errorRow(foreign.error), other_session: other.id !== a.id,
      other_saved: (await other.snapshot()).work.saved });
    await closing(other);
  } else {
    const second = await refused(() => client.openSession({ signal: signal() }));
    record('second_session_same_project', { ...errorRow(second.error), names_live: second.error?.session === a.id });
  }

  const consent = await a.submit(proposal.snapshot, 'yes', { command: 'c-3', signal: signal() });
  const saved = consent.snapshot.work.saved;
  const landed = saved?.workflow === undefined ? null : read(saved.workflow);
  const previewed = files.find((file) => file.path === saved?.workflow);
  const savedSha = landed === null ? null : sha256(landed);
  record('consent', { ...frameRow(consent),
    saved_is_previewed_path: previewed !== undefined,
    saved_bytes_are_previewed: landedExactly(previewed, landed),
    saved_sha256: savedSha,
    run_output_before_run: existsSync(world('out/copy.md')) });

  const idle = await a.stop({ command: 's-1', signal: signal() });
  record('stop_idle', frameRow(idle));

  const run = await a.submit(consent.snapshot, 'run it', { command: 'c-4', signal: signal() });
  record('run', frameRow(run));
  let after = run.snapshot;
  // A resident may hold its cost review: the test persona accepts it, as a person would answer.
  if (after.work.waiting.kind === 'run_review') {
    const reviewed = await a.submit(after, 'yes', { command: 'c-4r', signal: signal() });
    record('run_review_answer', frameRow(reviewed));
    after = reviewed.snapshot;
  }
  // The Run's end is observed by the Session itself: read snapshots until no turn is under way and
  // the Session observed the Run, or said it started none or could not observe its end. Reaching
  // the deadline instead is recorded, never read as an observation.
  const said = (kinds) => steps.some((entry) => (entry.outcomes ?? []).some((kind) => kinds.includes(kind)));
  const unsettled = () => after.busy !== null
    || (after.work.run === null && !said(['run_not_started', 'run_unobserved']));
  const until = Date.now() + WAIT_MS;
  while (unsettled() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    after = await a.snapshot({ signal: signal() });
  }
  const output = read('out/copy.md');
  const source = read('notes/brief.md');
  const observed = after.work.run;
  record('run_observed', { deadline: unsettled(), busy: after.busy !== null, waiting: after.work.waiting.kind,
    requested: after.work.requested, run: observed,
    // The Run the Session observed is the saved workflow's when it names its path and the sha256
    // of the exact bytes it ran (the trace's `workflow_sha256`) is the saved file's.
    run_is_saved_workflow: observed !== null && observed.current === true && observed.workflow === saved?.workflow,
    run_ran_saved_bytes: observed !== null && savedSha !== null && observed.workflow_sha256 === savedSha,
    run_succeeded: observed?.end?.end === 'succeeded',
    output_sha256: output === null ? null : sha256(output),
    output_is_source: output !== null && source !== null && output.equals(source) });

  // A second request with a Stop right behind it: the receipt says whether the turn was still
  // under way; the turn's own result settles it either way.
  const pending = a.submit((await a.snapshot()), SECOND, { command: 'c-5', signal: signal() });
  const stop = await a.stop({ command: 's-2', signal: signal() });
  const stopped = await pending;
  record('stop_racing_a_turn', { receipt: stop.receipt ?? null, target: stop.target ?? null,
    settled: frameRow(stopped),
    candidate_current: stopped.snapshot.work.candidate !== null,
    second_landed: existsSync(world('out/second.md')) });

  const closed = await closing(a);
  record('close', frameRow(closed));
  const events = await full;
  const later = await resumed;
  record('events', {
    kinds: events.frames.map((frame) => frame.frame),
    numbers: events.frames.map((frame) => frame.event ?? null),
    ended: events.error !== null ? events.error.name
      : events.frames.at(-1)?.frame === 'closed' ? 'closed' : 'ended_without_closed',
    resumed_is_suffix: later.error === null
      && JSON.stringify(later.frames.map((frame) => frame.event))
        === JSON.stringify(events.frames.filter((frame) => frame.event > proposal.event).map((frame) => frame.event)),
    resumed_has_no_replay: later.frames.every((frame) => frame.event > proposal.event),
  });

  // A restart is a new incarnation: the old Session is gone and its snapshots answer nothing.
  const reopened = await opening(client);
  const restart = await refused(() => reopened.submit(proposal.snapshot, 'yes', { command: 'r-1', signal: signal() }));
  record('restart_answer', { ...errorRow(restart.error), new_session: reopened.id !== a.id,
    reopened_saved: reopened.opened?.snapshot.work.saved ?? null });
  if (config.door === 'http') {
    const gone = await refused(() => client.attachSession(a.id, { signal: signal() }));
    record('attach_closed_session', errorRow(gone.error));
  }
  await closing(reopened);
  return a.id;
}

/** One frame as the transcript keeps it: what the engine said, never its handles. */
function frameRow(frame) {
  const work = frame.snapshot?.work;
  return {
    frame: frame.frame,
    event: frame.event ?? null,
    op: frame.op ?? null,
    replayed: frame.replayed ?? null,
    receipt: frame.receipt ?? null,
    outcomes: (frame.outcomes ?? []).map((outcome) => outcome.kind),
    seq: frame.snapshot?.seq ?? null,
    waiting: work?.waiting.kind ?? null,
    candidate: work?.candidate ? (work.candidate.files ?? []).map(fileRow) : null,
    saved: work?.saved?.workflow ?? null,
    requested: work?.requested ?? null,
    run: work?.run ?? null,
  };
}

/**
 * Whether the saved bytes are exactly the previewed file's `content`. Its `bytes` member is a
 * BLAKE3 witness this runner does not compute: without `content` (an engine before it) the
 * answer is `null`, unverified, never a pass.
 */
function landedExactly(previewed, landed) {
  if (typeof previewed?.content !== 'string') return null;
  return landed !== null && landed.equals(Buffer.from(previewed.content, 'utf8'));
}

/** A candidate file: its witness, and the sha256 of its exact `content` when the engine projects it. */
function fileRow(file) {
  return { path: file.path, bytes: file.bytes, landing: file.landing ?? null, workflow: file.workflow ?? null,
    content_sha256: typeof file.content === 'string' ? sha256(Buffer.from(file.content, 'utf8')) : null };
}

function errorRow(error) {
  if (!error) return { refused: false };
  return { refused: true, error: error.name, code: error.code ?? null, line: error.line ?? null,
    seq: error.snapshot?.seq ?? null };
}

function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/** Read a view to its end in the background, keeping every frame and how it ended. */
async function collect(view) {
  const frames = [];
  try {
    for await (const frame of view) {
      frames.push(frame);
      if (frame.frame === 'closed') break;
    }
    return { frames, error: null };
  } catch (error) {
    return { frames, error };
  }
}

/**
 * The steps both doors walk alike, up to the Save and the idle Stop. A Run
 * differs by design (a resident runs it as a job and may hold its cost
 * review), and each door has its own way to show another Session.
 */
const SHARED_STEPS = ['open', 'proposal', 'preview', 'stale_answer', 'same_command_same_bytes',
  'same_command_other_bytes', 'details', 'consent', 'stop_idle'];
/** The steps both module systems walk alike on one door: all but the timed ones. */
const MODULE_STEPS = [...SHARED_STEPS, 'cross_session_answer', 'second_session_same_project', 'restart_answer',
  'attach_closed_session'];

/** A step as two walks compare it: what the engine said, never a door's own path or error class. */
function comparable(report, name) {
  const entry = report.steps.find((each) => each.step === name);
  if (entry === undefined) return null;
  const { root_is_project: _root, ...rest } = entry;
  // The native handle refuses an identity's other bytes before sending; a resident answers
  // `command_conflict`. Either way nothing ran: that, and the unchanged snapshot, compare.
  if (name === 'same_command_other_bytes') return { refused: rest.refused, seq_after: rest.seq_after };
  return rest;
}

/** Compare two walks step by step; every difference is named, none is forgiven. */
function sessionParity(left, right, steps = SHARED_STEPS) {
  const differences = [];
  for (const name of steps) {
    const one = comparable(left, name);
    const other = comparable(right, name);
    if (JSON.stringify(one) !== JSON.stringify(other)) {
      differences.push({ step: name, [`${left.module_system}/${left.door}`]: one,
        [`${right.module_system}/${right.door}`]: other });
    }
  }
  return { equal: differences.length === 0, steps, differences };
}

/**
 * What one door's transcript must show. Each check is named, observed and
 * judged; a step the binary cannot exercise is `not_exercised`, never a pass.
 */
function judgeSession(report) {
  if (report.error !== null) {
    // A walk that stopped proves only the steps it kept; the stop itself is the finding.
    return { verdict: 'failed', checks: [{ name: 'the walk completed', verdict: 'failed', observed: report.error }] };
  }
  const step = (name) => report.steps.find((entry) => entry.step === name);
  const checks = [];
  const check = (name, passed, observed) => checks.push({ name, verdict: passed ? 'passed' : 'failed', observed });
  const gap = (name, why, observed) => checks.push({ name, verdict: 'not_exercised', why, observed });

  const open = step('open');
  check('opens on a free snapshot in the project world', open.waiting === 'free' && open.root_is_project === true
    && open.event === 1, open);
  const proposal = step('proposal');
  check('an explicit request proposes a candidate', proposal.outcomes.includes('proposal')
    && proposal.waiting === 'consent' && (proposal.candidate ?? []).length > 0, proposal);
  const preview = step('preview');
  check('a preview lands nothing before the consent', preview.landed_before_consent.length > 0
    && preview.landed_before_consent.every((landed) => landed === false), preview);
  const stale = step('stale_answer');
  check('an answer to an earlier snapshot is refused, its line kept, nothing saved', stale.code === 'stale_snapshot'
    && stale.line === 'yes' && stale.seq === proposal.seq && stale.saved_after === null, stale);
  const replay = step('same_command_same_bytes');
  check('the same command and bytes return the recorded result', replay.replayed === true
    && replay.event === proposal.event && replay.same_outcomes === true && replay.seq === proposal.seq, replay);
  const conflict = step('same_command_other_bytes');
  check('the same command with other bytes is refused and changes nothing', conflict.refused === true
    && (conflict.code === 'command_conflict' || (report.door === 'native' && conflict.error === 'NikaConfigurationError'))
    && conflict.seq_after === proposal.seq, conflict);
  const details = step('details');
  check('details read the current snapshot', details.names_current_snapshot && details.has_text, details);
  const foreign = step('cross_session_answer');
  if (foreign) {
    check('another Session\'s snapshot answers nothing', foreign.code === 'unknown_snapshot'
      && foreign.other_session === true && foreign.other_saved === null, foreign);
  }
  const second = step('second_session_same_project');
  if (second) {
    check('a second Session on the served project is refused with the live one', second.code === 'session_live'
      && second.names_live === true, second);
  }
  const consent = step('consent');
  check('the consent saves the previewed file and runs nothing', consent.saved_is_previewed_path
    && consent.run_output_before_run === false && !consent.outcomes.some((kind) => kind.startsWith('run')), consent);
  if (consent.saved_bytes_are_previewed === null) {
    gap('the saved bytes are exactly the previewed ones',
      'the engine projects no candidate content, only a BLAKE3 witness this runner does not compute', consent);
  } else {
    check('the saved bytes are exactly the previewed ones', consent.saved_bytes_are_previewed === true, consent);
  }
  const idle = step('stop_idle');
  check('a Stop with no turn under way has nothing to stop', idle.receipt === 'nothing_to_stop', idle);
  const run = step('run');
  const review = step('run_review_answer');
  const observed = step('run_observed');
  const said = [...run.outcomes, ...(review?.outcomes ?? [])];
  const unobserved = said.filter((kind) => kind === 'run_not_started' || kind === 'run_unobserved');
  const RUN_CHECKS = ['the Session observed the requested Run end', 'the observed Run ran the saved bytes',
    'the Run succeeded and wrote the copy in the same project world'];
  const evidence = { run, review, observed };
  if (unobserved.length > 0) {
    // The engine's own word: no Run started, or its end was not observed. No postcondition is claimed.
    for (const name of RUN_CHECKS) gap(name, `the Session said ${unobserved.join(', ')}`, evidence);
  } else {
    // A Run the Session never observed, a deadline reached, a Run still under way or one of
    // other bytes is a failure, whatever the project world shows. Judged from the observed Run
    // itself, never from a summary of it.
    const ran = observed.run;
    check(RUN_CHECKS[0], said.includes('run_requested') && observed.deadline === false && observed.busy === false
      && ran !== null && typeof ran?.end?.end === 'string', evidence);
    check(RUN_CHECKS[1], ran?.current === true && typeof ran.workflow === 'string' && ran.workflow === consent.saved
      && typeof ran.workflow_sha256 === 'string' && ran.workflow_sha256 === consent.saved_sha256, evidence);
    check(RUN_CHECKS[2], ran?.end?.end === 'succeeded' && observed.output_is_source === true, evidence);
  }
  const race = step('stop_racing_a_turn');
  if (race.receipt === 'stop_requested') {
    check('a Stop withdraws the late result of the turn it stopped', race.settled.outcomes.includes('cancelled')
      && race.candidate_current === false && race.second_landed === false, race);
  } else {
    gap('a Stop withdraws the late result of the turn it stopped',
      `the deterministic turn settled before the Stop (${race.receipt})`, race);
  }
  const close = step('close');
  check('close ends the Session', close.frame === 'closed', close);
  const events = step('events');
  check('the event view is the Session\'s log, numbered and ended by closed', events.ended === 'closed'
    && events.kinds[0] === 'opened' && events.kinds.at(-1) === 'closed'
    && events.numbers.every((number, index) => index === 0 || number > events.numbers[index - 1]), events);
  check('a view resumed after an event repeats nothing and misses nothing', events.resumed_is_suffix
    && events.resumed_has_no_replay, events);
  const restart = step('restart_answer');
  check('after a restart an old snapshot answers nothing', restart.code === 'unknown_snapshot'
    && restart.new_session === true, restart);
  const attach = step('attach_closed_session');
  if (attach) check('a closed Session cannot be attached', attach.code === 'session_not_found', attach);
  const verdict = checks.some((entry) => entry.verdict === 'failed') ? 'failed'
    : checks.some((entry) => entry.verdict === 'not_exercised') ? 'not_exercised' : 'passed';
  return { verdict, checks };
}

module.exports.COPY = COPY;
module.exports.frameRow = frameRow;
module.exports.landedExactly = landedExactly;
module.exports.judgeSession = judgeSession;
module.exports.sessionParity = sessionParity;
module.exports.SHARED_STEPS = SHARED_STEPS;
module.exports.MODULE_STEPS = MODULE_STEPS;
