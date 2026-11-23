// Run with: npm test
// The words of the force push confirmation (src/forcePush.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { forcePushNotice, forcePushText } from '../src/forcePush.ts';

const sha = (n) => String(n).padStart(40, 'a');
const lost = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ hash: sha(from + i), author: 'JannesVenter', date: 0, subject: `commit ${from + i}` }));
const info = (over = {}) => ({
  branch: 'feature/x',
  remote: 'origin',
  head: sha(9),
  remoteTip: sha(1),
  relation: 'diverged',
  lost: lost(1),
  lostTotal: 1,
  localOnly: 3,
  ...over,
});

test('only a branch that really would be replaced gets the confirmation; the rest are told what to do instead', () => {
  assert.equal(forcePushNotice(info()), null);
  assert.equal(forcePushNotice(info({ relation: 'behind', localOnly: 0 })), null);
  assert.match(forcePushNotice(info({ relation: 'gone', remoteTip: null, lost: [], lostTotal: 0 })), /not on the remote.*Push/);
  assert.match(forcePushNotice(info({ relation: 'same', lost: [], lostTotal: 0, localOnly: 0 })), /already matches/);
  assert.match(forcePushNotice(info({ relation: 'ahead', lost: [], lostTotal: 0 })), /normal push/);
});

test('the commits that would be lost are listed with a short id, the subject and the author', () => {
  const t = forcePushText(info(), false);
  assert.equal(t.title, 'Replace origin/feature/x?');
  assert.equal(t.detail, 'aaaaaaa  commit 1  (JannesVenter)');
  assert.match(t.message, /origin\/feature\/x has 1 commit that is not in your branch/);
  assert.match(t.message, /drops it from the remote/);
  assert.equal(t.confirm, 'Force push');
});

test('several commits are plural, and the ones beyond the list are counted', () => {
  const t = forcePushText(info({ lost: lost(20), lostTotal: 25 }), false);
  assert.match(t.message, /has 25 commits that are not in your branch/);
  assert.match(t.message, /drops them/);
  const lines = t.detail.split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[20], '…and 5 more');
});

test('a long subject is cut so the list stays readable', () => {
  const t = forcePushText(info({ lost: [{ hash: sha(1), author: 'A', date: 0, subject: 'x'.repeat(200) }] }), false);
  const line = t.detail.split('\n')[0];
  assert.ok(line.length < 100, line);
  assert.ok(line.includes('…'));
});

test('the note says what takes their place, when to use this, and that a late push is not overwritten', () => {
  const t = forcePushText(info(), false);
  assert.match(t.note, /3 commits the remote does not have/);
  assert.match(t.note, /rewrote the branch/);
  assert.match(t.note, /cancel and pull first/i);
  assert.match(t.note, /nothing is overwritten/);
  assert.match(forcePushText(info({ localOnly: 1 }), false).note, /1 commit the remote does not have/);
});

test('a branch that is only behind says the remote would move back', () => {
  const t = forcePushText(info({ relation: 'behind', localOnly: 0 }), false);
  assert.match(t.note, /behind the remote one.*moves back/);
});

test('a main branch gets a warning first', () => {
  assert.match(forcePushText(info({ branch: 'main' }), true).message, /^main is one of your main branches, so everyone who uses it will be affected\./);
  assert.doesNotMatch(forcePushText(info(), false).message, /main branches/);
});
