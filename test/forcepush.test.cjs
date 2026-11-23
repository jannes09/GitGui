'use strict';
// Run with: npm test
// Replacing a branch on the remote after its history was rewritten, against real bare repositories.
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
async function fails(method, args) {
  const r = await call(method, args);
  assert.equal(r.ok, false, `${method} should have failed`);
  return r.error;
}
function commit(repo, file, text, msg) {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', msg);
}
function identify(repo, name = 'Test') {
  git(repo, 'config', 'user.name', name);
  git(repo, 'config', 'user.email', `${name.toLowerCase()}@example.com`);
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A bare origin, and a working repository with `main` pushed to it. */
function makeRepoWithOrigin() {
  const origin = temp('gitgui-fp-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = temp('gitgui-fp-');
  git(repo, 'init', '-q', '-b', 'main');
  identify(repo);
  commit(repo, 'a.txt', 'one\n', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { repo, origin };
}
/** Someone else's copy of the same remote. */
function teammate(origin) {
  const dir = temp('gitgui-fp-mate-');
  git(dir, 'clone', '-q', origin, '.');
  identify(dir, 'Mate');
  return dir;
}
/** feature/x with two commits, pushed; then its last commit is reworded, so it no longer fast-forwards. */
function rewrittenFeature() {
  const { repo, origin } = makeRepoWithOrigin();
  git(repo, 'switch', '-q', '-c', 'feature/x');
  commit(repo, 'f1.txt', '1\n', 'f1');
  commit(repo, 'f2.txt', '2\n', 'f2');
  git(repo, 'push', '-q', '-u', 'origin', 'feature/x');
  const oldTip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '-q', '--amend', '-m', 'f2 (reworded)');
  return { repo, origin, oldTip };
}

test('a push the remote turns away because it has other commits is tagged, so the app can offer to force it', async () => {
  const { repo } = rewrittenFeature();
  const error = await fails('push', { repo });
  assert.match(error, /^REJECTED: /);
  assert.match(error, /non-fast-forward|fetch first|rejected/i);
});

test('a first push of a branch that clashes with a different branch of the same name is tagged too', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  const mate = teammate(origin);
  git(mate, 'switch', '-q', '-c', 'feature/y');
  commit(mate, 'm.txt', 'theirs\n', 'their start');
  git(mate, 'push', '-q', '-u', 'origin', 'feature/y');
  git(repo, 'switch', '-q', '-c', 'feature/y'); // no upstream yet: push publishes it
  commit(repo, 'r.txt', 'mine\n', 'my start');
  assert.match(await fails('push', { repo }), /^REJECTED: /);
});

test('a push refused by a hook or by permissions is not tagged: forcing would not help', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  const hook = path.join(origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  commit(repo, 'b.txt', 'x\n', 'second');
  const error = await fails('push', { repo });
  assert.doesNotMatch(error, /^REJECTED: /);
});

test('other push failures keep their own message', async () => {
  const repo = temp('gitgui-fp-noremote-');
  git(repo, 'init', '-q', '-b', 'main');
  identify(repo);
  commit(repo, 'a.txt', 'x\n', 'first');
  assert.match(await fails('push', { repo }), /no remote/i);
});

test('the check lists the commits the remote would lose, and how many of yours replace them', async () => {
  const { repo, origin, oldTip } = rewrittenFeature();
  const info = await rpc('forcePushInfo', { repo });
  assert.equal(info.branch, 'feature/x');
  assert.equal(info.remote, 'origin');
  assert.equal(info.relation, 'diverged');
  assert.equal(info.remoteTip, oldTip);
  assert.equal(info.head, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(info.lostTotal, 1);
  assert.equal(info.localOnly, 1);
  assert.deepEqual(
    info.lost.map((c) => [c.hash, c.subject, c.author]),
    [[oldTip, 'f2', 'Test']],
  );
  assert.equal(git(origin, 'rev-parse', 'feature/x'), oldTip, 'looking changes nothing on the remote');
});

test('the check fetches the remote branch, so the remote-tracking branch is up to date', async () => {
  const { repo, origin } = rewrittenFeature();
  const mate = teammate(origin);
  git(mate, 'switch', '-q', 'feature/x');
  commit(mate, 'm.txt', 'x\n', 'teammate work');
  git(mate, 'push', '-q', 'origin', 'feature/x');
  const info = await rpc('forcePushInfo', { repo });
  assert.equal(info.remoteTip, git(origin, 'rev-parse', 'feature/x'));
  assert.equal(git(repo, 'rev-parse', 'origin/feature/x'), info.remoteTip);
  assert.equal(info.lostTotal, 2, 'the old f2 and the teammate\'s commit');
  assert.ok(info.lost.some((c) => c.subject === 'teammate work' && c.author === 'Mate'));
});

test('only the first few lost commits are named, and the rest are counted', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  const mate = teammate(origin);
  git(mate, 'switch', '-q', '-c', 'feature/long');
  for (let i = 0; i < 25; i++) commit(mate, `l${i}.txt`, `${i}\n`, `theirs ${i}`);
  git(mate, 'push', '-q', '-u', 'origin', 'feature/long');
  git(repo, 'switch', '-q', '-c', 'feature/long');
  commit(repo, 'mine.txt', 'x\n', 'mine');
  const info = await rpc('forcePushInfo', { repo });
  assert.equal(info.lostTotal, 25);
  assert.equal(info.lost.length, 20);
  assert.equal(info.lost[0].subject, 'theirs 24', 'newest first');
});

test('how the branch relates to the remote one: same, ahead, behind or not there at all', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  git(repo, 'switch', '-q', '-c', 'feature/z');
  commit(repo, 'z1.txt', '1\n', 'z1');
  assert.equal((await rpc('forcePushInfo', { repo })).relation, 'gone', 'not pushed yet');
  git(repo, 'push', '-q', '-u', 'origin', 'feature/z');
  const same = await rpc('forcePushInfo', { repo });
  assert.equal(same.relation, 'same');
  assert.equal(same.lostTotal, 0);

  commit(repo, 'z2.txt', '2\n', 'z2');
  const ahead = await rpc('forcePushInfo', { repo });
  assert.equal(ahead.relation, 'ahead', 'a normal push is enough');
  assert.equal(ahead.lostTotal, 0);
  assert.deepEqual(ahead.lost, []);
  assert.equal(ahead.localOnly, 1);

  git(repo, 'push', '-q');
  const mate = teammate(origin);
  git(mate, 'switch', '-q', 'feature/z');
  commit(mate, 'm.txt', 'x\n', 'their z3');
  git(mate, 'push', '-q', 'origin', 'feature/z');
  const behind = await rpc('forcePushInfo', { repo });
  assert.equal(behind.relation, 'behind');
  assert.equal(behind.lostTotal, 1, 'forcing would roll the remote back, so the commit is named');
  assert.equal(behind.localOnly, 0);
});

