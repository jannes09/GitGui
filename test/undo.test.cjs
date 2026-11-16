'use strict';
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { call } = require('../electron/handlers.cjs');

const dirs = [];
function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-test-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  commitFile(dir, 'a.txt', 'one', 'first');
  return dir;
}
function commitFile(dir, file, text, msg) {
  fs.appendFileSync(path.join(dir, file), text + '\n');
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
}
async function rpc(method, args) {
  const r = await call(method, args);
  assert.ok(r.ok, r.error);
  return r.data;
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('undo/redo a commit keeps the changes staged', async () => {
  const repo = makeRepo();
  const before = await rpc('snapshot', { repo });
  fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
  await rpc('stage', { repo, files: ['a.txt'] });
  await rpc('commit', { repo, message: 'second' });
  const after = await rpc('snapshot', { repo });
  assert.notEqual(after.head.hash, before.head.hash);

  await rpc('restoreState', { repo, from: after, to: before, mode: 'soft' });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before.head.hash);
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'a.txt');

  await rpc('restoreState', { repo, from: before, to: after, mode: 'soft' });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), after.head.hash);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('undo/redo creating and checking out a branch', async () => {
  const repo = makeRepo();
  const before = await rpc('snapshot', { repo });
  await rpc('createBranch', { repo, name: 'feature/x' });
  const after = await rpc('snapshot', { repo });
  assert.equal(after.head.branch, 'feature/x');

  await rpc('restoreState', { repo, from: after, to: before, mode: 'keep' });
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(git(repo, 'branch', '--list', 'feature/x'), '');

  await rpc('restoreState', { repo, from: before, to: after, mode: 'keep' });
  assert.equal(git(repo, 'branch', '--show-current'), 'feature/x');
});

test('undo/redo a merge', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'side');
  commitFile(repo, 'b.txt', 'side', 'side work');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'a.txt', 'main', 'main work');
  const before = await rpc('snapshot', { repo });
  await rpc('merge', { repo, ref: 'side' });
  const after = await rpc('snapshot', { repo });
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));

  await rpc('restoreState', { repo, from: after, to: before, mode: 'keep' });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before.head.hash);
  assert.ok(!fs.existsSync(path.join(repo, 'b.txt')));

  await rpc('restoreState', { repo, from: before, to: after, mode: 'keep' });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), after.head.hash);
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
});

test('undo deleting a branch brings it back', async () => {
  const repo = makeRepo();
  git(repo, 'branch', 'old');
  const before = await rpc('snapshot', { repo });
  await rpc('deleteBranch', { repo, name: 'old' });
  const after = await rpc('snapshot', { repo });
  assert.equal(git(repo, 'branch', '--list', 'old'), '');

  await rpc('restoreState', { repo, from: after, to: before, mode: 'keep' });
  assert.equal(git(repo, 'rev-parse', 'old'), before.branches.old);
});

test('undo is refused when the repo changed outside the app', async () => {
  const repo = makeRepo();
  const before = await rpc('snapshot', { repo });
  commitFile(repo, 'a.txt', 'two', 'second');
  const after = await rpc('snapshot', { repo });
  commitFile(repo, 'a.txt', 'three', 'third made in a terminal');

  const r = await call('restoreState', { repo, from: after, to: before, mode: 'soft' });
  assert.equal(r.ok, false);
  assert.match(r.error, /^STALE:/);
  assert.equal(git(repo, 'log', '--format=%s', '-1'), 'third made in a terminal');
});

test('undo does not overwrite local edits it would clobber', async () => {
  const repo = makeRepo();
  const before = await rpc('snapshot', { repo });
  commitFile(repo, 'a.txt', 'two', 'second');
  const after = await rpc('snapshot', { repo });
  fs.appendFileSync(path.join(repo, 'a.txt'), 'uncommitted\n');

  const r = await call('restoreState', { repo, from: after, to: before, mode: 'keep' });
  assert.equal(r.ok, false);
  assert.match(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), /uncommitted/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), after.head.hash);
});

test('rejects malformed state from the renderer', async () => {
  const repo = makeRepo();
  const good = await rpc('snapshot', { repo });
  const bad = { head: { branch: '--force', hash: good.head.hash }, branches: {}, tags: {} };
  const r = await call('restoreState', { repo, from: good, to: bad, mode: 'keep' });
  assert.equal(r.ok, false);
});
