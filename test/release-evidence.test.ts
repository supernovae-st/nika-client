import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseEvidence } from '../scripts/verify-release-evidence.mjs';

const ENGINE = 'nika 0.116.2 (c4cdbeafb)';
const PACKAGE = 'supernovae-st-nika-client-0.116.2.tgz';
const currentEvidence = [
  'gauntlet/projects-depth/results.json',
  'gauntlet/results/hostile.json',
  'gauntlet/results/local-execution.json',
  'gauntlet/results/mini-saas.json',
  'gauntlet/results/recovery-e2e.json',
];
const packedEvidence = new Set([
  'gauntlet/projects-depth/results.json',
  'gauntlet/results/mini-saas.json',
  'gauntlet/results/recovery-e2e.json',
]);
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release evidence identity', () => {
  it('binds synthetic release-gate records to their package version and one engine', () => {
    expect(verifyReleaseEvidence(createFixture())).toEqual({
      version: '0.116.2',
      engine: ENGINE,
      package: PACKAGE,
      currentFiles: 5,
      historicalFiles: 0,
    });
  });

  it('refuses stale engine evidence', () => {
    const fixture = createFixture();
    writeJson(fixture, 'gauntlet/results/local-execution.json', {
      schema_version: 1,
      engine: 'nika 0.116.0 (b38267751)',
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      'records engine 0.116.0, expected package version 0.116.2',
    );
  });

  it('refuses a stale packed-package identity', () => {
    const fixture = createFixture();
    writeJson(fixture, 'gauntlet/results/mini-saas.json', {
      schema_version: 1,
      engine: ENGINE,
      package: 'supernovae-st-nika-client-0.116.0.tgz',
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      `records package supernovae-st-nika-client-0.116.0.tgz, expected ${PACKAGE}`,
    );
  });

  it('refuses empty or red mini-SaaS evidence with a current identity', () => {
    const fixture = createFixture();
    writeJson(fixture, 'gauntlet/results/mini-saas.json', {
      schema_version: 1,
      engine: ENGINE,
      package: PACKAGE,
      projects: [],
      result: 'red',
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      'does not record 5 packed projects',
    );
  });

  it('refuses a failed depth summary with a current identity', () => {
    const fixture = createFixture();
    const projects = packedProjects([
      'deployment-gate',
      'evidence-provenance-pipeline',
      'incident-response-controller',
      'multi-tenant-webhook-router',
      'scheduled-research-monitor',
    ]);
    writeJson(fixture, 'gauntlet/projects-depth/results.json', {
      schema_version: 1,
      engine: ENGINE,
      package: PACKAGE,
      projects,
      summary: { total: 5, succeeded: 0, result: 'red' },
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      'does not record a 5/5 green summary',
    );
  });

  it('refuses one-process or unpacked recovery evidence', () => {
    const fixture = createFixture();
    writeJson(fixture, 'gauntlet/results/recovery-e2e.json', {
      schema_version: 1,
      engine: ENGINE,
      package: PACKAGE,
      process_count: 1,
      installed_from_pack: false,
      status: 'failed',
      resumed_sequences: [],
      duplicate_sequences: [1],
      job_id: 'not-a-uuid',
    });

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      'does not record successful duplicate-free two-process recovery',
    );
  });

  it('refuses contradictory depth cancellation event evidence', () => {
    const fixture = createFixture();
    const evidence = evidenceFor('gauntlet/projects-depth/results.json') as any;
    const incident = evidence.projects.find(
      (project: any) => project.project === 'incident-response-controller',
    );
    incident.sse_terminal.kind = 'execution.settled';
    writeJson(fixture, 'gauntlet/projects-depth/results.json', evidence);

    expect(() => verifyReleaseEvidence(fixture)).toThrow(
      'has contradictory cancellation event evidence',
    );
  });
});

function createFixture(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), 'nika-release-evidence-'));
  scratch.push(fixture);
  writeJson(fixture, 'package.json', { version: '0.116.2' });
  for (const relativePath of currentEvidence) {
    writeJson(fixture, relativePath, evidenceFor(relativePath));
  }
  const reportPath = path.join(fixture, 'gauntlet/projects-depth/REPORT.md');
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `engine \`${ENGINE}\` with \`${PACKAGE}\`\n`);
  return fixture;
}

function evidenceFor(relativePath: string): object {
  const identity = {
    schema_version: 1,
    engine: ENGINE,
    ...(packedEvidence.has(relativePath) ? { package: PACKAGE } : {}),
  };
  if (relativePath === 'gauntlet/results/mini-saas.json') {
    return {
      ...identity,
      projects: packedProjects([
        'commerce-enrichment',
        'document-evidence',
        'operator-console',
        'research-monitor',
        'support-webhook',
      ]),
      result: 'green',
    };
  }
  if (relativePath === 'gauntlet/projects-depth/results.json') {
    const projects = packedProjects([
      'deployment-gate',
      'evidence-provenance-pipeline',
      'incident-response-controller',
      'multi-tenant-webhook-router',
      'scheduled-research-monitor',
    ]).map((project: any) => project.project === 'incident-response-controller'
      ? {
          ...project,
          sse_event_kinds: ['execution.cancelled', 'execution.started'],
          sse_terminal: { kind: 'execution.cancelled', status: 'cancelled' },
        }
      : project);
    return {
      ...identity,
      projects,
      summary: { total: 5, succeeded: 5, result: 'green' },
    };
  }
  if (relativePath === 'gauntlet/results/recovery-e2e.json') {
    return {
      ...identity,
      process_count: 2,
      installed_from_pack: true,
      status: 'succeeded',
      resumed_sequences: [2],
      duplicate_sequences: [],
      job_id: '41b407c3-cc3e-4b08-9aeb-23cc2815034b',
    };
  }
  return identity;
}

function packedProjects(names: string[]): object[] {
  return names.map((project) => ({ project, status: 'succeeded', installed_from_pack: true }));
}

function writeJson(root: string, relativePath: string, value: object): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}