test('forcing replaces the remote branch with the local one and leaves other branches alone', async () => {
  const { repo, origin } = rewrittenFeature();
  const mainBefore = git(origin, 'rev-parse', 'main');
  const info = await rpc('forcePushInfo', { repo });
  const r = await rpc('forcePush', { repo, head: info.head, expect: info.remoteTip });
  assert.equal(r.pushed, 'origin/feature/x');
  assert.equal(git(origin, 'rev-parse', 'feature/x'), git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(origin, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/x');
  assert.equal((await rpc('forcePushInfo', { repo })).relation, 'same');
  await rpc('push', { repo }); // and an ordinary push works again afterwards
});

test('nothing is overwritten when someone pushed after the check: the lease refuses', async () => {
  const { repo, origin } = rewrittenFeature();
  const info = await rpc('forcePushInfo', { repo });
  const mate = teammate(origin);
  git(mate, 'switch', '-q', 'feature/x');
  commit(mate, 'm.txt', 'x\n', 'late work');
  git(mate, 'push', '-q', 'origin', 'feature/x');
  const theirTip = git(origin, 'rev-parse', 'feature/x');

  const error = await fails('forcePush', { repo, head: info.head, expect: info.remoteTip });

  assert.match(error, /changed since you looked/);
  assert.equal(git(origin, 'rev-parse', 'feature/x'), theirTip, 'the teammate\'s commit is still there');
});

test('a fetch after the check does not defeat the lease: it is pinned to what the user was shown', async () => {
  const { repo, origin } = rewrittenFeature();
  const info = await rpc('forcePushInfo', { repo });
  const mate = teammate(origin);
  git(mate, 'switch', '-q', 'feature/x');
  commit(mate, 'm.txt', 'x\n', 'late work');
  git(mate, 'push', '-q', 'origin', 'feature/x');
  git(repo, 'fetch', '-q', 'origin'); // origin/feature/x now includes the late commit; a bare --force-with-lease would pass
  assert.match(await fails('forcePush', { repo, head: info.head, expect: info.remoteTip }), /changed since you looked/);
  assert.notEqual(git(origin, 'rev-parse', 'feature/x'), git(repo, 'rev-parse', 'HEAD'), 'the remote branch was not replaced');
});

test('nothing is pushed when the local branch moved after the check', async () => {
  const { repo, origin, oldTip } = rewrittenFeature();
  const info = await rpc('forcePushInfo', { repo });
  commit(repo, 'late.txt', 'x\n', 'committed after the check');
  const error = await fails('forcePush', { repo, head: info.head, expect: info.remoteTip });
  assert.match(error, /changed since the remote was checked/);
  assert.equal(git(origin, 'rev-parse', 'feature/x'), oldTip);
});

test('forcing a branch that clashes with a same-named remote one publishes it and tracks it', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  const mate = teammate(origin);
  git(mate, 'switch', '-q', '-c', 'feature/y');
  commit(mate, 'm.txt', 'theirs\n', 'their start');
  git(mate, 'push', '-q', '-u', 'origin', 'feature/y');
  git(repo, 'switch', '-q', '-c', 'feature/y');
  commit(repo, 'r.txt', 'mine\n', 'my start');
  const info = await rpc('forcePushInfo', { repo });
  assert.equal(info.relation, 'diverged');
  await rpc('forcePush', { repo, head: info.head, expect: info.remoteTip });
  assert.equal(git(origin, 'rev-parse', 'feature/y'), git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/y');
});

test('a branch tracking another remote branch is forced under its own name, and main is untouched', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  const mainBefore = git(origin, 'rev-parse', 'main');
  git(repo, 'switch', '-q', '-c', 'fix/thing', 'origin/main'); // tracks origin/main
  commit(repo, 'b.txt', 'x\n', 'fix');
  await rpc('push', { repo }); // published as origin/fix/thing
  git(repo, 'commit', '-q', '--amend', '-m', 'fix (reworded)');
  const info = await rpc('forcePushInfo', { repo });
  await rpc('forcePush', { repo, head: info.head, expect: info.remoteTip });
  assert.equal(git(origin, 'rev-parse', 'fix/thing'), git(repo, 'rev-parse', 'HEAD'));
  assert.equal(git(origin, 'rev-parse', 'main'), mainBefore);
});

test('the arguments are checked before anything is run', async () => {
  const { repo, origin, oldTip } = rewrittenFeature();
  const head = git(repo, 'rev-parse', 'HEAD');
  for (const bad of [undefined, '', 'abc', '--force', `${head} --force`, 'HEAD', 'main', `${head}\n`, head.toUpperCase()]) {
    assert.match(await fails('forcePush', { repo, head, expect: bad }), /Invalid commit/, String(bad));
    assert.match(await fails('forcePush', { repo, head: bad, expect: oldTip }), /Invalid commit/, String(bad));
  }
  assert.equal(git(origin, 'rev-parse', 'feature/x'), oldTip, 'nothing reached the remote');
});

test('a detached HEAD and a repository without a remote are refused', async () => {
  const { repo } = rewrittenFeature();
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '--detach');
  assert.match(await fails('forcePushInfo', { repo }), /detached/i);
  assert.match(await fails('forcePush', { repo, head, expect: head }), /detached/i);

  const lone = temp('gitgui-fp-lone-');
  git(lone, 'init', '-q', '-b', 'main');
  identify(lone);
  commit(lone, 'a.txt', 'x\n', 'first');
  assert.match(await fails('forcePushInfo', { repo: lone }), /no remote/i);
});
