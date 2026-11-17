'use strict';
// Run with: npm test
// Conflicts and unfinished merge / cherry-pick / revert / rebase operations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { call } = require('../electron/handlers.cjs');

const dirs = [];
function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitFails(repo, ...args) {
  try {
    git(repo, ...args);
  } catch {
    return; // expected: the command stops on a conflict
  }
  assert.fail(`git ${args.join(' ')} should have stopped on a conflict`);
}
const write = (repo, file, text) => fs.writeFileSync(path.join(repo, file), text);
const read = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8');
function commit(repo, file, text, msg) {
  write(repo, file, text);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', msg);
}
// main and feature both change line "b" of f.txt, so merging one into the other conflicts
function makeConflictRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-conflict-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, 'f.txt', 'a\nb\nc\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, 'f.txt', 'a\nfeature\nc\n', 'feature change');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'f.txt', 'a\nmain\nc\n', 'main change');
  return dir;
}
async function rpc(method, args) {
  const r = await call(method, args);
  assert.ok(r.ok, r.error);
  return r.data;
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('a conflicting merge is reported as conflicts, not as an error', async () => {
  const repo = makeConflictRepo();
  const r = await rpc('merge', { repo, ref: 'feature' });
  assert.equal(r.conflicts, true);
  assert.equal(r.files, 1);

  const s = await rpc('status', { repo });
  assert.equal(s.operation.kind, 'merge');
  assert.match(s.operation.detail, /feature/);
  const f = s.files.find((x) => x.path === 'f.txt');
  assert.equal(f.conflicted, true);
  assert.deepEqual([f.index, f.worktree], ['U', 'U']);
});

test('resolving by hand, then continuing, completes the merge with two parents', async () => {
  const repo = makeConflictRepo();
  await rpc('merge', { repo, ref: 'feature' });

  const info = await rpc('conflictFile', { repo, file: 'f.txt' });
  assert.equal(info.hasOurs && info.hasTheirs && info.hasBase, true);
  assert.match(info.content, /^<{7} /m);
  assert.match(info.content, /^={7}$/m);
  assert.match(info.content, /^>{7} feature$/m);

  // continuing while a file is still unresolved is refused
  assert.equal((await call('operationContinue', { repo })).ok, false);

  await rpc('conflictSave', { repo, file: 'f.txt', content: 'a\nmain and feature\nc\n' });
  const s = await rpc('status', { repo });
  assert.equal(s.files.some((x) => x.conflicted), false);
  assert.deepEqual(s.resolved, ['f.txt']);

  const r = await rpc('operationContinue', { repo });
  assert.equal(r.conflicts, false);
  assert.equal((await rpc('status', { repo })).operation, null);
  assert.equal(git(repo, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3, 'a merge commit has two parents');
  assert.equal(read(repo, 'f.txt'), 'a\nmain and feature\nc\n');
});

test('"use ours" and "use theirs" settle the whole file', async () => {
  let repo = makeConflictRepo();
  await rpc('merge', { repo, ref: 'feature' });
  await rpc('conflictResolve', { repo, file: 'f.txt', action: 'ours' });
  assert.equal(read(repo, 'f.txt'), 'a\nmain\nc\n');
  assert.equal(git(repo, 'diff', '--name-only', '--diff-filter=U'), '');

  repo = makeConflictRepo();
  await rpc('merge', { repo, ref: 'feature' });
  await rpc('conflictResolve', { repo, file: 'f.txt', action: 'theirs' });
  assert.equal(read(repo, 'f.txt'), 'a\nfeature\nc\n');
  await rpc('operationContinue', { repo });
  assert.equal(git(repo, 'show', 'HEAD:f.txt'), 'a\nfeature\nc');
});

test('aborting puts the repository back exactly as it was', async () => {
  const repo = makeConflictRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  await rpc('merge', { repo, ref: 'feature' });
  await rpc('operationAbort', { repo });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(read(repo, 'f.txt'), 'a\nmain\nc\n');
  assert.equal((await rpc('status', { repo })).operation, null);
});

test('a resolution can be reopened while the operation is still in progress', async () => {
  const repo = makeConflictRepo();
  await rpc('merge', { repo, ref: 'feature' });
  await rpc('conflictResolve', { repo, file: 'f.txt', action: 'ours' });
  await rpc('conflictReopen', { repo, file: 'f.txt' });
  const s = await rpc('status', { repo });
  assert.equal(s.files.find((x) => x.path === 'f.txt').conflicted, true);
  assert.match(read(repo, 'f.txt'), /^<{7} /m);
});

test('modify/delete conflicts can keep or delete the file', async () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-conflict-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'user.email', 't@example.com');
    commit(dir, 'g.txt', 'one\n', 'base');
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'rm', '-q', 'g.txt');
    git(dir, 'commit', '-q', '-m', 'delete g');
    git(dir, 'checkout', '-q', 'main');
    commit(dir, 'g.txt', 'one\ntwo\n', 'edit g');
    return dir;
  };

  let repo = mk();
  assert.equal((await rpc('merge', { repo, ref: 'feature' })).conflicts, true);
  let info = await rpc('conflictFile', { repo, file: 'g.txt' });
  assert.deepEqual([info.hasOurs, info.hasTheirs, info.exists], [true, false, true]);
  assert.equal((await call('conflictResolve', { repo, file: 'g.txt', action: 'theirs' })).ok, false, 'their side has no file to take');
  await rpc('conflictResolve', { repo, file: 'g.txt', action: 'keep' });
  await rpc('operationContinue', { repo });
  assert.equal(read(repo, 'g.txt'), 'one\ntwo\n');

  repo = mk();
  await rpc('merge', { repo, ref: 'feature' });
  await rpc('conflictResolve', { repo, file: 'g.txt', action: 'delete' });
  await rpc('operationContinue', { repo });
  assert.equal(fs.existsSync(path.join(repo, 'g.txt')), false);
});

