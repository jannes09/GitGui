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
function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
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

// a working repository with a bare "origin" that already has branch `topic`
function makeRepoWithRemote() {
  const origin = temp('gitgui-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = temp('gitgui-branches-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'branch', 'topic');
  git(repo, 'push', '-q', '-u', 'origin', 'topic');
  return { repo, origin };
}

test('deleting a branch on the remote removes it there and its remote-tracking ref here', async () => {
  const { repo, origin } = makeRepoWithRemote();
  assert.match(git(origin, 'branch', '--list', 'topic'), /topic/);

  await rpc('deleteRemoteBranch', { repo, remote: 'origin', branch: 'topic' });

  assert.equal(git(origin, 'branch', '--list', 'topic'), '', 'gone from the remote');
  const refs = await rpc('refs', { repo });
  assert.equal(refs.remoteBranches.some((b) => b.name === 'origin/topic'), false, 'gone from the remote-tracking refs');
  assert.equal(refs.branches.some((b) => b.name === 'topic'), true, 'the local branch is untouched');
});

test('local and remote deletion are separate, and the local one refuses unmerged work', async () => {
  const { repo, origin } = makeRepoWithRemote();
  git(repo, 'checkout', '-q', 'topic');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'only here\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'unmerged work');
  git(repo, 'checkout', '-q', 'main');

  const refused = await call('deleteBranch', { repo, name: 'topic' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not fully merged/);

  await rpc('deleteBranch', { repo, name: 'topic', force: true });
  assert.equal((await rpc('refs', { repo })).branches.some((b) => b.name === 'topic'), false);
  assert.match(git(origin, 'branch', '--list', 'topic'), /topic/, 'the remote copy is still there');
});

test('remote deletion refuses unknown remotes and option-like names', async () => {
  const { repo } = makeRepoWithRemote();
  for (const args of [
    { remote: 'nowhere', branch: 'topic' },
    { remote: 'origin', branch: '--all' },
    { remote: '--mirror', branch: 'topic' },
  ]) {
    assert.equal((await call('deleteRemoteBranch', { repo, ...args })).ok, false, JSON.stringify(args));
  }
  assert.equal((await rpc('refs', { repo })).remoteBranches.some((b) => b.name === 'origin/topic'), true);
});
