'use strict';
// Run with: npm test
// Everything runs in a sandbox: a private home folder and git config, so a test can never read
// or change the developer's real accounts, global git settings or system config.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-acct-'));
const globalConfig = path.join(sandbox, 'global.gitconfig');
process.env.GITGUI_HOME = path.join(sandbox, 'home');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(globalConfig, '[user]\n\tname = Global Person\n\temail = global@example.com\n');

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { call } = require('../electron/handlers.cjs');

const alice = { username: 'alice-dev', name: 'Alice Dev', email: 'alice@work.example' };
const bob = { username: 'Bob99', name: 'Bob Builder', email: 'bob@home.example' };

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: process.env }).trim();
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(sandbox, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  git(dir, 'add', 'a.txt');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'init');
  return dir;
}
async function rpc(method, args) {
  const r = await call(method, args);
  assert.ok(r.ok, r.error);
  return r.data;
}
const globalGet = (key) => git(sandbox, 'config', '--global', '--get', key);

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test('offers the existing global identity and reports Git Credential Manager status', async () => {
  const r = await rpc('accountsList', {});
  assert.deepEqual(r.profiles, []);
  assert.deepEqual(r.suggestion, { name: 'Global Person', email: 'global@example.com' });
  assert.equal(typeof r.gcm.available, 'boolean');
  assert.ok(Array.isArray(r.gcm.accounts));
});

test('saves, updates and removes accounts; usernames are unique ignoring case', async () => {
  await rpc('accountSave', { profile: alice });
  let list = await rpc('accountSave', { profile: bob });
  assert.deepEqual(list.map((p) => p.username), ['alice-dev', 'Bob99']);

  list = await rpc('accountSave', { profile: { ...alice, username: 'ALICE-DEV', email: 'new@work.example' } });
  assert.equal(list.length, 2, 're-saving the same username must update, not duplicate');
  assert.equal(list.find((p) => p.username.toLowerCase() === 'alice-dev').email, 'new@work.example');

  list = await rpc('accountRemove', { username: 'bob99' });
  assert.deepEqual(list.map((p) => p.username), ['ALICE-DEV']);
  await rpc('accountRemove', { username: 'ALICE-DEV' });
  assert.deepEqual((await rpc('accountsList', {})).profiles, []);
});

test('rejects invalid usernames, names and emails', async () => {
  const bad = [
    { ...alice, username: '-evil' },
    { ...alice, username: '--upload-pack=x' },
    { ...alice, username: 'has space' },
    { ...alice, username: '' },
    { ...alice, username: 'a'.repeat(40) },
    { ...alice, name: '' },
    { ...alice, name: 'Line\nBreak' },
    { ...alice, name: '-sneaky' },
    { ...alice, email: 'not-an-email' },
    { ...alice, email: 'a b@c.d' },
    { ...alice, email: '-x@y.zz' },
  ];
  for (const profile of bad) {
    const r = await call('accountSave', { profile });
    assert.equal(r.ok, false, `should reject ${JSON.stringify(profile)}`);
  }
  assert.deepEqual((await rpc('accountsList', {})).profiles, []);
});

test('switching sets the repository identity and GitHub account without touching global config', async () => {
  await rpc('accountSave', { profile: alice });
  await rpc('accountSave', { profile: bob });
  const repo = makeRepo();
  const globalBefore = fs.readFileSync(globalConfig, 'utf8');

  await rpc('accountSwitch', { repo, username: 'alice-dev' });
  assert.equal(git(repo, 'config', '--local', 'user.name'), 'Alice Dev');
  assert.equal(git(repo, 'config', '--local', 'user.email'), 'alice@work.example');
  assert.equal(git(repo, 'config', '--local', 'credential.https://github.com.username'), 'alice-dev');
  assert.equal(fs.readFileSync(globalConfig, 'utf8'), globalBefore, 'global config must be untouched');

  let active = await rpc('accountActive', { repo });
  assert.equal(active.username, 'alice-dev');
  assert.equal(active.scope, 'local');
  assert.equal(active.email, 'alice@work.example');

  // commits made after the switch carry the switched identity
  fs.appendFileSync(path.join(repo, 'a.txt'), 'y\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'as alice');
  assert.equal(git(repo, 'log', '-1', '--format=%an <%ae>'), 'Alice Dev <alice@work.example>');

  await rpc('accountSwitch', { repo, username: 'bob99' }); // case-insensitive lookup
  active = await rpc('accountActive', { repo });
  assert.equal(active.username, 'Bob99');
  assert.equal(active.name, 'Bob Builder');
});

test('global scope applies everywhere and a repository switch overrides it', async () => {
  await rpc('accountSave', { profile: alice });
  await rpc('accountSave', { profile: bob });
  const repo = makeRepo();

  await rpc('accountSwitch', { username: 'alice-dev', scope: 'global' });
  assert.equal(globalGet('credential.https://github.com.username'), 'alice-dev');
  let active = await rpc('accountActive', { repo });
  assert.equal(active.username, 'alice-dev');
  assert.equal(active.scope, 'global');

  await rpc('accountSwitch', { repo, username: 'Bob99' });
  active = await rpc('accountActive', { repo });
  assert.equal(active.username, 'Bob99');
  assert.equal(active.scope, 'local');
  assert.equal(globalGet('credential.https://github.com.username'), 'alice-dev', 'global stays as it was');
});

test('refuses to switch to an unsaved account or with a bad scope', async () => {
  const repo = makeRepo();
  assert.equal((await call('accountSwitch', { repo, username: 'nobody' })).ok, false);
  assert.equal((await call('accountSwitch', { repo, username: 'alice-dev', scope: 'system' })).ok, false);
});

test('reports whether the remotes are GitHub over HTTPS, SSH, or something else', async () => {
  const repo = makeRepo();
  let a = await rpc('accountActive', { repo });
  assert.deepEqual(a.remotes, { count: 0, githubHttps: false, githubSsh: false });

  git(repo, 'remote', 'add', 'origin', 'https://github.com/someone/thing.git');
  a = await rpc('accountActive', { repo });
  assert.equal(a.remotes.githubHttps, true);
  assert.equal(a.remotes.githubSsh, false);

  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:someone/thing.git');
  a = await rpc('accountActive', { repo });
  assert.equal(a.remotes.githubHttps, false);
  assert.equal(a.remotes.githubSsh, true);

  git(repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/someone/thing.git');
  a = await rpc('accountActive', { repo });
  assert.equal(a.remotes.githubHttps || a.remotes.githubSsh, false);
});

test('a push that needs credentials fails with an AUTH error the UI can act on', async () => {
  // a stand-in server that demands credentials, like GitHub does when you are signed out
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const repo = makeRepo();
    git(repo, 'remote', 'add', 'origin', `http://127.0.0.1:${server.address().port}/o/r.git`);
    git(repo, 'config', 'credential.helper', ''); // never consult a real credential helper
    const r = await call('push', { repo });
    assert.equal(r.ok, false);
    assert.match(r.error, /^AUTH: /);
  } finally {
    server.close();
  }
});

test('ordinary git errors are not mistaken for sign-in problems', async () => {
  const repo = makeRepo();
  const r = await call('checkout', { repo, ref: 'no-such-branch', kind: 'local' });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /^AUTH:/);
});
