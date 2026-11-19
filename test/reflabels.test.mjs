// Run with: npm test
// How branch / tag pills are shortened and chosen (src/refLabels.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAR_W, OVERFLOW_W, PILL_CHROME, fitLabels, pillWidth, shortenRef } from '../src/refLabels.ts';

test('names that fit are left alone', () => {
  assert.equal(shortenRef('main', 20), 'main');
  assert.equal(shortenRef('feature/login', 13), 'feature/login');
});

test('long paths keep the first folder and the end', () => {
  assert.equal(shortenRef('feature/WF/Scheduler-rewrite', 27), 'feature/…/Scheduler-rewrite');
  assert.equal(shortenRef('feature/RH/add_device_reassignment', 33), 'feature/…/add_device_reassignment');
});

test('when the folder hint does not fit, the whole last part is kept instead', () => {
  assert.equal(shortenRef('feature/WF/Scheduler-rewrite', 22), '…/Scheduler-rewrite');
  assert.equal(shortenRef('origin/maintenance/2026-hotfix', 17), '…/2026-hotfix');
});

test('when that is still too long the middle of the end part is cut', () => {
  const s = shortenRef('feature/WF/Scheduler-rewrite-for-pumps', 22);
  assert.ok(s.length <= 22, s);
  assert.ok(s.startsWith('feature/…/'), s);
  assert.ok(s.endsWith('pumps'), 'the distinctive end must survive: ' + s);
});

test('a single long word keeps both its ends', () => {
  const s = shortenRef('abcdefghijklmnopqrstuvwxyz', 11);
  assert.equal(s.length, 11);
  assert.ok(s.startsWith('abc') && s.endsWith('xyz'), s);
  assert.ok(s.includes('…'));
});

test('never returns something longer than the limit, even for tiny limits', () => {
  for (const name of ['feature/a/b/c', 'x'.repeat(60), 'a/b']) {
    for (let max = 4; max < 40; max++) assert.ok(shortenRef(name, max).length <= Math.max(max, name.length <= max ? name.length : 0), `${name} @ ${max}`);
  }
});

const item = (text, extra = 15) => ({ text, extra });

test('shows every pill when there is room', () => {
  const items = [item('main'), item('origin/dev'), item('v1.0')];
  const r = fitLabels(items, 400);
  assert.equal(r.shown.length, 3);
  assert.equal(r.hidden.length, 0);
  assert.ok(r.shown.every((s) => !s.shortened));
});

test('hides what does not fit behind "+N" and keeps the most important first', () => {
  const items = [item('feature/first-branch'), item('feature/second-branch'), item('feature/third-branch'), item('tag-one')];
  const r = fitLabels(items, 260);
  assert.equal(r.shown[0].item.text, 'feature/first-branch');
  assert.ok(r.hidden.length >= 1);
  assert.equal(r.shown.length + r.hidden.length, items.length);
  const used = r.shown.reduce((n, s, i) => n + (i ? 4 : 0) + pillWidth(s.item, s.text), 0);
  assert.ok(used + OVERFLOW_W + 4 <= 260, 'the "+N" pill must also fit');
});

test('a first pill that is too wide on its own is shortened, never dropped', () => {
  const long = 'feature/JSM-1234/implement-the-whole-thing-properly';
  const r = fitLabels([item(long), item('main')], 150);
  assert.equal(r.shown.length, 1);
  assert.equal(r.shown[0].shortened, true);
  assert.ok(r.shown[0].text.length < long.length);
  assert.ok(pillWidth(r.shown[0].item, r.shown[0].text) + OVERFLOW_W + 4 <= 150 + CHAR_W, 'fits the column');
  assert.equal(r.hidden.length, 1);
});

test('a lone label can use the whole column, with no room kept for "+N"', () => {
  const text = 'origin/maintenance/2026-hotfix';
  const w = Math.ceil(pillWidth(item(text))) + 1;
  const r = fitLabels([item(text)], w);
  assert.equal(r.shown[0].shortened, false);
  assert.equal(r.hidden.length, 0);
});

test('no labels, no output', () => {
  assert.deepEqual(fitLabels([], 200), { shown: [], hidden: [] });
  assert.ok(PILL_CHROME > 0);
});
