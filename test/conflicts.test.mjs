// Run with: npm test
// The conflict-marker parser used by the resolver (src/conflicts.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chosenLines, compose, conflictCount, hasMarkers, parseConflicts } from '../src/conflicts.ts';

const FILE = 'top\n<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs 1\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\nbottom\n';
const none = { ours: false, theirs: false };

test('splits a file into text and conflicts, keeping the labels', () => {
  const p = parseConflicts(FILE);
  assert.equal(conflictCount(p), 2);
  assert.deepEqual(p.segments.map((s) => s.kind), ['text', 'conflict', 'text', 'conflict', 'text']);
  const c = p.segments[1];
  assert.deepEqual(c.ours, ['ours 1', 'ours 2']);
  assert.deepEqual(c.theirs, ['theirs 1']);
  assert.equal(c.oursLabel, 'HEAD');
  assert.equal(c.theirsLabel, 'feature');
  assert.equal(c.base, null);
  assert.equal(p.finalNewline, true);
});

test('composing with no choices gives the original file back', () => {
  const p = parseConflicts(FILE);
  assert.equal(compose(p, [none, none]), FILE);
});

test('ours, theirs and both', () => {
  const p = parseConflicts(FILE);
  assert.equal(compose(p, [{ ours: true, theirs: false }, { ours: false, theirs: true }]), 'top\nours 1\nours 2\nmiddle\ny\nbottom\n');
  assert.equal(
    compose(p, [{ ours: true, theirs: true }, { ours: true, theirs: true }]),
    'top\nours 1\nours 2\ntheirs 1\nmiddle\nx\ny\nbottom\n',
    'both keeps ours first',
  );
  // a partly resolved file keeps the markers of the conflict that is left
  const half = compose(p, [{ ours: true, theirs: false }, none]);
  assert.match(half, /<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\nbottom\n$/);
  assert.equal(hasMarkers(half), true);
  assert.equal(hasMarkers(compose(p, [{ ours: true, theirs: false }, { ours: true, theirs: false }])), false);
});

test('reads diff3 style markers with the common ancestor', () => {
  const p = parseConflicts('<<<<<<< HEAD\nA\n||||||| base\nO\n=======\nB\n>>>>>>> topic\n');
  const c = p.segments[0];
  assert.deepEqual([c.ours, c.base, c.theirs], [['A'], ['O'], ['B']]);
  assert.equal(compose(p, [none]), '<<<<<<< HEAD\nA\n||||||| base\nO\n=======\nB\n>>>>>>> topic\n');
  assert.equal(compose(p, [{ ours: false, theirs: true }]), 'B\n');
});

test('keeps Windows line endings and a missing final newline', () => {
  const crlf = 'a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> t\r\nz\r\n';
  const p = parseConflicts(crlf);
  assert.equal(conflictCount(p), 1);
  assert.equal(compose(p, [{ ours: false, theirs: true }]), 'a\r\ny\r\nz\r\n');

  const noEol = parseConflicts('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> t\nlast');
  assert.equal(noEol.finalNewline, false);
  assert.equal(compose(noEol, [{ ours: true, theirs: false }]), 'a\nx\nlast');
});

test('a file with no conflicts is one text segment', () => {
  const p = parseConflicts('just\ntext\n');
  assert.equal(conflictCount(p), 0);
  assert.equal(compose(p, []), 'just\ntext\n');
  assert.equal(compose(parseConflicts(''), []), '');
});

test('ordinary lines that look a bit like markers are left alone', () => {
  const text = 'Title\n=======\n<<<<<<<<< eight\n  <<<<<<< indented\n';
  const p = parseConflicts(text);
  assert.equal(conflictCount(p), 0);
  assert.equal(compose(p, []), text);
  assert.equal(hasMarkers('Title\n=======\n'), false, 'a Markdown heading is not a conflict');
});

test('malformed markers are rejected instead of guessed at', () => {
  assert.equal(parseConflicts('<<<<<<< HEAD\nx\n=======\ny\n'), null, 'never closed');
  assert.equal(parseConflicts('<<<<<<< HEAD\n<<<<<<< again\n=======\n>>>>>>> t\n'), null, 'nested');
  assert.equal(parseConflicts('<<<<<<< HEAD\nx\n>>>>>>> t\n'), null, 'no separator');
  assert.equal(parseConflicts('<<<<<<< HEAD\nx\n=======\ny\n=======\nz\n>>>>>>> t\n'), null, 'two separators');
});

test('choosing nothing is the only choice that keeps markers', () => {
  const c = parseConflicts('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> t\n').segments[0];
  assert.equal(chosenLines(c, none)[0], '<<<<<<< HEAD');
  assert.deepEqual(chosenLines(c, { ours: true, theirs: false }), ['x']);
});
