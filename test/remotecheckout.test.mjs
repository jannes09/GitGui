// Run with: npm test
// What can be checked out from a commit, and the question before a remote branch is checked out over a local one
// (src/remoteCheckout.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutTargets, resetPrompt } from '../src/remoteCheckout.ts';

const local = (name, hash, current = false) => ({ name, hash, current });
const remote = (name, hash) => ({ name, hash });
const info = (over = {}) => ({
  local: 'master',
  remote: 'origin/master',
  localHash: 'a'.repeat(40),
  remoteHash: 'b'.repeat(40),
  ahead: 0,
  behind: 2,
  relation: 'behind',
  current: false,
  upstream: 'origin/master',
  ...over,
});

test('a remote branch with no local branch is offered as a new local branch', () => {
  const t = checkoutTargets([local('feature', 'F')], [remote('origin/topic', 'T')], 'T');
  assert.deepEqual(t, [{ name: 'origin/topic', kind: 'remote', label: 'Checkout origin/topic (new local branch)' }]);
});

test('a remote branch whose local branch is on another commit is offered too: the app asks about resetting', () => {
  // local master is on M1 (behind), origin/master is on M3: there used to be no way to check out M3's branch
  const t = checkoutTargets([local('master', 'M1'), local('feature', 'F', true)], [remote('origin/master', 'M3')], 'M3');
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'remote');
  assert.equal(t[0].name, 'origin/master');
  assert.match(t[0].label, /reset local master to here/);
});

test('when the local branch is on the same commit, only it is offered', () => {
  const t = checkoutTargets([local('master', 'M1'), local('feature', 'F', true)], [remote('origin/master', 'M1')], 'M1');
  assert.deepEqual(t.map((x) => [x.name, x.kind]), [['master', 'local']]);
});

test('the branch that is checked out is not offered, and nothing is offered where no branch points', () => {
  assert.deepEqual(checkoutTargets([local('master', 'M1', true)], [], 'M1'), []);
  assert.deepEqual(checkoutTargets([local('master', 'M1', true)], [remote('origin/master', 'M1')], 'M1'), [], 'current local branch, remote beside it');
  assert.deepEqual(checkoutTargets([local('master', 'M1')], [remote('origin/master', 'M1')], 'ELSEWHERE'), []);
});

test('several branches at one commit are all offered, local ones first', () => {
  const t = checkoutTargets(
    [local('dev', 'X'), local('master', 'M1')],
    [remote('origin/dev', 'X'), remote('origin/master', 'X'), remote('origin/new', 'X')],
    'X',
  );
  assert.deepEqual(t.map((x) => `${x.kind}:${x.name}`), ['local:dev', 'remote:origin/master', 'remote:origin/new']);
});

test('a remote name with a slash in the branch keeps its local name', () => {
  const t = checkoutTargets([local('feature/x', 'OLD')], [remote('origin/feature/x', 'NEW')], 'NEW');
  assert.match(t[0].label, /reset local feature\/x to here/);
});

test('nothing is asked when there is no local branch or it is already there', () => {
  assert.equal(resetPrompt(info({ relation: 'none', localHash: null, behind: 0 })), null);
  assert.equal(resetPrompt(info({ relation: 'same', behind: 0 })), null);
});

test('a local branch that is only behind is reset without a warning, and nothing is lost', () => {
  const p = resetPrompt(info());
  assert.equal(p.title, 'Reset local master to origin/master?');
  assert.match(p.message, /master is 2 commits behind origin\/master/);
  assert.match(p.message, /Nothing is lost/);
  assert.equal(p.danger, false);
  assert.equal(p.confirm, 'Reset master and check it out');
  assert.equal(p.keep, 'Just check out master');
  assert.match(resetPrompt(info({ behind: 1 })).message, /1 commit behind/);
});

test('local commits that would leave the branch make it a warning, and say they can be brought back', () => {
  const ahead = resetPrompt(info({ relation: 'ahead', ahead: 3, behind: 0 }));
  assert.equal(ahead.danger, true);
  assert.match(ahead.message, /master has 3 commits that origin\/master does not have/);
  assert.match(ahead.message, /takes them off the branch/);
  assert.match(ahead.message, /Ctrl\+Z brings them back/);
  assert.match(resetPrompt(info({ relation: 'ahead', ahead: 1, behind: 0 })).message, /1 commit that origin\/master does not have.*takes it off.*brings it back/);

  const diverged = resetPrompt(info({ relation: 'diverged', ahead: 2, behind: 5 }));
  assert.equal(diverged.danger, true);
  assert.match(diverged.message, /gone different ways/);
  assert.match(diverged.message, /master has 2 commits that origin\/master does not have/);
  assert.match(diverged.message, /origin\/master has 5 commits that master does not\./);
  assert.match(diverged.message, /takes your 2 commits off the branch/);
});

test('on the branch that is already checked out there is nothing to "just check out"', () => {
  const p = resetPrompt(info({ current: true }));
  assert.equal(p.keep, null);
  assert.equal(p.confirm, 'Reset master');
});

test("a local branch that tracks another remote's branch is told it keeps doing so", () => {
  const p = resetPrompt(info({ remote: 'upstream/master', upstream: 'origin/master' }));
  assert.match(p.message, /master keeps tracking origin\/master\./);
  assert.equal(p.title, 'Reset local master to upstream/master?');
  // nothing to add when it tracks the very branch it is reset to, or tracks nothing
  assert.doesNotMatch(resetPrompt(info()).message, /keeps tracking/);
  assert.doesNotMatch(resetPrompt(info({ upstream: null })).message, /keeps tracking/);
  // and it reads right with the warning variants too
  const warning = resetPrompt(info({ relation: 'diverged', ahead: 1, behind: 1, remote: 'upstream/master' })).message;
  assert.match(warning, /Ctrl\+Z brings it back\. master keeps tracking origin\/master\.$/);
});