test('cherry-pick and revert stop on conflicts and can be continued or aborted', async () => {
  let repo = makeConflictRepo();
  const pick = git(repo, 'rev-parse', 'feature');
  assert.equal((await rpc('cherryPick', { repo, hash: pick })).conflicts, true);
  assert.equal((await rpc('status', { repo })).operation.kind, 'cherry-pick');
  await rpc('conflictSave', { repo, file: 'f.txt', content: 'a\npicked\nc\n' });
  await rpc('operationContinue', { repo });
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'feature change');
  assert.equal(read(repo, 'f.txt'), 'a\npicked\nc\n');

  repo = makeConflictRepo();
  const target = git(repo, 'rev-parse', 'HEAD~1'); // reverting the base commit conflicts with the later edit
  assert.equal((await rpc('revert', { repo, hash: target })).conflicts, true);
  assert.equal((await rpc('status', { repo })).operation.kind, 'revert');
  await rpc('operationAbort', { repo });
  assert.equal((await rpc('status', { repo })).operation, null);
  assert.equal(read(repo, 'f.txt'), 'a\nmain\nc\n');
});

test('a rebase can be resolved, continued and skipped', async () => {
  let repo = makeConflictRepo();
  git(repo, 'checkout', '-q', 'feature');
  gitFails(repo, 'rebase', 'main');
  let s = await rpc('status', { repo });
  assert.equal(s.operation.kind, 'rebase');
  assert.match(s.operation.detail, /1 of 1/);
  await rpc('conflictSave', { repo, file: 'f.txt', content: 'a\nboth\nc\n' });
  await rpc('operationContinue', { repo });
  assert.equal((await rpc('status', { repo })).operation, null);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(read(repo, 'f.txt'), 'a\nboth\nc\n');

  repo = makeConflictRepo();
  git(repo, 'checkout', '-q', 'feature');
  gitFails(repo, 'rebase', 'main');
  await rpc('operationSkip', { repo });
  assert.equal((await rpc('status', { repo })).operation, null);
  assert.equal(read(repo, 'f.txt'), 'a\nmain\nc\n');
});

test('popping a stash that conflicts keeps the stash and lists the conflict', async () => {
  const repo = makeConflictRepo();
  write(repo, 'f.txt', 'a\nstashed\nc\n');
  await rpc('stashPush', { repo });
  commit(repo, 'f.txt', 'a\nchanged after\nc\n', 'move on');
  const r = await rpc('stashPop', { repo, ref: 'stash@{0}' });
  assert.equal(r.conflicts, true);
  assert.equal(r.stashKept, true);
  const s = await rpc('status', { repo });
  assert.equal(s.operation, null);
  assert.equal(s.files.find((x) => x.path === 'f.txt').conflicted, true);
  assert.equal((await rpc('refs', { repo })).stashes.length, 1, 'the stash must not be lost');
});

test('conflict handlers refuse paths outside the repository and files that are not in conflict', async () => {
  const repo = makeConflictRepo();
  await rpc('merge', { repo, ref: 'feature' });
  for (const method of ['conflictFile', 'conflictSave', 'conflictReopen']) {
    const r = await call(method, { repo, file: '../outside.txt', content: 'x' });
    assert.equal(r.ok, false, `${method} must refuse ../outside.txt`);
  }
});

test('files that are not in conflict are refused', async () => {
  const repo = makeConflictRepo();
  const r = await call('conflictSave', { repo, file: 'f.txt', content: 'overwritten\n' });
  assert.equal(r.ok, false);
  assert.equal(read(repo, 'f.txt'), 'a\nmain\nc\n');
});
