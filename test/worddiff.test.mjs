// Run with: npm test (Node strips the TypeScript types when importing wordDiff.ts)
import test from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff } from '../src/wordDiff.ts';

const changedText = (segs) => segs.filter((s) => s.changed).map((s) => s.text);
const joined = (segs) => segs.map((s) => s.text).join('');

test('highlights only the added parameter, not the whole line', () => {
  const before = 'const Row = memo(function Row({ row, top, onSelect, onContext }: RowProps) {';
  const after = 'const Row = memo(function Row({ row, top, onSelect, onContext, onActivate }: RowProps) {';
  const d = wordDiff(before, after);
  assert.ok(d);
  assert.deepEqual(changedText(d.a), []);
  assert.deepEqual(changedText(d.b), [', onActivate']);
  assert.equal(joined(d.a), before);
  assert.equal(joined(d.b), after);
});

test('highlights a changed word on both sides', () => {
  const d = wordDiff('const color = red;', 'const color = blue;');
  assert.ok(d);
  assert.deepEqual(changedText(d.a), ['red']);
  assert.deepEqual(changedText(d.b), ['blue']);
});

test('segments always reassemble into the original line', () => {
  const pairs = [
    ['  foo(a, b)', '  foo(a, b, c)'],
    ['x = 1', 'y = 1'],
    ['a  b', 'a b'],
    ['if (ok) {', 'if (!ok) {'],
  ];
  for (const [a, b] of pairs) {
    const d = wordDiff(a, b);
    if (!d) continue;
    assert.equal(joined(d.a), a);
    assert.equal(joined(d.b), b);
  }
});

test('lines that are mostly different get no word highlighting', () => {
  assert.equal(wordDiff('alpha beta gamma delta', 'one two three four'), null);
});

test('empty or very long lines are skipped', () => {
  assert.equal(wordDiff('', 'abc'), null);
  assert.equal(wordDiff('a '.repeat(500), 'b '.repeat(500)), null);
});
