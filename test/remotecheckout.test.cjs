'use strict';
// Run with: npm test
// Checking out a remote branch when a local branch of the same name already exists (and sits somewhere else).
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
  git(repo, 'config', 'core.autocrlf', 'false');
}
test.after(() => {
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d, { recursive: true })) {
        try {
          fs.chmodSync(path.join(d, f), 0o666);
        } catch {
          /* gone */
        }
      }
    } catch {
      /* gone */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A bare origin and a working repository with `master` pushed, plus `feature` (local only) to stand on. */
function setup() {
  const origin = temp('gitgui-rc-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'master');
  const repo = temp('gitgui-rc-');
  git(repo, 'init', '-q', '-b', 'master');
  identify(repo);
  commit(repo, 'a.txt', 'one\n', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'master');
  git(repo, 'branch', 'feature');
  return { repo, origin };
}
/** Someone else pushes commits to origin's master; the repository then fetches them. */
function remoteMovesOn(origin, repo, n = 2) {
  const mate = temp('gitgui-rc-mate-');
  git(mate, 'clone', '-q', '-c', 'core.autocrlf=false', origin, '.');
  identify(mate, 'Mate');
  for (let i = 1; i <= n; i++) commit(mate, `remote${i}.txt`, `${i}\n`, `remote ${i}`);
  git(mate, 'push', '-q', 'origin', 'master');
  git(repo, 'fetch', '-q', 'origin');
}

test('the check says how the local branch and the remote one relate, with counts', async () => {
  const { repo, origin } = setup();
  let info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/master' });
  assert.equal(info.relation, 'same');
  assert.equal(info.local, 'master');
  assert.equal(info.current, true);
  assert.equal(info.localHash, info.remoteHash);

  remoteMovesOn(origin, repo, 2);
  info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/master' });
  assert.deepEqual([info.relation, info.ahead, info.behind], ['behind', 0, 2]);
  assert.equal(info.remoteHash, git(repo, 'rev-parse', 'origin/master'));

  commit(repo, 'mine.txt', 'x\n', 'local only');
  info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/master' });
  assert.deepEqual([info.relation, info.ahead, info.behind], ['diverged', 1, 2]);

  git(repo, 'reset', '-q', '--hard', 'origin/master');
  commit(repo, 'mine2.txt', 'x\n', 'local only 2');
  commit(repo, 'mine3.txt', 'x\n', 'local only 3');
  info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/master' });
  assert.deepEqual([info.relation, info.ahead, info.behind], ['ahead', 2, 0]);

  git(repo, 'switch', '-q', 'feature');
  assert.equal((await rpc('remoteCheckoutInfo', { repo, ref: 'origin/master' })).current, false, 'not the branch that is checked out');
});

test('a remote branch with no local branch yet has relation none', async () => {
  const { repo, origin } = setup();
  const mate = temp('gitgui-rc-mate-');
  git(mate, 'clone', '-q', '-c', 'core.autocrlf=false', origin, '.');
  identify(mate, 'Mate');
  git(mate, 'switch', '-q', '-c', 'topic');
  commit(mate, 't.txt', '1\n', 'topic work');
  git(mate, 'push', '-q', '-u', 'origin', 'topic');
  git(repo, 'fetch', '-q', 'origin');
  const info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/topic' });
  assert.equal(info.relation, 'none');
  assert.equal(info.localHash, null);
  assert.equal(info.local, 'topic');
});

test('the check refuses things that are not remote branches', async () => {
  const { repo } = setup();
  assert.match(await fails('remoteCheckoutInfo', { repo, ref: 'master' }), /not a remote branch/);
  assert.match(await fails('remoteCheckoutInfo', { repo, ref: 'origin/nothing-here' }), /not a remote branch/);
  assert.match(await fails('remoteCheckoutInfo', { repo, ref: '--upload-pack=x' }), /Invalid reference/);
});

test('without reset, checking out the remote branch switches to the local one as it is (as before)', async () => {
  const { repo, origin } = setup();
  git(repo, 'switch', '-q', 'feature');
  remoteMovesOn(origin, repo, 2);
  const localBefore = git(repo, 'rev-parse', 'master');
  await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote' });
  assert.equal(git(repo, 'branch', '--show-current'), 'master');
  assert.equal(git(repo, 'rev-parse', 'master'), localBefore, 'the local branch was not moved');
  assert.notEqual(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/master'));
});

test('with reset, the local branch moves to the remote commit and is checked out, tracking it', async () => {
  const { repo, origin } = setup();
  git(repo, 'switch', '-q', 'feature');
  remoteMovesOn(origin, repo, 2);
  const oldLocal = git(repo, 'rev-parse', 'master');
  await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
  assert.equal(git(repo, 'branch', '--show-current'), 'master');
  assert.equal(git(repo, 'rev-parse', 'master'), git(repo, 'rev-parse', 'origin/master'));
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/master'));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'master@{u}'), 'origin/master');
  assert.ok(fs.existsSync(path.join(repo, 'remote2.txt')), 'the files of the remote commit are there');
  assert.equal(git(repo, 'rev-parse', 'master@{1}'), oldLocal, 'where it was is in the reflog');
});

test('with reset on the branch that is already checked out, it moves forward in place', async () => {
  const { repo, origin } = setup();
  remoteMovesOn(origin, repo, 3);
  assert.equal(git(repo, 'branch', '--show-current'), 'master');
  await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'origin/master'));
  assert.equal(git(repo, 'branch', '--show-current'), 'master');
  assert.ok(fs.existsSync(path.join(repo, 'remote3.txt')));
});

test('reset drops the local-only commits from the branch, but they are not lost', async () => {
  const { repo, origin } = setup();
  commit(repo, 'mine.txt', 'x\n', 'local only');
  const mine = git(repo, 'rev-parse', 'HEAD');
  remoteMovesOn(origin, repo, 1);
  await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
  assert.equal(git(repo, 'rev-parse', 'master'), git(repo, 'rev-parse', 'origin/master'));
  assert.equal(git(repo, 'branch', '--contains', mine, '--list', 'master'), '', 'master no longer holds it');
  assert.equal(git(repo, 'rev-parse', 'master@{1}'), mine, 'but the reflog does');
  assert.ok(!fs.existsSync(path.join(repo, 'mine.txt')));
});

test('reset is refused, and nothing moves, when uncommitted changes are in the way', async () => {
  const { repo, origin } = setup();
  git(repo, 'switch', '-q', 'feature');
  remoteMovesOn(origin, repo, 1);
  commit(repo, 'remote1.txt', 'mine on feature\n', 'feature adds the same file');
  fs.writeFileSync(path.join(repo, 'remote1.txt'), 'uncommitted edit\n');
  const before = { master: git(repo, 'rev-parse', 'master'), head: git(repo, 'rev-parse', 'HEAD') };
  const error = await fails('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
  assert.match(error, /would be overwritten by checkout/);
  assert.equal(git(repo, 'rev-parse', 'master'), before.master, 'the branch was not moved');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(repo, 'branch', '--show-current'), 'feature');
  assert.equal(fs.readFileSync(path.join(repo, 'remote1.txt'), 'utf8'), 'uncommitted edit\n', 'the edit is untouched');
});

test('uncommitted changes that are not in the way come along, as with any checkout', async () => {
  const { repo, origin } = setup();
  git(repo, 'switch', '-q', 'feature');
  remoteMovesOn(origin, repo, 1);
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'keep me\n');
  fs.appendFileSync(path.join(repo, 'a.txt'), 'edited\n');
  await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
  assert.equal(git(repo, 'branch', '--show-current'), 'master');
  assert.equal(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'keep me\n');
  assert.match(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), /edited/);
});

