import type { NikaProtocolError } from '../errors.js';
import { machineObject } from './machine.js';

/**
 * The revision, creation, reuse and intelligence evidence a compile
 * outcome's provenance may carry, judged where it is: `provenance.plan`
 * (`source_revision`, `intent_sha256`, `document_revision`, `document`,
 * `document_create`), `provenance.decision` (`document_revision`,
 * `document_create`, `knowledge_qualification.reuse`) and
 * `provenance.authoring.backend`.
 *
 * Producers (engine carrier 7d98023f9): `nika-compile-seats`
 * `foundry/document.rs::record`, `foundry/instance.rs` (expansion receipt),
 * `foundry/invoke.rs` (invocation receipt), `foundry/witness.rs` (witness,
 * reuse, rebinding) and `foundry.rs::reused`; the backend of `nika-providers`
 * `authoring.rs::authoring_backend`, `nika-cli-host` `compile/authoring.rs`,
 * `nika-serve` `compile/author.rs` (documented in its `openapi-native.json`)
 * and the `nika-harness` descriptors. The 0.123 complete-document creation:
 * `nika-compile-cognition` `document_create.rs::record` and `::bind`, whose
 * `plan.document` the engine reads as program history from `09234bce8` on.
 *
 * Every record is optional: an outcome without it (an older engine, a
 * deterministic round, a door that made none) is judged exactly as before.
 * Within a
 * present record, the members its producer always writes that identify or
 * bind the evidence (digests, ids, mode, ordered changes, bindings, counts)
 * are required, and every other known member is checked when present. `null`
 * is accepted only where the producer can write it. Anything else is a
 * protocol fault naming the member's path, never its value or a key the
 * candidate chose.
 *
 * The validator copies, rebuilds, compares and corrects nothing: unknown
 * members and new vocabulary words ride through, the caller receives the
 * engine's own objects, and no digest is recomputed against the candidate.
 * Whether the plan's and the decision's revision agree, or a digest matches
 * the candidate's bytes, is the caller's check to make.
 */

type Protocol = (message: string) => NikaProtocolError;

/** The engine's sha256: 32 bytes as lowercase hex (`nika-compile` `surface::sha256`). */
const SHA256 = /^[0-9a-f]{64}$/;

export function validateCompileEvidence(provenance: Record<string, unknown>, protocol: Protocol): void {
  const judge = new Judge(protocol);
  const plan = machineObject(provenance.plan);
  if (plan) {
    const at = 'provenance.plan';
    judge.optional(plan, 'source_revision', at, (value, path) => judge.sourceRevision(value, path));
    judge.optional(plan, 'intent_sha256', at, (value, path) => judge.digest(value, path));
    judge.optional(plan, 'document_revision', at, (value, path) => judge.documentRevision(value, path));
    judge.optional(plan, 'document', at, (value, path) => judge.createdDocument(value, path));
    judge.optional(plan, 'document_create', at, (value, path) => judge.createSection(value, path));
  }
  const decision = machineObject(provenance.decision);
  if (decision) {
    const at = 'provenance.decision';
    judge.optional(decision, 'document_revision', at, (value, path) => judge.documentRevision(value, path));
    judge.optional(decision, 'document_create', at, (value, path) => judge.documentCreate(value, path));
    judge.optional(decision, 'knowledge_qualification', at, (value, path) => {
      const qualification = judge.record(value, path);
      judge.optional(qualification, 'reuse', path, (reuse, at) => judge.reuse(reuse, at));
    });
  }
  const authoring = machineObject(provenance.authoring);
  if (authoring && authoring.backend !== null && authoring.backend !== undefined) {
    judge.backend(authoring.backend, 'provenance.authoring.backend');
  }
}

class Judge {
  constructor(private readonly protocol: Protocol) {}

  error(path: string, what: string): NikaProtocolError {
    return this.protocol(`${path} ${what}`);
  }

  /** Check a member only when its record carries it (an own member, even `null`). */
  optional(
    record: Record<string, unknown>,
    key: string,
    at: string,
    check: (value: unknown, path: string) => void,
  ): void {
    if (Object.hasOwn(record, key)) check(record[key], `${at}.${key}`);
  }

  /** Check a member its record must carry. */
  required(
    record: Record<string, unknown>,
    key: string,
    at: string,
    check: (value: unknown, path: string) => void,
  ): void {
    if (!Object.hasOwn(record, key)) throw this.error(`${at}.${key}`, 'is absent');
    check(record[key], `${at}.${key}`);
  }

  record(value: unknown, path: string): Record<string, unknown> {
    const object = machineObject(value);
    if (!object) throw this.error(path, 'is not an object');
    return object;
  }

