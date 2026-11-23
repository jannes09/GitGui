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

import { mergedPrNumber, pullRequestUrl } from '../src/pullRequests.ts';

test('the pull request a commit was merged by is read from its subject', () => {
  // GitHub: the merge commit, and a squash or rebase merge
  assert.equal(mergedPrNumber('Merge pull request #6 from jannes09/feature/force-push', 'github'), 6);
  assert.equal(mergedPrNumber('Merge pull request #1706 from acme/feature/JSM/add_nozzle_reader_page', 'github'), 1706);
  assert.equal(mergedPrNumber('Add force push for rewritten branches (#6)', 'github'), 6);
  assert.equal(mergedPrNumber('Add force push (#6)  ', 'github'), 6);
  // Azure DevOps
  assert.equal(mergedPrNumber('Merged PR 1704: SCMX Image and Firmware Dialog', 'azure'), 1704);
});

test('a subject that does not name a pull request, or names it in another provider\'s way, gives nothing', () => {
  for (const subject of ['Fix lint issues', 'Merge branch \'dev\' into feature/x', 'Merge remote-tracking branch \'origin/dev\' into f', 'Revert "Add x (#12)"', 'Mention PR #12 in the docs', '(#12) at the start', 'Merge pull request #x from a/b', '']) {
    assert.equal(mergedPrNumber(subject, 'github'), null, subject);
  }
  assert.equal(mergedPrNumber('Merge pull request #6 from a/b', 'azure'), null, 'Azure says "Merged PR"');
  assert.equal(mergedPrNumber('Merged PR 6: Title', 'github'), null, 'GitHub says "Merge pull request"');
  assert.equal(mergedPrNumber('Title (#6)', 'azure'), null);
  assert.equal(mergedPrNumber('Merge pull request #6 from a/b', null), null, 'a host we do not know');
  assert.equal(mergedPrNumber(undefined, 'github'), null);
  assert.equal(mergedPrNumber('Merge pull request #0 from a/b', 'github'), null);
  assert.equal(mergedPrNumber('Merge pull request #1234567890 from a/b', 'github'), null, 'absurdly long numbers are not pull requests');
});

test('the pull request page is built from the remote and the number', () => {
  assert.equal(pullRequestUrl(gh, 6), 'https://github.com/acme/widgets/pull/6');
  assert.equal(pullRequestUrl(az, 1704), 'https://dev.azure.com/acme/Proj/_git/widgets/pullrequest/1704');
  assert.equal(pullRequestUrl({ provider: null }, 6), null);
  assert.equal(pullRequestUrl({ provider: 'github' }, 6), null, 'no address, no link');
  for (const bad of [0, -1, 1.5, NaN, Infinity]) assert.equal(pullRequestUrl(gh, bad), null, String(bad));
  assert.ok(isSafePrUrl(pullRequestUrl(gh, 6)) && isSafePrUrl(pullRequestUrl(az, 6)), 'and it is a page the app will open');
});
