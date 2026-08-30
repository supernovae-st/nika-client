import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = join(root, "gauntlet", "corpus");
const workflowsRoot = join(corpusRoot, "workflows");

const domains = [
  {
    id: "customer-support",
    label: "customer support",
    actors: ["support lead", "queue manager", "escalation manager", "support analyst", "customer advocate"],
    cases: ["sla-breach-triage", "duplicate-ticket-diff", "escalation-readiness", "queue-batch-enrichment", "resolution-receipt"],
  },
  {
    id: "commerce",
    label: "commerce operations",
    actors: ["refund specialist", "inventory planner", "catalog manager", "store operator", "pricing controller"],
    cases: ["refund-policy-validation", "inventory-delta", "catalog-merge", "stockout-window", "price-change-event"],
  },
  {
    id: "finance",
    label: "finance operations",
    actors: ["accounts payable clerk", "treasury analyst", "expense controller", "cash manager", "financial controller"],
    cases: ["invoice-schema-guard", "payment-reconciliation", "expense-policy-merge", "cashflow-window", "close-receipt"],
  },
  {
    id: "people",
    label: "people operations",
    actors: ["recruiter", "compensation partner", "people coordinator", "people partner", "identity administrator"],
    cases: ["candidate-intake", "offer-diff", "onboarding-merge", "probation-window", "access-event"],
  },
  {
    id: "legal",
    label: "legal operations",
    actors: ["contract analyst", "legal counsel", "policy owner", "renewal manager", "signature coordinator"],
    cases: ["clause-schema-guard", "redline-diff", "fallback-merge", "renewal-window", "signature-event"],
  },
  {
    id: "clinic-admin",
    label: "clinic administration",
    actors: ["referral coordinator", "appointment coordinator", "care administrator", "followup coordinator", "handoff nurse"],
    cases: ["referral-guard", "appointment-diff", "care-instructions-merge", "followup-window", "handoff-event"],
  },
  {
    id: "education",
    label: "education operations",
    actors: ["registrar", "teacher", "learning coordinator", "course lead", "credential officer"],
    cases: ["enrollment-guard", "rubric-diff", "learning-plan-merge", "assignment-window", "completion-event"],
  },
  {
    id: "logistics",
    label: "logistics",
    actors: ["dispatch operator", "route planner", "exception manager", "delivery coordinator", "proof clerk"],
    cases: ["shipment-guard", "route-diff", "exception-merge", "delivery-window", "proof-event"],
  },
  {
    id: "real-estate",
    label: "real estate operations",
    actors: ["lead coordinator", "lease manager", "listing agent", "inspection coordinator", "handover manager"],
    cases: ["lead-guard", "lease-diff", "listing-merge", "inspection-window", "handover-event"],
  },
  {
    id: "travel",
    label: "travel operations",
    actors: ["booking agent", "travel designer", "disruption agent", "airport coordinator", "voucher controller"],
    cases: ["booking-guard", "itinerary-diff", "disruption-merge", "checkin-window", "voucher-event"],
  },
  {
    id: "marketing",
    label: "marketing",
    actors: ["campaign strategist", "growth analyst", "audience manager", "launch manager", "attribution analyst"],
    cases: ["brief-guard", "campaign-diff", "audience-merge", "launch-window", "attribution-event"],
  },
  {
    id: "engineering",
    label: "software engineering",
    actors: ["triage engineer", "platform engineer", "release engineer", "incident commander", "deployment controller"],
    cases: ["issue-guard", "config-diff", "release-merge", "incident-window", "deployment-event"],
  },
  {
    id: "security",
    label: "security operations",
    actors: ["soc analyst", "security architect", "risk owner", "remediation lead", "audit lead"],
    cases: ["alert-guard", "policy-diff", "exception-merge", "remediation-window", "audit-event"],
  },
  {
    id: "operations",
    label: "business operations",
    actors: ["request coordinator", "workforce planner", "runbook owner", "maintenance planner", "operations lead"],
    cases: ["request-guard", "roster-diff", "runbook-merge", "maintenance-window", "completion-event"],
  },
  {
    id: "media",
    label: "media production",
    actors: ["asset producer", "editor", "metadata editor", "publishing producer", "rights manager"],
    cases: ["asset-guard", "transcript-diff", "metadata-merge", "publish-window", "rights-event"],
  },
  {
    id: "nonprofit",
    label: "nonprofit operations",
    actors: ["donor coordinator", "fundraising analyst", "grant manager", "campaign manager", "impact officer"],
    cases: ["donor-guard", "pledge-diff", "grant-merge", "campaign-window", "impact-event"],
  },
  {
    id: "hospitality",
    label: "hospitality",
    actors: ["reservation agent", "rooms controller", "guest services lead", "front desk lead", "experience manager"],
    cases: ["reservation-guard", "room-diff", "service-merge", "checkout-window", "stay-event"],
  },
  {
    id: "manufacturing",
    label: "manufacturing",
    actors: ["production planner", "bom engineer", "quality engineer", "maintenance lead", "batch controller"],
    cases: ["workorder-guard", "bom-diff", "quality-merge", "maintenance-window", "batch-event"],
  },
  {
    id: "research",
    label: "research operations",
    actors: ["protocol reviewer", "research analyst", "data steward", "review chair", "provenance curator"],
    cases: ["protocol-guard", "evidence-diff", "dataset-merge", "review-window", "provenance-event"],
  },
  {
    id: "creator",
    label: "creator business",
    actors: ["partnership manager", "content editor", "channel manager", "publishing lead", "royalty analyst"],
    cases: ["sponsorship-guard", "draft-diff", "content-merge", "publish-window", "royalty-event"],
  },
];

