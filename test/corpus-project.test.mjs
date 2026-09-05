import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { stageCorpus } from '../scripts/corpus-project.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);

for (const mode of ['clean', 'undeclared-file', 'symlink-workflow']) {
  test(`corpus staging admits only the declared regular workflows: ${mode}`, () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'corpus-project-test-'));
    const sourceRoot = path.join(scratch, 'source');
    const source = path.join(sourceRoot, 'gauntlet', 'corpus');
    cpSync(path.join(repo, 'gauntlet', 'corpus'), source, { recursive: true });
    const first = JSON.parse(readFileSync(path.join(source, 'use-cases.json'), 'utf8'))[0].workflow;
    try {
      if (mode === 'undeclared-file') writeFileSync(path.join(source, 'unrelated-secret'), 'not a fixture');
      if (mode === 'symlink-workflow') {
        const file = path.join(source, first);
        rmSync(file);
        symlinkSync(path.join(repo, 'gauntlet', 'corpus', first), file);
        assert.throws(() => stageCorpus(sourceRoot, scratch, {}), /regular file/);
        return;
      }
      const staged = stageCorpus(sourceRoot, scratch, { PATH: '/test/bin', NIKA_TEST_SECRET: 'synthetic' });
      assert.equal(readFileSync(path.join(staged.project, 'nika.yaml'), 'utf8'), 'nika: sdk-corpus\n');
      assert.deepEqual(readdirSync(staged.project).sort(), ['nika.yaml', 'use-cases.json', 'workflows']);
      assert.equal(existsSync(path.join(staged.project, 'unrelated-secret')), false);
      assert.equal(staged.engineEnv.NIKA_TEST_SECRET, undefined);
      assert.equal(staged.engineEnv.PATH, '/test/bin');
      for (const entry of staged.inventory) {
        assert(readFileSync(path.join(staged.project, entry.workflow)).equals(readFileSync(path.join(source, entry.workflow))));
      }
    } finally { rmSync(scratch, { recursive: true }); }
  });
}

for (const [name, mutate] of [
  ['missing-id', (rows) => { delete rows[0].id; }],
  ['empty-actor', (rows) => { rows[0].actor = '  '; }],
  ['numeric-trigger', (rows) => { rows[0].trigger = 7; }],
  ['missing-domain', (rows) => {
    const domain = rows[0].domain;
    for (const row of rows) if (row.domain === domain) delete row.domain;
  }],
  ['missing-recipe', (rows) => { delete rows[0].recipe; }],
]) {
  test(`corpus metadata is present before any project is staged: ${name}`, () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'corpus-metadata-test-'));
    const sourceRoot = path.join(scratch, 'source');
    const source = path.join(sourceRoot, 'gauntlet', 'corpus');
    try {
      cpSync(path.join(repo, 'gauntlet', 'corpus'), source, { recursive: true });
      const inventoryPath = path.join(source, 'use-cases.json');
      const rows = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      mutate(rows);
      writeFileSync(inventoryPath, JSON.stringify(rows));
      assert.throws(() => stageCorpus(sourceRoot, scratch, {}), /non-empty strings/);
      assert.equal(existsSync(path.join(scratch, 'project')), false);
      assert.equal(existsSync(path.join(scratch, 'home')), false);
    } finally { rmSync(scratch, { recursive: true }); }
  });
}
