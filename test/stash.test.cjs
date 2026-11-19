'use strict';
// Run with: npm test
// A stash's file list must include untracked (new) files, which git keeps in a separate commit.
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
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-stash-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
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

test('a stash lists modified, staged-new and untracked files', async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n'); // modified
  fs.writeFileSync(path.join(repo, 'staged-new.txt'), 'staged\n'); // new and staged
  git(repo, 'add', 'staged-new.txt');
  fs.mkdirSync(path.join(repo, 'sub dir'));
  fs.writeFileSync(path.join(repo, 'sub dir', 'untracked.txt'), 'brand new\nsecond line\n'); // untracked
  await rpc('stashPush', { repo });

  const stash = (await rpc('refs', { repo })).stashes[0];
  const files = await rpc('commitFiles', { repo, hash: stash.hash });
  const by = Object.fromEntries(files.map((f) => [f.path, f]));

  assert.equal(by['a.txt'].status, 'M');
  assert.equal(by['staged-new.txt'].status, 'A');
  assert.equal(by['sub dir/untracked.txt'].status, 'A', 'the untracked file must be listed');
  assert.equal(files.length, 3);
  assert.equal(by['a.txt'].ref, undefined, 'ordinary files are diffed against the stash itself');
  assert.ok(by['sub dir/untracked.txt'].ref, 'untracked files point at the commit that holds them');

  // and its diff shows the whole file as added
  const diff = await rpc('diff', { repo, file: 'sub dir/untracked.txt', hash: by['sub dir/untracked.txt'].ref });
  assert.match(diff, /^\+brand new$/m);
  assert.match(diff, /^\+second line$/m);
});

test('a stash with only untracked files is not shown as empty', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'only-new.txt'), 'x\n');
  await rpc('stashPush', { repo });
  const stash = (await rpc('refs', { repo })).stashes[0];
  const files = await rpc('commitFiles', { repo, hash: stash.hash });
  assert.deepEqual(files.map((f) => [f.path, f.status]), [['only-new.txt', 'A']]);
});

test('an ordinary stash without untracked files is unchanged', async () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo, 'a.txt'), 'two\n');
  await rpc('stashPush', { repo });
  const stash = (await rpc('refs', { repo })).stashes[0];
  assert.deepEqual((await rpc('commitFiles', { repo, hash: stash.hash })).map((f) => f.path), ['a.txt']);
});

test('an octopus merge (three parents) does not get extra files from its third parent', async () => {
  const repo = makeRepo();
  for (const name of ['p', 'q', 'r']) {
    git(repo, 'checkout', '-q', '-b', name, 'main');
    fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `add ${name}`);
  }
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-edit', 'p', 'q', 'r');
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.equal(git(repo, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 4, 'three parents');
  const files = await rpc('commitFiles', { repo, hash: head });
  assert.ok(files.every((f) => f.ref === undefined), 'no file may be redirected to another commit');
});
