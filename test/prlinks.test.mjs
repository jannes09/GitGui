// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrUrl, isSafePrUrl, publishedName } from '../src/pullRequests.ts';

const gh = { provider: 'github', webUrl: 'https://github.com/acme/widgets' };
const az = { provider: 'azure', webUrl: 'https://dev.azure.com/acme/Proj/_git/widgets' };

test('create-PR links', () => {
  assert.equal(createPrUrl(gh, 'feature/new thing'), 'https://github.com/acme/widgets/pull/new/feature/new%20thing');
  assert.equal(createPrUrl(az, 'bug/x'), 'https://dev.azure.com/acme/Proj/_git/widgets/pullrequestcreate?sourceRef=bug%2Fx');
  assert.equal(createPrUrl({ provider: null }, 'x'), null);
});

test('only pages on the known hosts may be opened', () => {
  assert.equal(isSafePrUrl('https://github.com/acme/widgets/pull/3'), true);
  assert.equal(isSafePrUrl('https://dev.azure.com/o/p/_git/r/pullrequest/9'), true);
  assert.equal(isSafePrUrl('https://acme.visualstudio.com/p/_git/r/pullrequest/9'), true);
  for (const bad of ['http://github.com/a/b', 'https://github.com.evil.example/a', 'javascript:alert(1)', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(isSafePrUrl(bad), false, bad);
  }
});

test('a branch is matched by the name it is published under', () => {
  assert.equal(publishedName('fix/thing', 'origin/fix/thing'), 'fix/thing');
  assert.equal(publishedName('local-name', 'origin/other-name'), 'other-name');
  assert.equal(publishedName('only-local', null), 'only-local');
});