const recipeNames = [
  "project-record",
  "validate-contract",
  "diff-revisions",
  "merge-policy",
  "hash-evidence",
  "measure-window",
  "batch-enrich",
  "parallel-reconcile",
  "threshold-gate",
  "emit-receipt",
];

const toolSets = [
  ["nika:jq"],
  ["nika:validate"],
  ["nika:json_diff"],
  ["nika:json_merge_patch", "nika:jq"],
  ["nika:hash", "nika:log"],
  ["nika:date"],
  ["nika:jq"],
  ["nika:jq"],
  ["nika:jq", "nika:log"],
  ["nika:emit"],
];

const oracles = [
  "projection carries the domain, actor, and accepted state",
  "validation report is valid with zero errors",
  "revision patch is non-empty and points at the changed value",
  "merged policy is approved and keeps the original identifier",
  "evidence digest is stable and is logged without source disclosure",
  "measured duration is positive and uses fixed ISO timestamps",
  "all three batch items return in input order with checked=true",
  "parallel branches reconcile into one object with both values",
  "threshold result is true and the admitted branch emits one log",
  "one typed machine event carries the case identity and accepted state",
];

const outcomes = [
  "produce a normalized decision card",
  "refuse malformed business input before downstream work",
  "explain exactly what changed between two business revisions",
  "apply an approved override without losing the base record",
  "mint a stable evidence identifier for later reconciliation",
  "calculate an operational service window without ambient time",
  "enrich a bounded batch while preserving source order",
  "reconcile two independent operational observations",
  "open an action only when a deterministic threshold is met",
  "publish a typed completion receipt for subscribers",
];

const json = (value) => JSON.stringify(value);

function header(entry) {
  return `# SPDX-License-Identifier: Apache-2.0
# yaml-language-server: $schema=https://nika.sh/spec/v1/workflow.schema.json
# Corpus case ${entry.number}/100 · ${entry.domain_label} · ${entry.case}
# Actor: ${entry.actor}
# Trigger: ${entry.trigger}
# Authority: ${entry.authority}
# Failure oracle: ${entry.failure_oracle}
# Business outcome: ${entry.business_outcome}
`;
}

