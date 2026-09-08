import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Check and run use the same unchanged corpus in an owned project and home.
// This is fixture isolation, not a sandbox for arbitrary hostile workflows.
export function stageCorpus(root, scratch, env) {
  const source = path.join(root, 'gauntlet', 'corpus');
  const project = path.join(scratch, 'project');
  const fixtureHome = path.join(scratch, 'home');
  const inventoryPath = path.join(source, 'use-cases.json');
  assert(lstatSync(inventoryPath).isFile(), 'corpus inventory must be a regular file');
  assert(lstatSync(path.join(source, 'workflows')).isDirectory(), 'corpus workflows must be a directory');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const workflowFiles = readdirSync(path.join(source, 'workflows'))
    .filter((file) => file.endsWith('.nika.yaml')).sort();
  assert(Array.isArray(inventory), 'corpus inventory must be an array');
  assert.equal(inventory.length, 100, 'expected exactly 100 corpus cases');
  assert.equal(workflowFiles.length, 100, 'expected exactly 100 corpus workflows');
  const uniqueFields = ['id', 'actor', 'trigger', 'failure_oracle', 'business_outcome', 'workflow'];
  for (const field of [...uniqueFields, 'domain', 'recipe']) {
    assert(inventory.every((entry) => typeof entry?.[field] === 'string' && entry[field].trim().length > 0),
      `${field} values must be non-empty strings`);
  }
  for (const field of uniqueFields) {
    assert.equal(new Set(inventory.map((entry) => entry[field])).size, 100, `${field} must be unique`);
  }
  assert.equal(new Set(inventory.map((entry) => entry.domain)).size, 20, 'expected 20 distinct domains');
  for (const entry of inventory) {
    assert(typeof entry.workflow === 'string' && /^workflows\/[^/\\]+\.nika\.yaml$/.test(entry.workflow),
      'corpus workflows must remain inside the isolated project');
    assert(lstatSync(path.join(source, entry.workflow)).isFile(), 'corpus workflow must be a regular file');
  }
  assert.deepEqual(inventory.map((entry) => entry.workflow).sort(), workflowFiles.map((file) => `workflows/${file}`));
  mkdirSync(fixtureHome, { mode: 0o700 });
  mkdirSync(path.join(project, 'workflows'), { recursive: true, mode: 0o700 });
  // Stop ancestor discovery without copying repository config, keys or journals.
  writeFileSync(path.join(project, 'nika.yaml'), 'nika: sdk-corpus\n', { flag: 'wx', mode: 0o600 });
  copyFileSync(inventoryPath, path.join(project, 'use-cases.json'));
  for (const entry of inventory) {
    copyFileSync(path.join(source, entry.workflow), path.join(project, entry.workflow));
    assert(readFileSync(path.join(project, entry.workflow)).equals(readFileSync(path.join(source, entry.workflow))),
      'staged workflow bytes must match the source corpus');
  }
  const engineEnv = { ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM']
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
    HOME: fixtureHome, NIKA_KEYCHAIN: 'off' };
  return { project, engineEnv, inventory, workflowFiles };
}
