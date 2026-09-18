import { describe, expect, it } from 'vitest';
import {
  PROJECT_FILE,
  WORKFLOW_SUFFIX,
  isCanonicalWorkflowPath,
  isContainedWorkflowName,
  isLegacyContainedWorkflowName,
  isLegacyWorkflowPath,
  legacyWorkflowRenameMessage,
  renameLegacyWorkflow,
  workflowLogicalStem,
} from '../src/lib/workflow-name.js';

describe('SDK filename contract', () => {
  it('uses exact lowercase .nika', () => {
    expect(WORKFLOW_SUFFIX).toBe('.nika');
    expect(isCanonicalWorkflowPath('daily.nika')).toBe(true);
    expect(workflowLogicalStem('support.v2.nika')).toBe('support.v2');
  });

  it.each([
    'daily.nika',
    'nested/daily.nika',
    'support.v2.nika',
  ])('accepts contained name %s', (name) => {
    expect(isContainedWorkflowName(name)).toBe(true);
  });

  it.each([
    ['a relative path', './flow.nika'],
    ['a parent path', '../flow.nika'],
    ['an absolute path', '/srv/flow.nika'],
    ['a backslash path', 'dir\\flow.nika'],
    ['a name without the extension', 'flow.yaml'],
    ['project config', 'nika.yaml'],
    ['empty stem', '.nika'],
    ['uppercase suffix', 'flow.NIKA'],
    ['mixed suffix', 'flow.Nika'],
    ['lookalike', 'flow.nika.evil'],
    ['sidecar', 'flow.nika.minisig'],
    ['golden', 'flow.nika.golden.json'],
    ['directory form', 'flow.nika/'],
    ['old yaml alias', 'daily.nika.yaml'],
    ['old yml alias', 'daily.nika.yml'],
    ['query lookalike', 'daily.nika?evil'],
    ['hash lookalike', 'daily.nika#fragment'],
    ['DEL control', 'daily.nika\u007f'],
  ])('rejects %s as a contained registry name', (_name, workflow) => {
    expect(isContainedWorkflowName(workflow)).toBe(false);
  });

  it('classifies retired contained names for an actionable refusal', () => {
    expect(isLegacyContainedWorkflowName('daily.nika.yaml')).toBe(true);
    expect(isLegacyContainedWorkflowName('nested/daily.nika.yml')).toBe(true);
    expect(isLegacyContainedWorkflowName('./daily.nika.yaml')).toBe(false);
    expect(isLegacyWorkflowPath('./daily.nika.yaml')).toBe(true);
    expect(renameLegacyWorkflow('daily.nika.yaml')).toBe('daily.nika');
    expect(legacyWorkflowRenameMessage('daily.nika.yaml')).toContain('daily.nika');
  });

  it('treats nika.yaml as the project file, never a program, regardless of bytes', () => {
    expect(PROJECT_FILE).toBe('nika.yaml');
    expect(isCanonicalWorkflowPath(PROJECT_FILE)).toBe(false);
    expect(isContainedWorkflowName(PROJECT_FILE)).toBe(false);
    expect(isLegacyWorkflowPath(PROJECT_FILE)).toBe(false);
    expect(isLegacyContainedWorkflowName(PROJECT_FILE)).toBe(false);
    expect(workflowLogicalStem(PROJECT_FILE)).toBeUndefined();
  });
});