test('a remote branch with no local branch still creates one that tracks it', async () => {
  const { repo, origin } = setup();
  const mate = temp('gitgui-rc-mate-');
  git(mate, 'clone', '-q', '-c', 'core.autocrlf=false', origin, '.');
  identify(mate, 'Mate');
  git(mate, 'switch', '-q', '-c', 'topic');
  commit(mate, 't.txt', '1\n', 'topic work');
  git(mate, 'push', '-q', '-u', 'origin', 'topic');
  git(repo, 'fetch', '-q', 'origin');
  await rpc('checkout', { repo, ref: 'origin/topic', kind: 'remote' });
  assert.equal(git(repo, 'branch', '--show-current'), 'topic');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'topic@{u}'), 'origin/topic');
});

test('a reset-and-checkout can be undone and redone, whether or not the branch was the current one', async () => {
  // from another branch: master moves and HEAD changes
  {
    const { repo, origin } = setup();
    git(repo, 'switch', '-q', 'feature');
    remoteMovesOn(origin, repo, 2);
    const before = await rpc('snapshot', { repo });
    await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
    const after = await rpc('snapshot', { repo });
    assert.notEqual(after.branches.master, before.branches.master);

    await rpc('restoreState', { repo, from: after, to: before, mode: 'keep' });
    assert.equal(git(repo, 'branch', '--show-current'), 'feature');
    assert.equal(git(repo, 'rev-parse', 'master'), before.branches.master, 'master is back where it was');
    assert.ok(!fs.existsSync(path.join(repo, 'remote2.txt')));

    await rpc('restoreState', { repo, from: before, to: after, mode: 'keep' });
    assert.equal(git(repo, 'branch', '--show-current'), 'master');
    assert.equal(git(repo, 'rev-parse', 'master'), after.branches.master);
  }
  // on the branch itself: it moves forward in place and back again
  {
    const { repo, origin } = setup();
    remoteMovesOn(origin, repo, 2);
    const before = await rpc('snapshot', { repo });
    await rpc('checkout', { repo, ref: 'origin/master', kind: 'remote', reset: true });
    const after = await rpc('snapshot', { repo });
    await rpc('restoreState', { repo, from: after, to: before, mode: 'keep' });
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before.head.hash);
    assert.equal(git(repo, 'branch', '--show-current'), 'master');
    assert.ok(!fs.existsSync(path.join(repo, 'remote2.txt')));
  }
});

