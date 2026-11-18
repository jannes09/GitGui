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
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const write = (repo, file, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const read = (repo, file) => fs.readFileSync(path.join(repo, file), 'utf8');
const exists = (repo, file) => fs.existsSync(path.join(repo, file));
async function rpc(method, args) {
  const r = await call(method, args);
  assert.ok(r.ok, r.error);
  return r.data;
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-discard-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, '.gitignore', 'ignored.log\n');
  write(dir, 'a.txt', 'a1\n');
  write(dir, 'b.txt', 'b1\n');
  write(dir, 'sub dir/c.txt', 'c1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('discard all reverts tracked files, deletes untracked ones and keeps staged work and ignored files', async () => {
  const repo = makeRepo();
  write(repo, 'a.txt', 'a1\na2 unstaged\n'); // modified, not staged
  write(repo, 'b.txt', 'b1\nb2 staged\n');
  git(repo, 'add', 'b.txt');
  write(repo, 'b.txt', 'b1\nb2 staged\nb3 unstaged\n'); // staged, then modified again
  write(repo, 'sub dir/c.txt', 'c changed\n');
  write(repo, 'new.txt', 'untracked\n');
  write(repo, 'new folder/deep/x.txt', 'untracked in a new folder\n');
  write(repo, 'ignored.log', 'keep me\n');

  await rpc('discardAll', { repo });

  assert.equal(read(repo, 'a.txt'), 'a1\n');
  assert.equal(read(repo, 'sub dir/c.txt'), 'c1\n');
  assert.equal(read(repo, 'b.txt'), 'b1\nb2 staged\n', 'goes back to what was staged, not to the commit');
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'b.txt', 'staged work is kept');
  assert.equal(exists(repo, 'new.txt'), false);
  assert.equal(exists(repo, 'new folder'), false, 'untracked folders go too');
  assert.equal(read(repo, 'ignored.log'), 'keep me\n', 'ignored files are never touched');
  assert.equal((await rpc('status', { repo })).files.filter((f) => f.worktree !== '.').length, 0);
});

test('discard all can leave untracked files alone', async () => {
  const repo = makeRepo();
  write(repo, 'a.txt', 'changed\n');
  write(repo, 'new.txt', 'untracked\n');
  await rpc('discardAll', { repo, untracked: false });
  assert.equal(read(repo, 'a.txt'), 'a1\n');
  assert.equal(read(repo, 'new.txt'), 'untracked\n');
});

test('discard all refuses while files are in conflict, and changes nothing', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'other');
  write(repo, 'a.txt', 'other\n');
  git(repo, 'commit', '-q', '-am', 'other');
  git(repo, 'checkout', '-q', 'main');
  write(repo, 'a.txt', 'main\n');
  git(repo, 'commit', '-q', '-am', 'main');
  assert.equal((await rpc('merge', { repo, ref: 'other' })).conflicts, true);
  write(repo, 'new.txt', 'untracked\n');

  const r = await call('discardAll', { repo });
  assert.equal(r.ok, false);
  assert.match(r.error, /conflict/i);
  assert.equal(exists(repo, 'new.txt'), true);
});

test('discard all works in a repository with no commits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-discard-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'x.txt', 'untracked\n');
  await rpc('discardAll', { repo: dir });
  assert.equal(exists(dir, 'x.txt'), false);
});
