/**
 * Compile an intention into a checked workflow, answer its questions from a
 * JSON file, then run the ready workflow through the ordinary `run()` path.
 *
 *   npm run build                       # the example imports the package by name
 *   node examples/compile-then-run.ts "<intent>" answers.json out/workflow.nika
 *
 * `answers.json` maps question keys to JSON values, for example
 * `{ "const.request": "An outage affects support customers." }`.
 * Node 22.18+ runs this file as is (older 22.x: `--experimental-strip-types`).
 *
 * Configuration comes from the environment only; no key is ever written here:
 *
 *   NIKA_URL, NIKA_TOKEN     a `nika serve --bind` server. Without them the local
 *                            engine runs (NIKA_BIN, else the bundled engine). Over
 *                            HTTP, run() of a local file is captured by a local
 *                            engine and admitted by the server.
 *   NIKA_EXPLICIT_PROVIDER=1 over HTTP: let the server's seated model author one
 *                            round (the server must advertise compileNativeV2).
 *   NIKA_AUTHORING_MODEL     locally: seat this `provider/name` model; its
 *                            credential comes from the engine's environment.
 *   NIKA_MAX_CALLS           optional bound on that round's provider requests.
 *
 * Without a seat, compile is deterministic: exact skeleton names (`nika compile
 * --list`) resolve, and other intents come back incomplete with diagnostics.
 * Over HTTP, when the provider round kept its plan, the answers go to that
 * round's judged answer round: the server replays the kept plan with them and
 * its seat only judges the result (judge calls, never a second authoring call).
 * That needs a server with the judged answer round (engine integration commit
 * 158a961cd, not in a released engine yet); an older one refuses it with a
 * NikaCompatibilityError and nothing is spent.
 *
 * Exit codes: 0 the run succeeded · 1 the run did not, or an SDK error ·
 * 2 compile stopped before a ready candidate · 64 usage.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isNikaCompileHeld, isNikaRunSucceeded, Nika, nextCompileRequest } from '@supernovae-st/nika';
import type { NikaCompileOutcome, NikaCompileRequest } from '@supernovae-st/nika';

/** Answer rounds before giving up: the engine asks, the file answers, nothing loops forever. */
const MAX_ROUNDS = 4;

async function main(): Promise<number> {
  const [intent, answersFile, outputFile] = process.argv.slice(2);
  if (!intent || !answersFile || !outputFile) {
    console.error('usage: node examples/compile-then-run.ts "<intent>" answers.json out/workflow.nika');
    return 64;
  }
  const answers: unknown = JSON.parse(await readFile(answersFile, 'utf8'));
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    console.error(`${answersFile} must hold one JSON object of question keys to answers`);
    return 64;
  }
  const known = answers as Record<string, unknown>;

  const url = process.env.NIKA_URL;
  const token = process.env.NIKA_TOKEN;
  if (url && !token) {
    console.error('NIKA_URL needs NIKA_TOKEN (the bearer token of the server\'s --token-file)');
    return 64;
  }
  const nika = url && token
    // Plain HTTP stays limited to a loopback server (a local `nika serve`).
    ? new Nika({ url, token, allowInsecureHttp: url.startsWith('http://') })
    : new Nika();

  // A provider call is opted into explicitly, per door; otherwise compile is deterministic.
  const maxCalls = process.env.NIKA_MAX_CALLS ? Number(process.env.NIKA_MAX_CALLS) : undefined;
  const limits = maxCalls === undefined ? {} : { limits: { max_calls: maxCalls } };
  let request: NikaCompileRequest = { intent };
  if (url && process.env.NIKA_EXPLICIT_PROVIDER === '1') {
    request = { intent, cognition: 'explicitProvider', ...limits };
  } else if (!url && process.env.NIKA_AUTHORING_MODEL) {
    request = { intent, authoringModel: process.env.NIKA_AUTHORING_MODEL, ...limits };
  }

  const given = new Set<string>();
  let outcome = await nika.compile(request);
  for (let round = 1; !outcome.ready; round += 1) {
    report(outcome);
    if (isNikaCompileHeld(outcome)) {
      // The verifier did not accept these bytes: show them at most, never run them.
      console.error('the verifier held the candidate: it is a preview, not a workflow to run');
      return 2;
    }
    if (outcome.status === 'refused') return 2;
    const reply: Record<string, unknown> = {};
    for (const question of outcome.questions) {
      if (Object.hasOwn(known, question.key) && !given.has(question.key)) {
        reply[question.key] = known[question.key];
      }
    }
    if (Object.keys(reply).length === 0 || round > MAX_ROUNDS) {
      const missing = outcome.questions.filter((question) => !Object.hasOwn(known, question.key));
      console.error(missing.length > 0
        ? `add these keys to ${answersFile}: ${missing.map((question) => question.key).join(', ')}`
        : 'nothing left to answer from the file; read the diagnostics above');
      return 2;
    }
    for (const key of Object.keys(reply)) given.add(key);
    // Over HTTP, a provider round that kept its plan gets its judged answer round
    // (the seat judges the replayed candidate; no second authoring call). Locally
    // the engine replays the plan it recorded under .nika/compile/.
    request = nextCompileRequest(request, outcome, reply);
    outcome = await nika.compile(request);
  }
  report(outcome);

  // Only a ready outcome proposes a candidate. It is source: materialize it,
  // then run() admits it again exactly like any other workflow file.
  const target = path.resolve(outputFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, outcome.candidate ?? '');
  console.log(`wrote ${target}`);

  // An absolute path is a local file on both transports. Over HTTP the
  // admission needs an idempotency key: a real application persists it before
  // admission and reuses it to retry an uncertain request.
  const run = await nika.run(target, url ? { idempotencyKey: randomUUID() } : {});
  for await (const event of run.events()) {
    console.log(`event · ${event.kind}${event.status === undefined ? '' : ` · ${event.status}`}`);
  }
  const result = await run.result();
  console.log(`run · ${result.status} · outputs ${JSON.stringify(result.outputs ?? {})}`);
  return isNikaRunSucceeded(result) ? 0 : 1;
}

function report(outcome: NikaCompileOutcome): void {
  const receipt = outcome.provenance.authoring;
  console.log(`compile · ${outcome.status} · generation ${outcome.compile_version} · `
    + (receipt ? `${receipt.calls} provider call(s) by ${receipt.model}` : 'no provider call'));
  for (const question of outcome.questions) {
    const options = question.options ? ` · one of ${question.options.map((option) => option.key).join(', ')}` : '';
    console.log(`? ${question.key}${question.mandatory ? '' : ' (optional)'} · ${question.label}${options}`);
  }
  for (const diagnostic of outcome.diagnostics) {
    console.log(`${diagnostic.kind} · ${diagnostic.target} · ${diagnostic.message}`);
  }
}

// Every SDK failure is typed (NikaOperationError carries the engine's code).
process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  return 1;
});
