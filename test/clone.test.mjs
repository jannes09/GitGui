// Run with: npm test
// Folder names and address checks for the Clone dialog (src/clone.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneFolderName, cloneNameProblem, cloneUrlProblem } from '../src/clone.ts';

test('folder name comes from the last part of the address', () => {
  assert.equal(cloneFolderName('https://github.com/jannes09/GitGui.git'), 'GitGui');
  assert.equal(cloneFolderName('https://github.com/jannes09/GitGui'), 'GitGui');
  assert.equal(cloneFolderName('https://github.com/jannes09/GitGui/'), 'GitGui');
  assert.equal(cloneFolderName('git@github.com:jannes09/GitGui.git'), 'GitGui');
  assert.equal(cloneFolderName('https://dev.azure.com/org/proj/_git/My Repo'), 'My Repo');
  assert.equal(cloneFolderName('F:\\repos\\local.git'), 'local');
  assert.equal(cloneFolderName('  '), '');
});

test('address problems', () => {
  assert.equal(cloneUrlProblem('https://github.com/a/b.git'), null);
  assert.ok(cloneUrlProblem(''));
  assert.ok(cloneUrlProblem('--upload-pack=x'));
  assert.ok(cloneUrlProblem('a\nb'));
});

test('folder name problems', () => {
  assert.equal(cloneNameProblem('GitGui'), null);
  assert.equal(cloneNameProblem('my.repo'), null);
  for (const bad of ['', '..', 'a/b', 'a:b', 'name.', 'CON', 'nul.txt']) assert.ok(cloneNameProblem(bad), bad);
});
