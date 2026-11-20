// Run with: npm test
// Profile pictures for commit authors (src/avatars.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MAX_PROBES,
  MISS_TTL_MS,
  PICTURE_PX,
  findPicture,
  forgetPictures,
  githubUsername,
  gravatarHash,
  loadPicture,
  peekPicture,
  pictureKey,
  pictureUrls,
} from '../src/avatars.ts';

const both = { github: true, gravatar: true, accounts: [] };
const githubOnly = { github: true, gravatar: false, accounts: [] };
const off = { github: false, gravatar: false, accounts: [] };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test.beforeEach(() => forgetPictures());

test('a GitHub no-reply address gives the username, with or without the numeric id', () => {
  assert.equal(githubUsername('12345+octocat@users.noreply.github.com', []), 'octocat');
  assert.equal(githubUsername('octocat@users.noreply.github.com', []), 'octocat');
  assert.equal(githubUsername('  12345+Mona-Lisa@Users.NoReply.GitHub.com ', []), 'mona-lisa', 'case and spaces do not matter');
});

test('other addresses, bots and odd names give no username', () => {
  for (const e of ['alice@example.com', 'a@users.noreply.github.com.evil.example', '1+dependabot[bot]@users.noreply.github.com', '-bad@users.noreply.github.com', '', undefined, 'noreply']) {
    assert.equal(githubUsername(e, []), null, String(e));
  }
  assert.equal(githubUsername(`${'a'.repeat(40)}@users.noreply.github.com`, []), null, 'longer than a GitHub username can be');
});

test('a saved account gives its username for its own email, whatever the case', () => {
  const accounts = [{ username: 'jannes09', email: 'Jannes@Example.com' }, { username: 'bad name', email: 'x@example.com' }];
  assert.equal(githubUsername('jannes@example.com', accounts), 'jannes09');
  assert.equal(githubUsername('someone@example.com', accounts), null);
  assert.equal(githubUsername('x@example.com', accounts), null, 'an account whose username is not a valid GitHub name is ignored');
});

test('GitHub addresses carry only the public username; Gravatar carries a hash, never the address', async () => {
  const urls = await pictureUrls('12345+octocat@users.noreply.github.com', both);
  assert.equal(urls[0], `https://github.com/octocat.png?size=${PICTURE_PX}`);
  assert.equal(urls[1], `https://gravatar.com/avatar/${sha256('12345+octocat@users.noreply.github.com')}?s=${PICTURE_PX}&d=404`);
  for (const u of urls) assert.equal(u.includes('@'), false, 'no email address in a URL');
});

test('the Gravatar hash is the SHA-256 of the trimmed, lower-cased address', async () => {
  assert.equal(await gravatarHash('alice@example.com'), sha256('alice@example.com'));
  const urls = await pictureUrls('  Alice@Example.COM ', { ...off, gravatar: true });
  assert.deepEqual(urls, [`https://gravatar.com/avatar/${sha256('alice@example.com')}?s=${PICTURE_PX}&d=404`]);
});

test('with GitHub only, authors without a GitHub address are not looked up anywhere', async () => {
  assert.deepEqual(await pictureUrls('alice@example.com', githubOnly), []);
});

test('with Gravatar only, GitHub is not asked, even for a GitHub address', async () => {
  const urls = await pictureUrls('octocat@users.noreply.github.com', { ...off, gravatar: true });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/gravatar\.com\//);
});

test('nothing is built when every source is off, or the address is not usable', async () => {
  assert.deepEqual(await pictureUrls('octocat@users.noreply.github.com', off), []);
  for (const e of ['', undefined, 'no-at-sign', 'a@', 'x'.repeat(300) + '@example.com']) assert.deepEqual(await pictureUrls(e, both), [], String(e));
});

test('the first address that loads wins, and a picture that does not load falls through', async () => {
  const seen = [];
  const url = await findPicture('octocat@users.noreply.github.com', both, async (u) => (seen.push(u), u.includes('gravatar')));
  assert.equal(seen.length, 2);
  assert.match(url, /^https:\/\/gravatar\.com\/avatar\//);
  assert.equal(await findPicture('octocat@users.noreply.github.com', both, async () => false), null);
  const stop = await findPicture('octocat@users.noreply.github.com', both, async () => true);
  assert.match(stop, /^https:\/\/github\.com\/octocat\.png/);
});

test('no request at all when no source is on', async () => {
  let calls = 0;
  const url = await loadPicture('octocat@users.noreply.github.com', off, async () => (calls++, true));
  assert.equal(url, null);
  assert.equal(calls, 0);
  assert.equal(pictureKey('octocat@users.noreply.github.com', off), null);
});

test('many rows asking about the same author cause one lookup, and later asks are answered from memory', async () => {
  let calls = 0;
  const probe = async () => (calls++, await new Promise((r) => setTimeout(r, 5)), true);
  const email = 'octocat@users.noreply.github.com';
  assert.equal(peekPicture(email, githubOnly), undefined, 'nobody has looked yet');
  const answers = await Promise.all(Array.from({ length: 30 }, () => loadPicture(email, githubOnly, probe)));
  assert.equal(calls, 1);
  assert.ok(answers.every((a) => a === answers[0] && a.includes('octocat')));
  assert.equal(peekPicture(email, githubOnly), answers[0]);
  await loadPicture(email, githubOnly, probe);
  assert.equal(calls, 1, 'remembered');
});

test('changing the sources, or the saved accounts, looks the author up again', async () => {
  let calls = 0;
  const probe = async () => (calls++, true);
  const email = 'jannes@example.com';
  assert.equal(await loadPicture(email, githubOnly, probe), null, 'nothing to try without a username');
  const withAccount = { ...githubOnly, accounts: [{ username: 'jannes09', email }] };
  assert.match(await loadPicture(email, withAccount, probe), /jannes09/);
  assert.match(await loadPicture(email, { ...withAccount, gravatar: true }, probe), /jannes09/);
  assert.notEqual(pictureKey(email, githubOnly), pictureKey(email, withAccount));
  assert.notEqual(pictureKey(email, withAccount), pictureKey(email, { ...withAccount, gravatar: true }));
});

test('a miss is looked at again after a while, a hit is kept', async () => {
  const email = 'octocat@users.noreply.github.com';
  await loadPicture(email, githubOnly, async () => false);
  assert.equal(peekPicture(email, githubOnly), null, 'a recent miss is remembered');
  assert.equal(peekPicture(email, githubOnly, Date.now() + MISS_TTL_MS + 1000), undefined, 'an old miss is tried again');
  forgetPictures();
  await loadPicture(email, githubOnly, async () => true);
  assert.ok(peekPicture(email, githubOnly, Date.now() + MISS_TTL_MS * 100));
});

test('only a few pictures are fetched at once', async () => {
  let running = 0;
  let most = 0;
  const probe = async () => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 8));
    running--;
    return true;
  };
  const emails = Array.from({ length: 40 }, (_, i) => `user${i}@users.noreply.github.com`);
  const found = await Promise.all(emails.map((e) => loadPicture(e, githubOnly, probe)));
  assert.ok(found.every(Boolean));
  assert.ok(most <= MAX_PROBES, `${most} at once`);
  assert.ok(most > 1, 'but they do run side by side');
});
