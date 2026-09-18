// workflow-name.ts — the one SDK lexical source-name owner (pure · zero I/O).
//
// Aligns with the engine nika-source naming contract (#1684): exact
// lowercase `.nika`, nonempty stem, no retired aliases. HTTP adapters
// add contained-relative shape on top (Serve registry names). Suffix is
// never authority.

export const WORKFLOW_SUFFIX = '.nika';
export const PROJECT_FILE = 'nika.yaml';
export const LEGACY_WORKFLOW_SUFFIXES = ['.nika.yaml', '.nika.yml'] as const;

const CONTAINED_CHAR = /[A-Za-z0-9/._-]/;

export function workflowBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x1f || c === 0x7f) { return true; }
  }
  return false;
}

export function isLegacyWorkflowPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) { return false; }
  if (path.endsWith('/') || path.endsWith('\\')) { return false; }
  const base = workflowBasename(path);
  return LEGACY_WORKFLOW_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

export function isCanonicalWorkflowFilename(basename: string): boolean {
  if (typeof basename !== 'string' || basename.length === 0) { return false; }
  if (hasControlChar(basename)) { return false; }
  if (basename.includes('/') || basename.includes('\\')) { return false; }
  if (LEGACY_WORKFLOW_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return false;
  }
  if (!basename.endsWith(WORKFLOW_SUFFIX)) { return false; }
  return basename.length > WORKFLOW_SUFFIX.length;
}

export function isCanonicalWorkflowPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) { return false; }
  if (hasControlChar(path)) { return false; }
  if (path.endsWith('/') || path.endsWith('\\')) { return false; }
  return isCanonicalWorkflowFilename(workflowBasename(path));
}

export function workflowLogicalStem(path: string): string | undefined {
  if (!isCanonicalWorkflowPath(path)) { return undefined; }
  const base = workflowBasename(path);
  return base.slice(0, -WORKFLOW_SUFFIX.length);
}

function containedRelativeShape(value: string): boolean {
  if (value.includes('\\') || value.startsWith('/')) { return false; }
  for (const ch of value) {
    if (!CONTAINED_CHAR.test(ch)) { return false; }
  }
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Serve by-name registry identity: canonical suffix + contained relative path. */
export function isContainedWorkflowName(value: unknown): value is string {
  return typeof value === 'string'
    && isCanonicalWorkflowPath(value)
    && containedRelativeShape(value);
}

/** Retired suffix with the same contained-relative shape · refuse, never fall back. */
export function isLegacyContainedWorkflowName(value: unknown): value is string {
  return typeof value === 'string'
    && isLegacyWorkflowPath(value)
    && containedRelativeShape(value);
}

/**
 * HTTP by-name attempt using a retired suffix. Includes hostile quoted
 * names that fail contained-relative shape. Filesystem paths (`./`, `/`,
 * backslash) stay out so local snapshot capture can still name them.
 */
export function isRetiredByNameAttempt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) { return false; }
  if (value.startsWith('/') || value.startsWith('./') || value.includes('\\')) {
    return false;
  }
  return isLegacyWorkflowPath(value);
}

export function renameLegacyWorkflow(name: string): string {
  if (name.endsWith('.nika.yaml')) { return `${name.slice(0, -'.nika.yaml'.length)}${WORKFLOW_SUFFIX}`; }
  if (name.endsWith('.nika.yml')) { return `${name.slice(0, -'.nika.yml'.length)}${WORKFLOW_SUFFIX}`; }
  return name;
}

export function legacyWorkflowRenameMessage(name: string): string {
  return `workflow names use ${WORKFLOW_SUFFIX}; rename ${name} to ${renameLegacyWorkflow(name)}`;
}