  text(value: unknown, path: string, nullable = false): void {
    if (typeof value === 'string' || (nullable && value === null)) return;
    throw this.error(path, nullable ? 'is neither text nor null' : 'is not text');
  }

  flag(value: unknown, path: string, nullable = false): void {
    if (typeof value === 'boolean' || (nullable && value === null)) return;
    throw this.error(path, nullable ? 'is neither a boolean nor null' : 'is not a boolean');
  }

  count(value: unknown, path: string, nullable = false): void {
    if ((nullable && value === null)
      || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return;
    throw this.error(path, nullable ? 'is neither a count nor null' : 'is not a count');
  }

  digest(value: unknown, path: string, nullable = false): void {
    if ((nullable && value === null) || (typeof value === 'string' && SHA256.test(value))) return;
    throw this.error(path, nullable ? 'is neither a sha256 digest nor null' : 'is not a sha256 digest');
  }

  texts(value: unknown, path: string): void {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      throw this.error(path, 'is not a list of text');
    }
  }

  objects(value: unknown, path: string): void {
    if (!Array.isArray(value) || !value.every((entry) => machineObject(entry) !== undefined)) {
      throw this.error(path, 'is not a list of objects');
    }
  }

  list(value: unknown, path: string, each: (entry: unknown, path: string) => void): void {
    if (!Array.isArray(value)) throw this.error(path, 'is not a list');
    value.forEach((entry, index) => each(entry, `${path}[${index}]`));
  }

  /** `source_revision`: the digests of the bytes revised and written, and the words they answer. */
  sourceRevision(value: unknown, path: string): void {
    const revision = this.record(value, path);
    this.required(revision, 'base_sha256', path, (digest, at) => this.digest(digest, at));
    this.required(revision, 'candidate_sha256', path, (digest, at) => this.digest(digest, at));
    this.optional(revision, 'resolved', path, (words, at) => this.text(words, at));
  }

  /** `document_revision` (`foundry/document.rs::record`). */
  documentRevision(value: unknown, path: string): void {
    const revision = this.record(value, path);
    this.required(revision, 'mode', path, (mode, at) => this.text(mode, at));
    this.required(revision, 'base_sha256', path, (digest, at) => this.digest(digest, at));
    this.required(revision, 'candidate_sha256', path, (digest, at) => this.digest(digest, at));
    this.required(revision, 'changed', path, (changed, at) => this.texts(changed, at));
    this.required(revision, 'components', path, (components, at) => this.receipts(components, at));
    this.optional(revision, 'route', path, (route, at) => this.text(route, at));
    this.optional(revision, 'preservation', path, (words, at) => this.text(words, at));
  }

  /**
   * `plan.document`: a created document's settled record
   * (`document_create.rs::bind`). Version 1's members are the ones known
   * here; a record of another version rides through as written.
   */
  createdDocument(value: unknown, path: string): void {
    const document = this.record(value, path);
    this.required(document, 'version', path, (version, at) => this.count(version, at));
    if (document.version !== 1) return;
    this.required(document, 'candidate_sha256', path, (digest, at) => this.digest(digest, at));
    this.required(document, 'request', path, (request, at) => this.text(request, at));
    this.required(document, 'base_sha256', path, (digest, at) => this.digest(digest, at, true));
    this.required(document, 'mode', path, (mode, at) => this.text(mode, at));
    this.required(document, 'components', path, (components, at) => this.receipts(components, at));
  }

  /** `plan.document_create`: the section a creation's answer rounds replay (`document_create.rs::record`). */
  createSection(value: unknown, path: string): void {
    const section = this.record(value, path);
    this.required(section, 'mode', path, (mode, at) => this.text(mode, at));
    this.required(section, 'changed', path, (changed, at) => this.texts(changed, at));
    this.required(section, 'components', path, (components, at) => this.receipts(components, at));
    for (const key of ['route', 'resolved', 'preservation']) {
      this.optional(section, key, path, (member, at) => this.text(member, at));
    }
  }

  /** `decision.document_create`: how the door made the document (`document_create.rs::record`). */
  documentCreate(value: unknown, path: string): void {
    const made = this.record(value, path);
    this.required(made, 'mode', path, (mode, at) => this.text(mode, at));
    this.required(made, 'base_sha256', path, (digest, at) => this.digest(digest, at, true));
    this.required(made, 'candidate_sha256', path, (digest, at) => this.digest(digest, at, true));
    this.required(made, 'operations', path, (count, at) => this.count(count, at));
    this.required(made, 'changed', path, (changed, at) => this.texts(changed, at));
    this.required(made, 'components', path, (components, at) => this.receipts(components, at));
    this.optional(made, 'route', path, (route, at) => this.text(route, at));
    this.optional(made, 'preservation', path, (words, at) => this.text(words, at));
    this.optional(made, 'reuse', path, (reuse, at) => this.reuse(reuse, at));
  }