/* ---------- other remotes, and what the local branch tracks ---------- */

/** setup(), plus a second remote called upstream that has master and then moves on by one commit. */
function setupWithSecondRemote() {
  const { repo, origin } = setup();
  const upstreamBare = temp('gitgui-rc-upstream-');
  git(upstreamBare, 'init', '-q', '--bare', '-b', 'master');
  git(repo, 'remote', 'add', 'upstream', upstreamBare);
  git(repo, 'push', '-q', 'upstream', 'master');
  const mate = temp('gitgui-rc-mate-');
  git(mate, 'clone', '-q', '-c', 'core.autocrlf=false', upstreamBare, '.');
  identify(mate, 'Mate');
  commit(mate, 'u.txt', '1\n', 'upstream work');
  git(mate, 'push', '-q', 'origin', 'master');
  git(repo, 'fetch', '-q', 'upstream');
  return { repo, origin, upstreamBare };
}

test('a reset to another remote\'s branch moves the local branch but leaves what it tracks alone', async () => {
  const { repo } = setupWithSecondRemote();
  git(repo, 'switch', '-q', 'feature');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'master@{u}'), 'origin/master');
  const info = await rpc('remoteCheckoutInfo', { repo, ref: 'upstream/master' });
  assert.equal(info.relation, 'behind');
  assert.equal(info.upstream, 'origin/master', 'the prompt can say what master keeps tracking');

  await rpc('checkout', { repo, ref: 'upstream/master', kind: 'remote', reset: true });
  assert.equal(git(repo, 'rev-parse', 'master'), git(repo, 'rev-parse', 'upstream/master'), 'moved to the other remote\'s commit');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'master@{u}'), 'origin/master', 'still tracks origin: a push must not start going to upstream');
  assert.equal(git(repo, 'config', '--get', 'branch.master.remote'), 'origin');
});

test('a local branch that tracks nothing starts tracking the remote branch it is reset to', async () => {
  const { repo, origin } = setup();
  const mate = temp('gitgui-rc-mate-');
  git(mate, 'clone', '-q', '-c', 'core.autocrlf=false', origin, '.');
  identify(mate, 'Mate');
  git(mate, 'switch', '-q', '-c', 'topic');
  commit(mate, 't1.txt', '1\n', 'topic 1');
  git(mate, 'push', '-q', '-u', 'origin', 'topic');
  commit(mate, 't2.txt', '2\n', 'topic 2');
  git(mate, 'push', '-q', 'origin', 'topic');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'branch', 'topic', 'master'); // a local topic, on an older commit, tracking nothing
  assert.throws(() => git(repo, 'rev-parse', '--abbrev-ref', 'topic@{u}'));
  const info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/topic' });
  assert.equal(info.upstream, null);

  await rpc('checkout', { repo, ref: 'origin/topic', kind: 'remote', reset: true });
  assert.equal(git(repo, 'rev-parse', 'topic'), git(repo, 'rev-parse', 'origin/topic'));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'topic@{u}'), 'origin/topic', 'now tracks it');
});

test('the check reports what the local branch tracks, and nothing for a branch that does not exist yet', async () => {
  const { repo, origin } = setup();
  assert.equal((await rpc('remoteCheckoutInfo', { repo, ref: 'origin/master' })).upstream, 'origin/master');
  const mate = temp('gitgui-rc-mate-');
  git(mate, 'clone', '-q', '-c', 'core.autocrlf=false', origin, '.');
  identify(mate, 'Mate');
  git(mate, 'switch', '-q', '-c', 'later');
  commit(mate, 'l.txt', '1\n', 'later');
  git(mate, 'push', '-q', '-u', 'origin', 'later');
  git(repo, 'fetch', '-q', 'origin');
  const info = await rpc('remoteCheckoutInfo', { repo, ref: 'origin/later' });
  assert.equal(info.relation, 'none');
  assert.equal(info.upstream, null);
});
