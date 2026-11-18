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
function commit(repo, file, text, msg) {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', msg);
}
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeRepoWithOrigin() {
  const origin = temp('gitgui-push-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = temp('gitgui-push-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  commit(repo, 'a.txt', 'one\n', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { repo, origin };
}

test('a branch created from origin/main is published under its own name, and main is untouched', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  const mainBefore = git(origin, 'rev-parse', 'main');
  git(repo, 'switch', '-q', '-c', 'fix/thing', 'origin/main'); // tracks origin/main, as the app's branch button does
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
  commit(repo, 'b.txt', 'two\n', 'work on the fix');

  const r = await rpc('push', { repo });

  assert.equal(r.published, 'origin/fix/thing');
  assert.equal(git(origin, 'rev-parse', 'fix/thing'), git(repo, 'rev-parse', 'HEAD'), 'the branch exists on the remote');
  assert.equal(git(origin, 'rev-parse', 'main'), mainBefore, 'main on the remote must not move');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/fix/thing', 'now tracks its own branch');

  // later pushes are ordinary
  commit(repo, 'c.txt', 'three\n', 'more');
  assert.deepEqual(await rpc('push', { repo }), {});
  assert.equal(git(origin, 'rev-parse', 'fix/thing'), git(repo, 'rev-parse', 'HEAD'));
});

test('a normal tracked branch and a brand-new branch still push as before', async () => {
  const { repo, origin } = makeRepoWithOrigin();
  commit(repo, 'b.txt', 'two\n', 'on main');
  assert.deepEqual(await rpc('push', { repo }), {});
  assert.equal(git(origin, 'rev-parse', 'main'), git(repo, 'rev-parse', 'HEAD'));

  git(repo, 'switch', '-q', '-c', 'brand-new');
  commit(repo, 'c.txt', 'three\n', 'on brand-new');
  const r = await rpc('push', { repo });
  assert.equal(r.published, 'origin/brand-new');
  assert.equal(git(origin, 'rev-parse', 'brand-new'), git(repo, 'rev-parse', 'HEAD'));
});

test('other push failures are still reported, not swallowed', async () => {
  const { repo } = makeRepoWithOrigin();
  git(repo, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'gitgui-no-such-remote'));
  commit(repo, 'b.txt', 'two\n', 'unpushable');
  const r = await call('push', { repo });
  assert.equal(r.ok, false);
});