  receipts(value: unknown, path: string): void {
    this.list(value, path, (receipt, entry) => this.receipt(receipt, entry));
  }

  /** An expansion or invocation receipt (`foundry/instance.rs`, `foundry/invoke.rs`). */
  receipt(value: unknown, path: string): void {
    const receipt = this.record(value, path);
    this.required(receipt, 'component', path, (component, at) => this.identity(component, at));
    this.required(receipt, 'bindings', path, (bindings, at) =>
      this.list(bindings, at, (binding, entry) => this.binding(binding, entry)));
    this.required(receipt, 'nodes', path, (nodes, at) => this.nodes(nodes, at));
    this.required(receipt, 'candidate_sha256', path, (digest, at) => this.digest(digest, at));
    this.optional(receipt, 'law', path, (law, at) => this.text(law, at));
    this.optional(receipt, 'open', path, (open, at) => this.texts(open, at));
    this.optional(receipt, 'not_inherited', path, (facts, at) => this.record(facts, at));
    this.optional(receipt, 'authority', path, (facts, at) => this.record(facts, at));
    this.optional(receipt, 'check', path, (check, at) => this.check(check, at));
    this.optional(receipt, 'invocation', path, (invocation, at) => {
      const call = this.record(invocation, at);
      this.required(call, 'task', at, (task, member) => this.text(task, member));
      this.required(call, 'workflow', at, (workflow, member) => this.text(workflow, member));
    });
    this.optional(receipt, 'child', path, (child, at) => this.child(child, at));
    this.optional(receipt, 'revises', path, (digest, at) => this.digest(digest, at, true));
  }

  /** A component's identity as a receipt names it (`foundry/component.rs::Component::record`). */
  identity(value: unknown, path: string): void {
    const component = this.record(value, path);
    this.required(component, 'id', path, (id, at) => this.text(id, at));
    this.optional(component, 'release', path, (release, at) => this.release(release, at));
    for (const key of ['row_sha256', 'file', 'file_sha256', 'status', 'proof_level']) {
      this.optional(component, key, path, (member, at) => this.text(member, at));
    }
  }

  release(value: unknown, path: string): void {
    const release = this.record(value, path);
    for (const key of ['version', 'snapshot_sha256', 'profile']) {
      this.optional(release, key, path, (member, at) => this.text(member, at));
    }
  }

  /** One bound hole (`Instance::bindings_record`): the bound literal may be any JSON value. */
  binding(value: unknown, path: string): void {
    const binding = this.record(value, path);
    this.required(binding, 'path', path, (hole, at) => this.text(hole, at));
    this.required(binding, 'bound', path, () => {});
    this.optional(binding, 'hole', path, (hole, at) => this.text(hole, at, true));
    this.optional(binding, 'owner', path, (owner, at) => this.text(owner, at, true));
  }

  /** Node digests by section and name; a node the expansion did not hold is `null`. */
  nodes(value: unknown, path: string): void {
    for (const section of Object.values(this.record(value, path))) {
      const names = machineObject(section);
      if (!names) throw this.error(path, 'has a section that is not an object');
      for (const digest of Object.values(names)) {
        if (digest !== null && !(typeof digest === 'string' && SHA256.test(digest))) {
          throw this.error(path, 'holds a node digest that is neither a sha256 digest nor null');
        }
      }
    }
  }

  check(value: unknown, path: string): void {
    const check = this.record(value, path);
    this.optional(check, 'ready', path, (ready, at) => this.flag(ready, at));
    this.optional(check, 'findings', path, (findings, at) => this.objects(findings, at));
    this.optional(check, 'diagnostics', path, (diagnostics, at) => this.objects(diagnostics, at));
  }

  /** The child program of an invocation, witnessed apart from its calling task. */
  child(value: unknown, path: string): void {
    const child = this.record(value, path);
    this.optional(child, 'component', path, (component, at) => {
      const named = this.record(component, at);
      this.optional(named, 'id', at, (id, member) => this.text(id, member));
    });
    this.optional(child, 'nodes', path, (nodes, at) => this.nodes(nodes, at));
    this.optional(child, 'bindings', path, (bindings, at) =>
      this.list(bindings, at, (binding, entry) => this.binding(binding, entry)));
    this.optional(child, 'candidate_sha256', path, (digest, at) => this.digest(digest, at));
    this.optional(child, 'check', path, (check, at) => this.check(check, at));
  }