function workflow(entry, recipe) {
  const base = `${header(entry)}
nika: ${entry.id}

model: mock/echo

`;
  const record = {
    case: entry.case,
    domain: entry.domain,
    actor: entry.actor,
    metric: entry.number + 20,
    threshold: entry.number,
    state: "accepted",
  };

  if (recipe === 0) {
    return `${base}const:
  record: ${json(record)}
permits:
  tools: ["nika:jq"]
tasks:
  project:
    invoke:
      tool: "nika:jq"
      args:
        input: \${{ const.record }}
        expression: '{case, domain, actor, state}'
outputs:
  card: \${{ tasks.project.output }}
`;
  }

  if (recipe === 1) {
    return `${base}const:
  record: ${json({ key: entry.id, amount: entry.number + 100, status: "ready" })}
permits:
  tools: ["nika:validate"]
tasks:
  validate:
    invoke:
      tool: "nika:validate"
      args:
        data: \${{ const.record }}
        schema:
          type: object
          additionalProperties: false
          required: [key, amount, status]
          properties:
            key: { type: string }
            amount: { type: integer, minimum: 1 }
            status: { type: string, enum: [ready] }
outputs:
  report: \${{ tasks.validate.output }}
  record: \${{ const.record }}
`;
  }

  if (recipe === 2) {
    return `${base}const:
  before: ${json({ id: entry.id, value: entry.number, state: "draft" })}
  after: ${json({ id: entry.id, value: entry.number + 1, state: "approved" })}
permits:
  tools: ["nika:json_diff"]
tasks:
  diff:
    invoke:
      tool: "nika:json_diff"
      args:
        before: \${{ const.before }}
        after: \${{ const.after }}
outputs:
  patch: \${{ tasks.diff.output }}
`;
  }

  if (recipe === 3) {
    return `${base}const:
  base: ${json({ id: entry.id, owner: entry.actor, state: "draft", value: entry.number })}
  patch: ${json({ state: "approved", value: entry.number + 10 })}
permits:
  tools: ["nika:json_merge_patch", "nika:jq"]
tasks:
  merge:
    invoke:
      tool: "nika:json_merge_patch"
      args:
        target: \${{ const.base }}
        patch: \${{ const.patch }}
  project:
    with:
      merged: \${{ tasks.merge.output }}
    invoke:
      tool: "nika:jq"
      args:
        input: \${{ with.merged }}
        expression: '{id, owner, state, value, ready: (.state == "approved")}'
outputs:
  merged: \${{ tasks.project.output }}
`;
  }

  if (recipe === 4) {
    return `${base}const:
  evidence: ${json({ id: entry.id, outcome: entry.business_outcome, accepted: true })}
permits:
  tools: ["nika:hash", "nika:log"]
tasks:
  digest:
    invoke:
      tool: "nika:hash"
      args:
        content: \${{ const.evidence }}
        algo: sha256
        encoding: hex
  announce:
    with:
      digest: \${{ tasks.digest.output }}
    invoke:
      tool: "nika:log"
      args:
        level: info
        message: "evidence sealed for ${entry.id}"
        data: { digest: "\${{ with.digest }}" }
outputs:
  digest: \${{ tasks.digest.output }}
`;
  }

  if (recipe === 5) {
    const day = String((entry.number % 20) + 1).padStart(2, "0");
    const later = String((entry.number % 20) + 2).padStart(2, "0");
    return `${base}const:
  case: "${entry.id}"
  start: "2026-08-${day}T09:00:00Z"
  end: "2026-08-${later}T17:00:00Z"
permits:
  tools: ["nika:date"]
tasks:
  duration:
    invoke:
      tool: "nika:date"
      args:
        op: diff
        start: \${{ const.start }}
        end: \${{ const.end }}
        unit: hours
outputs:
  case: \${{ const.case }}
  hours: \${{ tasks.duration.output }}
`;
  }

  if (recipe === 6) {
    return `${base}const:
  items: ${json([1, 2, 3].map((sequence) => ({ sequence, case: entry.case })))}
permits:
  tools: ["nika:jq"]
tasks:
  enrich:
    for_each:
      items: \${{ const.items }}
      max_parallel: 2
      fail_fast: true
    invoke:
      tool: "nika:jq"
      args:
        input: \${{ item }}
        expression: '. + {checked: true}'
outputs:
  rows: \${{ tasks.enrich.output }}
`;
  }

  if (recipe === 7) {
    return `${base}const:
  left: ${json({ source: "primary", value: entry.number })}
  right: ${json({ source: "secondary", value: entry.number + 1 })}
permits:
  tools: ["nika:jq"]
tasks:
  primary:
    invoke:
      tool: "nika:jq"
      args: { input: "\${{ const.left }}", expression: "." }
  secondary:
    invoke:
      tool: "nika:jq"
      args: { input: "\${{ const.right }}", expression: "." }
  reconcile:
    with:
      primary: \${{ tasks.primary.output }}
      secondary: \${{ tasks.secondary.output }}
    invoke:
      tool: "nika:jq"
      args:
        input:
          primary: \${{ with.primary }}
          secondary: \${{ with.secondary }}
        expression: '{primary: .primary.value, secondary: .secondary.value, delta: (.secondary.value - .primary.value)}'
outputs:
  reconciliation: \${{ tasks.reconcile.output }}
`;
  }

  if (recipe === 8) {
    return `${base}const:
  case: "${entry.id}"
  observation: ${json({ metric: entry.number + 20, threshold: entry.number })}
permits:
  tools: ["nika:jq", "nika:log"]
tasks:
  decide:
    invoke:
      tool: "nika:jq"
      args:
        input: \${{ const.observation }}
        expression: '.metric >= .threshold'
  admitted:
    with:
      decision: \${{ tasks.decide.output }}
    when: \${{ with.decision == true }}
    invoke:
      tool: "nika:log"
      args:
        level: info
        message: "threshold admitted ${entry.id}"
outputs:
  case: \${{ const.case }}
  admitted: \${{ tasks.decide.output }}
`;
  }

  return `${base}const:
  receipt: ${json({ case: entry.id, domain: entry.domain, state: "accepted" })}
permits:
  tools: ["nika:emit"]
tasks:
  publish:
    invoke:
      tool: "nika:emit"
      args:
        event_type: "gauntlet.${entry.domain}.${entry.case}"
        payload: \${{ const.receipt }}
outputs:
  receipt: \${{ const.receipt }}
`;
}

