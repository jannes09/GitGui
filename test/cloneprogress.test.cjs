'use strict';
// Run with: npm test
// Reading `git clone --progress` output (electron/cloneprogress.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, createProgressParser } = require('../electron/cloneprogress.cjs');

test('parses a download line', () => {
  const p = parseLine('Receiving objects:  50% (55/110), 1.20 MiB | 2.00 MiB/s');
  assert.equal(p.step, 'Receiving objects');
  assert.equal(p.percent, 40); // 10 + 60 * 50%
  assert.equal(p.detail, '1.20 MiB | 2.00 MiB/s');
});

test('parses remote lines and finished steps', () => {
  assert.equal(parseLine('remote: Counting objects: 100% (3/3), done.').percent, 5);
  assert.equal(parseLine('Receiving objects: 100% (110/110), 1.20 MiB | 2.00 MiB/s, done.').detail, '1.20 MiB | 2.00 MiB/s');
  assert.equal(parseLine('Resolving deltas: 100% (9/9), done.').percent, 85);
  assert.equal(parseLine('Updating files: 100% (12/12), done.').percent, 100);
});

test('ignores lines that are not progress', () => {
  for (const l of ["Cloning into 'x'...", 'remote: Enumerating objects: 3, done.', 'warning: something', '', 'Foo bar: 10% (1/10)']) {
    assert.equal(parseLine(l), null, l);
  }
});

test('handles carriage returns and chunks that end mid-line, and never goes backwards', () => {
  const seen = [];
  const parser = createProgressParser((p) => seen.push(`${p.step} ${p.percent}`));
  parser.write(Buffer.from("Cloning into 'x'...\nReceiving objects:  10% (1/10)\rReceiving obj"));
  parser.write(Buffer.from('ects:  20% (2/10)\rReceiving objects:  20% (2/10)\r'));
  parser.write(Buffer.from('remote: Counting objects: 100% (3/3), done.\n')); // out of order: bar stays put
  parser.write(Buffer.from('Resolving deltas: 100% (9/9)'));
  parser.end();
  assert.deepEqual(seen, ['Receiving objects 16', 'Receiving objects 22', 'Resolving deltas 85']);
});