  /** `knowledge_qualification.reuse` (`foundry/witness.rs::reuse`). */
  reuse(value: unknown, path: string): void {
    const reuse = this.record(value, path);
    for (const key of ['expanded', 'invoked', 'revised', 'absent', 'consulted']) {
      this.required(reuse, key, path, (count, at) => this.count(count, at));
    }
    this.required(reuse, 'references', path, (references, at) =>
      this.list(references, at, (reference, entry) => this.reference(reference, entry)));
    this.optional(reuse, 'law', path, (law, at) => this.text(law, at));
  }

  reference(value: unknown, path: string): void {
    const reference = this.record(value, path);
    this.required(reference, 'id', path, (id, at) => this.text(id, at, true));
    this.required(reference, 'use', path, (use, at) => this.text(use, at));
    this.optional(reference, 'kind', path, (kind, at) => this.text(kind, at));
    this.optional(reference, 'witness', path, (witness, at) => this.witness(witness, at));
  }

  /** What one candidate holds of one receipt (`foundry/witness.rs::witness`). */
  witness(value: unknown, path: string): void {
    const witness = this.record(value, path);
    this.required(witness, 'component', path, (id, at) => this.text(id, at, true));
    this.required(witness, 'verdict', path, (verdict, at) => this.text(verdict, at));
    this.optional(witness, 'release', path, (release, at) => {
      if (release !== null) this.release(release, at);
    });
    this.optional(witness, 'workflow', path, (workflow, at) => this.text(workflow, at, true));
    this.optional(witness, 'candidate_sha256', path, (digest, at) => this.digest(digest, at));
    this.optional(witness, 'receipt_candidate_sha256', path, (digest, at) => this.digest(digest, at, true));
    this.optional(witness, 'nodes', path, (nodes, at) => {
      const found = this.record(nodes, at);
      for (const key of ['kept', 'changed', 'missing']) {
        this.required(found, key, at, (paths, member) => this.texts(paths, member));
      }
    });
    this.optional(witness, 'bindings_not_held', path, (paths, at) => this.texts(paths, at));
  }

  /** `provenance.authoring.backend`: each model identity checked as the separate fact it is. */
  backend(value: unknown, path: string): void {
    const backend = this.record(value, path);
    for (const key of ['kind', 'forwarded_model', 'decision_model', 'endpoint_basis', 'cost_basis']) {
      this.optional(backend, key, path, (member, at) => this.text(member, at));
    }
    for (const key of ['provider', 'requested_model', 'host', 'served_model']) {
      this.optional(backend, key, path, (member, at) => this.text(member, at, true));
    }
    this.optional(backend, 'base_url_overridden', path, (member, at) => this.flag(member, at, true));
    for (const key of ['usage_complete', 'numeric_usage_reported']) {
      this.optional(backend, key, path, (member, at) => this.flag(member, at));
    }
    this.optional(backend, 'observed_models', path, (models, at) => this.texts(models, at));
    this.optional(backend, 'unreported_models', path, (count, at) => this.count(count, at));
    this.optional(backend, 'observed', path, (rows, at) => this.objects(rows, at));
    this.optional(backend, 'billed_cost_usd', path, (amount, at) => {
      if (amount !== null && !(typeof amount === 'number' && Number.isFinite(amount))) {
        throw this.error(at, 'is neither a number nor null');
      }
    });
    this.optional(backend, 'authority', path, (authority, at) => this.authority(authority, at));
  }

  /** The request authority's account (`nika-compile-cognition` `authority.rs::record`). */
  authority(value: unknown, path: string): void {
    const authority = this.record(value, path);
    this.optional(authority, 'max_calls', path, (bound, at) => this.count(bound, at, true));
    this.optional(authority, 'source', path, (source, at) => this.text(source, at));
    this.optional(authority, 'decision_seat', path, (note, at) => this.text(note, at));
    this.optional(authority, 'configured', path, (configured, at) => this.record(configured, at));
    this.optional(authority, 'invocations', path, (invocations, at) => {
      const account = this.record(invocations, at);
      this.required(account, 'sent', at, (count, member) => this.count(count, member));
      this.required(account, 'refused', at, (count, member) => this.count(count, member));
    });
    this.optional(authority, 'http_requests', path, (requests, at) => {
      const account = this.record(requests, at);
      this.optional(account, 'sent', at, (count, member) => this.count(count, member, true));
      this.optional(account, 'refused', at, (count, member) => this.count(count, member, true));
      this.optional(account, 'unknown', at, (reason, member) => this.text(reason, member, true));
    });
  }
}
