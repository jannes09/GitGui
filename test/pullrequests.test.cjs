'use strict';
// Run with: npm test
// Pull request lookup. Nothing here touches the real GitHub or Azure DevOps, or any real login:
// a local fake server stands in for the API and the credential helper is a throw-away script.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-pr-'));
const globalConfig = path.join(sandbox, 'global.gitconfig');
process.env.GITGUI_HOME = path.join(sandbox, 'home');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(globalConfig, '[credential]\n\thelper =\n'); // no stored logins

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseRemoteUrl, parseCredentialOutput, listPullRequests, pullRequestUrl, looksLikeJwt } = require('../electron/pullrequests.cjs');
const { call } = require('../electron/handlers.cjs');

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function makeRepo(remoteUrl) {
  const dir = fs.mkdtempSync(path.join(sandbox, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  if (remoteUrl) git(dir, 'remote', 'add', 'origin', remoteUrl);
  return dir;
}

test('recognises GitHub remotes in every common form', () => {
  for (const url of [
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/widgets',
    'https://user@github.com/acme/widgets.git',
    'git@github.com:acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    'https://github.com/acme/widgets/',
  ]) {
    const info = parseRemoteUrl(url);
    assert.equal(info?.provider, 'github', url);
    assert.equal(info.name, 'acme/widgets', url);
    assert.equal(info.webUrl, 'https://github.com/acme/widgets');
  }
  assert.equal(parseRemoteUrl('https://github.com/acme/my.repo.git').repo, 'my.repo');
});

test('recognises Azure DevOps remotes: https, legacy visualstudio.com and ssh', () => {
  const https = parseRemoteUrl('https://dev.azure.com/PetromanSA/My%20Project/_git/Portal');
  assert.equal(https.provider, 'azure');
  assert.equal(https.webUrl, 'https://dev.azure.com/PetromanSA/My%20Project/_git/Portal');
  assert.equal(https.name, 'PetromanSA/My Project/Portal');
  assert.equal(https.listUrl, 'https://dev.azure.com/PetromanSA/My%20Project/_git/Portal/pullrequests');

  const withUser = parseRemoteUrl('https://PetromanSA@dev.azure.com/PetromanSA/Proj/_git/Portal');
  assert.equal(withUser.webUrl, 'https://dev.azure.com/PetromanSA/Proj/_git/Portal');

  const legacy = parseRemoteUrl('https://petromansa.visualstudio.com/DefaultCollection/Proj/_git/Portal');
  assert.equal(legacy.webUrl, 'https://dev.azure.com/petromansa/Proj/_git/Portal');
  assert.equal(legacy.credentialHost, 'petromansa.visualstudio.com');

  const ssh = parseRemoteUrl('git@ssh.dev.azure.com:v3/PetromanSA/My Project/Portal');
  assert.equal(ssh.webUrl, 'https://dev.azure.com/PetromanSA/My%20Project/_git/Portal');
});

test('other hosts and look-alikes are not recognised', () => {
  for (const url of [
    'https://gitlab.com/acme/widgets.git',
    'https://github.com.evil.example/acme/widgets.git',
    'https://evil.example/github.com/acme/widgets',
    'https://github.com/acme',
    'C:\\repos\\thing',
    '',
    null,
  ]) {
    assert.equal(parseRemoteUrl(url), null, String(url));
  }
});

test('pull request links are built from the remote and the number, not from API data', () => {
  assert.equal(pullRequestUrl(parseRemoteUrl('git@github.com:acme/widgets.git'), 12), 'https://github.com/acme/widgets/pull/12');
  assert.equal(pullRequestUrl(parseRemoteUrl('https://dev.azure.com/o/p/_git/r'), 7), 'https://dev.azure.com/o/p/_git/r/pullrequest/7');
});

test('reads git credential output', () => {
  assert.deepEqual(parseCredentialOutput('protocol=https\nhost=github.com\nusername=alice\npassword=tok=en\n'), { username: 'alice', token: 'tok=en' });
  assert.equal(parseCredentialOutput('protocol=https\nhost=github.com\n'), null);
  assert.equal(looksLikeJwt('eyJhbGciOi.eyJzdWIi.sig-nature_1'), true);
  assert.equal(looksLikeJwt('abcdefghijklmnop'), false);
});

const ghInfo = parseRemoteUrl('https://github.com/acme/widgets.git');
const azInfo = parseRemoteUrl('https://dev.azure.com/acme/Proj/_git/widgets');
const fakeFetch = (handler) => async (url, init) => handler(String(url), init.headers);
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('maps GitHub pull requests and flags the ones from forks', async () => {
  const body = [
    { number: 3, title: 'Add thing', head: { ref: 'feature/thing', repo: { full_name: 'acme/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } }, user: { login: 'alice' }, draft: false },
    { number: 4, title: 'Fork change', head: { ref: 'main', repo: { full_name: 'bob/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } }, user: { login: 'bob' }, draft: true },
    { number: 'x', title: 'garbage' },
  ];
  const r = await listPullRequests(ghInfo, null, fakeFetch(() => reply(200, body)));
  assert.deepEqual(r.prs.map((p) => [p.number, p.branch, p.fork, p.draft, p.url]), [
    [3, 'feature/thing', false, false, 'https://github.com/acme/widgets/pull/3'],
    [4, 'main', true, true, 'https://github.com/acme/widgets/pull/4'],
  ]);
});

test('maps Azure DevOps pull requests', async () => {
  const body = { value: [{ pullRequestId: 9, title: 'Fix', sourceRefName: 'refs/heads/bug/x', targetRefName: 'refs/heads/dev', createdBy: { displayName: 'Rohan' }, isDraft: true }, { pullRequestId: 10, title: 'Fork', sourceRefName: 'refs/heads/y', targetRefName: 'refs/heads/dev', forkSource: {} }] };
  const r = await listPullRequests(azInfo, null, fakeFetch(() => reply(200, body)));
  assert.deepEqual(r.prs.map((p) => [p.number, p.branch, p.target, p.draft, p.fork, p.author]), [
    [9, 'bug/x', 'dev', true, false, 'Rohan'],
    [10, 'y', 'dev', false, true, ''],
  ]);
});

test('Azure DevOps: personal access tokens go as Basic, Microsoft sign-in tokens as Bearer', async () => {
  const seen = [];
  const f = fakeFetch((_url, h) => (seen.push(h.Authorization), reply(200, { value: [] })));
  await listPullRequests(azInfo, 'pat-abc', f);
  await listPullRequests(azInfo, 'eyJhbGciOi.eyJzdWIi.sig', f);
  assert.equal(seen[0], 'Basic ' + Buffer.from(':pat-abc').toString('base64'));
  assert.equal(seen[1], 'Bearer eyJhbGciOi.eyJzdWIi.sig');
});

test('a rejected token is retried once without it, so public repositories still work', async () => {
  const seen = [];
  const f = fakeFetch((_u, h) => (seen.push(h.Authorization ?? null), h.Authorization ? reply(401, {}) : reply(200, [])));
  const r = await listPullRequests(ghInfo, 'stale', f);
  assert.deepEqual(seen, ['Bearer stale', null]);
  assert.equal(r.error, undefined);
  assert.equal(r.authenticated, false);
});

test('problems come back as a message, never as an exception', async () => {
  assert.match((await listPullRequests(ghInfo, null, fakeFetch(() => reply(404, {})))).error, /not found/i);
  assert.match((await listPullRequests(ghInfo, null, fakeFetch(() => reply(403, {})))).error, /rate limit|refused/i);
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  const r = await listPullRequests(ghInfo, null, down);
  assert.deepEqual(r.prs, []);
  assert.match(r.error, /reach the server/i);
});

// ---- the whole path: git remote -> credential helper -> API ----

function startFakeApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization ?? null });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/repos/acme/widgets/pulls')) {
      res.end(JSON.stringify([{ number: 5, title: 'Hello', head: { ref: 'feature/x', repo: { full_name: 'acme/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } }, user: { login: 'alice' } }]));
    } else if (req.url.startsWith('/acme/Proj/_apis/git/repositories/widgets/pullrequests')) {
      res.end(JSON.stringify({ value: [{ pullRequestId: 8, title: 'Azure PR', sourceRefName: 'refs/heads/bug/y', targetRefName: 'refs/heads/dev' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}

test('end to end: finds the PR of a GitHub remote without any stored login', async () => {
  const { server, calls, base } = await startFakeApi();
  process.env.GITGUI_PR_API_BASE = base;
  try {
    const repo = makeRepo('https://github.com/acme/widgets.git');
    const r = (await call('pullRequests', { repo })).data;
    assert.equal(r.provider, 'github');
    assert.equal(r.prs[0].number, 5);
    assert.equal(r.prs[0].branch, 'feature/x');
    assert.equal(r.error, null);
    assert.equal(r.authenticated, false);
    assert.equal(calls[0].auth, null, 'no login, so no Authorization header');
  } finally {
    delete process.env.GITGUI_PR_API_BASE;
    server.close();
  }
});

test('end to end: uses the login the credential helper holds, for Azure DevOps too', async () => {
  const { server, calls, base } = await startFakeApi();
  process.env.GITGUI_PR_API_BASE = base;
  try {
    const repo = makeRepo('https://dev.azure.com/acme/Proj/_git/widgets');
    git(repo, 'config', '--local', 'credential.helper', '!f() { echo username=me; echo password=SECRET123; }; f');
    const r = (await call('pullRequests', { repo })).data;
    assert.equal(r.provider, 'azure');
    assert.equal(r.prs[0].number, 8);
    assert.equal(r.prs[0].branch, 'bug/y');
    assert.equal(r.authenticated, true);
    assert.equal(calls[0].auth, 'Basic ' + Buffer.from(':SECRET123').toString('base64'));
  } finally {
    delete process.env.GITGUI_PR_API_BASE;
    server.close();
  }
});

test('repositories on other hosts, or without a remote, simply have no pull requests', async () => {
  assert.deepEqual((await call('pullRequests', { repo: makeRepo('https://gitlab.com/acme/widgets.git') })).data, { provider: null, prs: [] });
  assert.deepEqual((await call('pullRequests', { repo: makeRepo(null) })).data, { provider: null, prs: [] });
});
