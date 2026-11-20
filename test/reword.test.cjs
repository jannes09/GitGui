'use strict';
// Editing the message of an unpushed commit. Run with: npm test
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
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function makeRepo() {
  const dir = tmp('gitgui-reword-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  commitFile(dir, 'a.txt', 'one', 'first');
  return dir;
}
// a commit by someone else, at a fixed date, so we can see that the edit leaves author and committer alone
function commitFile(dir, file, text, msg, who) {
  fs.appendFileSync(path.join(dir, file), text + '\n');
  git(dir, 'add', file);
  const env = { ...process.env };
  if (who) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: who,
      GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@example.com`,
      GIT_AUTHOR_DATE: '2021-03-04T05:06:07+02:00',
      GIT_COMMITTER_NAME: `${who}-committer`,
      GIT_COMMITTER_EMAIL: `${who.toLowerCase()}-c@example.com`,
      GIT_COMMITTER_DATE: '2021-03-05T06:07:08+02:00',
    });
  }
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
}
async function rpc(method, args) {
  const r = await call(method, args);
  assert.ok(r.ok, r.error);
  return r.data;
}
async function fails(method, args, pattern) {
  const r = await call(method, args);
  assert.equal(r.ok, false, `${method} should have failed`);
  assert.match(r.error, pattern);
}
const fmt = (repo, ref, f) => git(repo, 'show', '-s', `--format=${f}`, ref);
const full = (repo, ref) => git(repo, 'rev-parse', ref);

test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('editing the newest commit changes only its message', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second', 'Alice');
  const old = full(repo, 'HEAD');
  const res = await rpc('rewordCommit', { repo, hash: old, summary: 'Second, better', description: 'Because it matters.\n\nMore words.' });

  assert.notEqual(res.hash, old);
  assert.equal(full(repo, 'HEAD'), res.hash);
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(fmt(repo, 'HEAD', '%B').trim(), 'Second, better\n\nBecause it matters.\n\nMore words.');
  assert.equal(fmt(repo, 'HEAD', '%T'), fmt(repo, old, '%T'));
  assert.equal(fmt(repo, 'HEAD', '%P'), fmt(repo, old, '%P'));
  // the author is untouched; the committer is whoever made the edit, as with --amend
  assert.equal(fmt(repo, 'HEAD', '%an|%ae|%aI'), 'Alice|alice@example.com|2021-03-04T05:06:07+02:00');
  assert.equal(fmt(repo, 'HEAD', '%cn|%ce'), 'Test|t@example.com');
  assert.match(git(repo, 'reflog', '-1'), /reword: Second, better/);
});

test('a summary without a description gives a one-line message', async () => {
  const repo = makeRepo();
  await rpc('rewordCommit', { repo, hash: full(repo, 'HEAD'), summary: '  Just a title  ', description: '\n\n  ' });
  assert.equal(git(repo, 'cat-file', 'commit', 'HEAD').split('\n\n')[1], 'Just a title');
  const info = await rpc('commitEditInfo', { repo, hash: full(repo, 'HEAD') });
  assert.deepEqual([info.summary, info.description], ['Just a title', '']);
});

test('windows line endings in the text become newlines', async () => {
  const repo = makeRepo();
  await rpc('rewordCommit', { repo, hash: full(repo, 'HEAD'), summary: 'Title\r\n', description: 'one\r\ntwo' });
  assert.equal(fmt(repo, 'HEAD', '%B').trim(), 'Title\n\none\ntwo');
});

test('editing an older commit rebuilds the later ones and nothing else about them changes', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second', 'Alice');
  commitFile(repo, 'b.txt', 'three', 'third\n\nwith a body', 'Bob');
  commitFile(repo, 'a.txt', 'four', 'fourth', 'Carol');
  const [c1, c2, c3] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => full(repo, r));
  const before = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => fmt(repo, r, '%T|%an|%ae|%aI|%cn|%ce|%cI'));

  const res = await rpc('rewordCommit', { repo, hash: c2, summary: 'third, reworded', description: '' });
  assert.deepEqual(Object.keys(res.map).sort(), [c2, c3].sort());
  assert.equal(res.map[c2], res.hash);
  assert.equal(res.head, full(repo, 'HEAD'));

  // the unrelated commits keep their ids; the later ones have new ids and a new chain of parents
  assert.equal(full(repo, 'HEAD~2'), c1);
  assert.equal(full(repo, 'HEAD~1'), res.map[c2]);
  assert.equal(full(repo, 'HEAD'), res.map[c3]);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '4');
  assert.equal(git(repo, 'log', '--format=%s', 'HEAD').split('\n').join(' | '), 'fourth | third, reworded | second | first');

  // trees, authors and (for the later commits) committers and messages are exactly as before
  const after = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => fmt(repo, r, '%T|%an|%ae|%aI|%cn|%ce|%cI'));
  assert.equal(after[0], before[0]);
  assert.equal(after[1].split('|').slice(0, 4).join('|'), before[1].split('|').slice(0, 4).join('|'));
  assert.equal(after[2], before[2]);
  assert.equal(fmt(repo, 'HEAD', '%B'), fmt(repo, c3, '%B'));
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'fsck', '--no-dangling', '--no-progress'), '');
});

test('the working tree and the staged changes are left alone', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second');
  commitFile(repo, 'a.txt', 'three', 'third');
  fs.appendFileSync(path.join(repo, 'a.txt'), 'unstaged edit\n');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'new\n');
  git(repo, 'add', 'staged.txt');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'x\n');
  const status = git(repo, 'status', '--porcelain');
  const diff = git(repo, 'diff');

  await rpc('rewordCommit', { repo, hash: full(repo, 'HEAD~1'), summary: 'second, reworded', description: '' });
  assert.equal(git(repo, 'status', '--porcelain'), status);
  assert.equal(git(repo, 'diff'), diff);
  assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'staged.txt');
});

test('a merge after the edited commit is rebuilt with both parents', async () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'side');
  commitFile(repo, 'side.txt', 's', 'side work');
  const side = full(repo, 'HEAD');
  git(repo, 'switch', '-q', 'main');
  commitFile(repo, 'main.txt', 'm', 'main work');
  const mainWork = full(repo, 'HEAD');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  const merge = full(repo, 'HEAD');
  commitFile(repo, 'a.txt', 'after', 'after merge');
  git(repo, 'branch', '-q', '-D', 'side'); // a leftover branch would (rightly) block the edit of side work

  const res = await rpc('rewordCommit', { repo, hash: mainWork, summary: 'main work, reworded', description: '' });
  const newMerge = res.map[merge];
  assert.ok(newMerge && res.map[mainWork]);
  assert.equal(git(repo, 'rev-list', '--parents', '-1', newMerge).split(' ').slice(1).join(' '), `${res.map[mainWork]} ${side}`);
  assert.equal(fmt(repo, newMerge, '%s'), 'Merge side');
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '5');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('a root commit can be edited', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second');
  const root = full(repo, 'HEAD~1');
  const res = await rpc('rewordCommit', { repo, hash: root, summary: 'initial', description: '' });
  assert.equal(git(repo, 'log', '--format=%s', '--reverse', 'HEAD').split('\n')[0], 'initial');
  assert.equal(git(repo, 'rev-list', '--max-parents=0', 'HEAD'), res.hash);
});

test('commitEditInfo splits the message and counts the commits that will be rebuilt', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second\n\nline one\nline two');
  commitFile(repo, 'a.txt', 'three', 'third');
  const info = await rpc('commitEditInfo', { repo, hash: full(repo, 'HEAD~1') });
  assert.deepEqual(info, { summary: 'second', description: 'line one\nline two', later: 1, branch: 'main' });
});

test('input is checked before anything changes', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second');
  const head = full(repo, 'HEAD');
  await fails('rewordCommit', { repo, hash: head, summary: '   ', description: 'x' }, /summary cannot be empty/);
  await fails('rewordCommit', { repo, hash: head, summary: 'two\nlines', description: '' }, /single line/);
  await fails('rewordCommit', { repo, hash: head, summary: 'second', description: '' }, /unchanged/);
  await fails('rewordCommit', { repo, hash: 'HEAD', summary: 'x', description: '' }, /Invalid commit/);
  await fails('rewordCommit', { repo, hash: '0'.repeat(40), summary: 'x', description: '' }, /not found/);
  assert.equal(full(repo, 'HEAD'), head);
});

test('only unpushed commits can be edited', async () => {
  const repo = makeRepo();
  const remote = tmp('gitgui-reword-remote-');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  commitFile(repo, 'a.txt', 'two', 'pushed');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  commitFile(repo, 'a.txt', 'three', 'local one');
  commitFile(repo, 'a.txt', 'four', 'local two');
  const [pushed, one, two] = ['HEAD~2', 'HEAD~1', 'HEAD'].map((r) => full(repo, r));

  const list = await rpc('editableCommits', { repo });
  assert.deepEqual([...list.hashes].sort(), [one, two].sort());
  assert.equal(list.reason, null);

  await fails('rewordCommit', { repo, hash: pushed, summary: 'changed', description: '' }, /already on origin\/main/);
  await fails('commitEditInfo', { repo, hash: pushed }, /already on origin\/main/);

  // the local commits can be edited, and the pushed one under them is not touched
  const res = await rpc('rewordCommit', { repo, hash: one, summary: 'local one, reworded', description: '' });
  assert.equal(full(repo, 'HEAD~2'), pushed);
  assert.equal(full(repo, 'origin/main'), pushed);
  assert.equal(full(repo, 'HEAD~1'), res.hash);
  assert.deepEqual((await rpc('editableCommits', { repo })).hashes.sort(), [res.map[one], res.map[two]].sort());
});

test('a commit that another branch or a tag also holds is refused', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second');
  git(repo, 'branch', 'feature'); // feature has everything so far
  commitFile(repo, 'a.txt', 'three', 'third');
  const [second, third] = ['HEAD~1', 'HEAD'].map((r) => full(repo, r));
  git(repo, 'tag', 'v1', third);

  const list = await rpc('editableCommits', { repo });
  assert.deepEqual(list.hashes, []); // second is on feature, third carries a tag, first is on feature too
  await fails('rewordCommit', { repo, hash: second, summary: 'x', description: '' }, /also on branch feature/);
  await fails('rewordCommit', { repo, hash: third, summary: 'x', description: '' }, /tagged v1/);

  git(repo, 'tag', '-d', 'v1');
  git(repo, 'branch', '-q', '-D', 'feature');
  assert.equal((await rpc('editableCommits', { repo })).hashes.length, 3);
});

test('a commit that is not on the checked-out branch is refused', async () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'other');
  commitFile(repo, 'a.txt', 'two', 'only on other');
  const onOther = full(repo, 'HEAD');
  git(repo, 'switch', '-q', 'main');
  await fails('rewordCommit', { repo, hash: onOther, summary: 'x', description: '' }, /not on the checked-out branch/);
  assert.ok(!(await rpc('editableCommits', { repo })).hashes.includes(onOther));
});

test('nothing can be edited while a merge is in progress', async () => {
  const repo = makeRepo();
  git(repo, 'switch', '-q', '-c', 'other');
  commitFile(repo, 'a.txt', 'other side', 'other');
  git(repo, 'switch', '-q', 'main');
  commitFile(repo, 'a.txt', 'main side', 'main');
  try {
    git(repo, 'merge', 'other');
  } catch {
    /* the conflict is the point */
  }
  const list = await rpc('editableCommits', { repo });
  assert.deepEqual(list.hashes, []);
  assert.match(list.reason, /merge/);
  await fails('rewordCommit', { repo, hash: full(repo, 'HEAD'), summary: 'x', description: '' }, /merge that is in progress/);
});

test('a detached HEAD can be edited when no branch holds the commit', async () => {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '--detach');
  commitFile(repo, 'a.txt', 'two', 'detached work');
  const old = full(repo, 'HEAD');
  assert.deepEqual((await rpc('editableCommits', { repo })).hashes, [old]);
  const res = await rpc('rewordCommit', { repo, hash: old, summary: 'detached, reworded', description: '' });
  assert.equal(full(repo, 'HEAD'), res.hash);
  assert.equal(git(repo, 'branch', '--show-current'), '');
  assert.equal(full(repo, 'main'), full(repo, 'HEAD~1')); // the branch is where it was
});

test('a message in another encoding is kept as it was', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second');
  // i18n.commitEncoding says which encoding the message you give git is already in, so write Latin-1 bytes
  fs.writeFileSync(path.join(repo, 'msg.txt'), Buffer.from('café au lait\n', 'latin1'));
  fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n');
  git(repo, 'add', 'a.txt');
  git(repo, '-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '-q', '-F', 'msg.txt');
  const latin = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: repo });
  assert.ok(latin.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'the old message is stored as ISO-8859-1');

  const res = await rpc('rewordCommit', { repo, hash: full(repo, 'HEAD~1'), summary: 'second, reworded', description: '' });
  const rebuilt = execFileSync('git', ['cat-file', 'commit', res.head], { cwd: repo });
  assert.ok(rebuilt.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'the rebuilt commit has the same bytes');
  assert.match(rebuilt.toString('latin1'), /\nencoding ISO-8859-1\n/);
  assert.equal(fmt(repo, 'HEAD', '%s'), 'café au lait'); // git converts it for display
});

test('the edit can be undone and redone with the snapshots the app records', async () => {
  const repo = makeRepo();
  commitFile(repo, 'a.txt', 'two', 'second');
  commitFile(repo, 'a.txt', 'three', 'third');
  fs.appendFileSync(path.join(repo, 'a.txt'), 'local edit\n');
  const before = await rpc('snapshot', { repo });
  await rpc('rewordCommit', { repo, hash: full(repo, 'HEAD~1'), summary: 'second, reworded', description: '' });
  const after = await rpc('snapshot', { repo });
  assert.notEqual(after.head.hash, before.head.hash);

  await rpc('restoreState', { repo, from: after, to: before, mode: 'keep' });
  assert.equal(full(repo, 'HEAD'), before.head.hash);
  assert.equal(fmt(repo, 'HEAD~1', '%s'), 'second');
  assert.match(git(repo, 'status', '--porcelain'), /a\.txt/); // the local edit survived

  await rpc('restoreState', { repo, from: before, to: after, mode: 'keep' });
  assert.equal(full(repo, 'HEAD'), after.head.hash);
  assert.equal(fmt(repo, 'HEAD~1', '%s'), 'second, reworded');
});

test('a longer chain is rebuilt completely', async () => {
  const repo = makeRepo();
  for (let i = 0; i < 40; i++) commitFile(repo, 'a.txt', String(i), `commit ${i}`);
  const started = Date.now();
  const res = await rpc('rewordCommit', { repo, hash: full(repo, 'HEAD~39'), summary: 'commit 0, reworded', description: '' });
  console.log(`# rebuilt 40 commits in ${Date.now() - started} ms`);
  assert.equal(Object.keys(res.map).length, 40);
  assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '41');
  assert.equal(git(repo, 'log', '--format=%s', '-1', 'HEAD'), 'commit 39');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
