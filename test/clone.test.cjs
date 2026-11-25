'use strict';
// Run with: npm test
// The clone backend method (electron/handlers.cjs).
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
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeSource() {
  const dir = temp('gg-clone-src-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('clones into parent/name and returns the new root', async () => {
  const src = makeSource();
  const parent = temp('gg-clone-dst-');
  const r = await call('clone', { url: src, parent, name: 'copy' });
  assert.ok(r.ok, r.error);
  assert.equal(path.normalize(r.data.root), path.join(parent, 'copy'));
  assert.equal(r.data.name, 'copy');
  assert.equal(fs.readFileSync(path.join(parent, 'copy', 'a.txt'), 'utf8').trim(), 'hello'); // CRLF with autocrlf
  assert.equal(git(path.join(parent, 'copy'), 'log', '-1', '--format=%s'), 'first');
});

test('clones into an existing empty folder', async () => {
  const src = makeSource();
  const parent = temp('gg-clone-dst-');
  fs.mkdirSync(path.join(parent, 'empty'));
  const r = await call('clone', { url: src, parent, name: 'empty' });
  assert.ok(r.ok, r.error);
});

test('refuses a folder that already has files, and leaves them alone', async () => {
  const src = makeSource();
  const parent = temp('gg-clone-dst-');
  fs.mkdirSync(path.join(parent, 'busy'));
  fs.writeFileSync(path.join(parent, 'busy', 'mine.txt'), 'keep');
  const r = await call('clone', { url: src, parent, name: 'busy' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists and is not empty/);
  assert.equal(fs.readFileSync(path.join(parent, 'busy', 'mine.txt'), 'utf8'), 'keep');
});

test('rejects options passed as an address, and bad folder names', async () => {
  const parent = temp('gg-clone-dst-');
  for (const url of ['--upload-pack=calc', '', 'a\nb']) {
    const r = await call('clone', { url, parent, name: 'x' });
    assert.equal(r.ok, false, url);
  }
  for (const name of ['', '..', 'a/b', 'a\\b', 'a:b']) {
    const r = await call('clone', { url: 'https://example.com/r.git', parent, name });
    assert.equal(r.ok, false, name);
    assert.match(r.error, /Invalid folder name/);
  }
  const missing = await call('clone', { url: 'x', parent: path.join(parent, 'nope'), name: 'x' });
  assert.equal(missing.ok, false);
});

test('reports a failing clone with the git error', async () => {
  const parent = temp('gg-clone-dst-');
  const r = await call('clone', { url: path.join(parent, 'does-not-exist'), parent, name: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('rejects folder names Windows would change or treat as a device', async () => {
  const parent = temp('gg-clone-dst-');
  for (const name of ['repo.', 'CON', 'nul.txt', 'LPT1']) {
    const r = await call('clone', { url: 'https://example.com/r.git', parent, name });
    assert.equal(r.ok, false, name);
    assert.match(r.error, /Invalid folder name/);
  }
});

test('reports progress while a local clone runs, and still works without a listener', async () => {
  const src = makeSource();
  const parent = temp('gg-clone-dst-');
  const seen = [];
  // file:// makes git transfer objects like a real remote (a plain path takes a shortcut with no progress)
  const url = 'file:///' + src.replace(/\\/g, '/');
  const r = await call('clone', { url, parent, name: 'withprogress' }, { progress: (p) => seen.push(p) });
  assert.ok(r.ok, r.error);
  assert.ok(seen.length > 0, 'expected progress events');
  assert.ok(seen.every((p) => p.percent >= 0 && p.percent <= 100 && typeof p.step === 'string'));
  assert.deepEqual(seen.map((p) => p.percent), [...seen.map((p) => p.percent)].sort((a, b) => a - b));
  const r2 = await call('clone', { url, parent, name: 'noprogress' });
  assert.ok(r2.ok, r2.error);
});
