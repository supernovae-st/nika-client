import { Nika, NikaOperationError, type NikaCheckFinding } from '@supernovae-st/nika';

const file = process.argv[2] ?? 'list-files.nika';
const nika = new Nika({ cwd: process.cwd() });

// 1 · the audit alone: nothing runs and no model is called
const report = await nika.check(file);
console.log(`check  ${report.clean ? 'clean' : 'refused'} · exit ${report.exitCode}`);
for (const finding of (report.findings ?? []) as NikaCheckFinding[]) {
  if (finding.severity === 'error') console.log(`       ${finding.code}\n       ${finding.message}`);
}

// 2 · run() checks the file first: a refused file never becomes a run
try {
  const run = await nika.run<{ files: string }>(file, { maxCostUsd: 0 });
  const result = await run.result();
  console.log(`run    ${result.status} · ${result.outputs?.files?.trim().split('\n').length} entries listed`);
} catch (error) {
  if (!(error instanceof NikaOperationError)) throw error;
  console.log(`run    not started · ${error.code} · no run, no events, no trace`);
}