rmSync(corpusRoot, { force: true, recursive: true });
mkdirSync(workflowsRoot, { recursive: true });

const entries = [];
for (const [domainIndex, domain] of domains.entries()) {
  for (const [caseIndex, caseName] of domain.cases.entries()) {
    const number = domainIndex * 5 + caseIndex + 1;
    const recipe = (domainIndex * 5 + caseIndex) % recipeNames.length;
    const id = `uc-${String(number).padStart(3, "0")}-${domain.id}-${caseName}`;
    const entry = {
      number,
      id,
      domain: domain.id,
      domain_label: domain.label,
      case: caseName,
      actor: `${domain.actors[caseIndex]} for ${domain.label}`,
      trigger: `${caseName} request enters the ${domain.label} queue`,
      authority: `tools only: ${toolSets[recipe].join(", ")}; no filesystem, network, subprocess, secret, or ambient clock authority`,
      failure_oracle: `${oracles[recipe]} for ${id}`,
      business_outcome: `${outcomes[recipe]} for ${domain.label}`,
      recipe: recipeNames[recipe],
      workflow: `workflows/${id}.nika.yaml`,
    };
    entries.push(entry);
    writeFileSync(join(workflowsRoot, `${id}.nika.yaml`), workflow(entry, recipe));
  }
}

if (entries.length !== 100 || new Set(entries.map((entry) => entry.id)).size !== 100) {
  throw new Error(`corpus cardinality drift: ${entries.length}`);
}

writeFileSync(join(corpusRoot, "use-cases.json"), `${JSON.stringify(entries, null, 2)}\n`);
writeFileSync(
  join(corpusRoot, "README.md"),
  `# One SDK 100-case gauntlet corpus\n\nGenerated by \`npm run gauntlet:generate\`. The inventory is the claim: 20 domains, 100 unique ids, actors, triggers, failure oracles and business outcomes. The workflow files are deterministic, keyless programs for admission, execution, receipt and local/remote differential tests. Renamed prompts do not exist in this corpus.\n`,
);

console.log(`generated ${entries.length} workflows across ${domains.length} domains`);
