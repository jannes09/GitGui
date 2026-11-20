// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAIN_BRANCHES, DEFAULT_SETTINGS, parseSettings } from '../src/settings.ts';
import { branchGroup, branchMatcher, labelRank } from '../src/refLabels.ts';

test('missing or broken stored settings give the defaults', () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('not json'), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('42'), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings('null'), DEFAULT_SETTINGS);
});

test('stored values override the defaults, one by one', () => {
  const s = parseSettings(JSON.stringify({ laneBold: false, mainBranches: 'dev', prLookups: false }));
  assert.equal(s.laneBold, false);
  assert.equal(s.prLookups, false);
  assert.equal(s.mainBranches, 'dev');
  assert.equal(s.lanePin, true, 'untouched settings keep their default');
});

test('values of the wrong type are ignored', () => {
  const s = parseSettings(JSON.stringify({ laneBold: 'yes', lanePin: 1, mainBranches: 7, unknown: true }));
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.equal('unknown' in s, false);
});

test('an absurdly long branch list is cut', () => {
  assert.equal(parseSettings(JSON.stringify({ mainBranches: 'a'.repeat(5000) })).mainBranches.length, 400);
});

test('the update settings default to checking at start-up, in the default folder, skipping nothing', () => {
  assert.equal(DEFAULT_SETTINGS.updateCheck, true);
  assert.equal(DEFAULT_SETTINGS.updateFolder, '');
  assert.equal(DEFAULT_SETTINGS.skippedUpdate, '');
});

test('the update settings are read back, and text of the wrong type or length is not trusted', () => {
  const s = parseSettings(JSON.stringify({ updateCheck: false, updateFolder: 'D:\\Builds\\release', skippedUpdate: '0.3.0' }));
  assert.equal(s.updateCheck, false);
  assert.equal(s.updateFolder, 'D:\\Builds\\release');
  assert.equal(s.skippedUpdate, '0.3.0');
  const bad = parseSettings(JSON.stringify({ updateCheck: 'no', updateFolder: 5, skippedUpdate: { v: 1 } }));
  assert.equal(bad.updateCheck, true);
  assert.equal(bad.updateFolder, '');
  assert.equal(bad.skippedUpdate, '');
  assert.equal(parseSettings(JSON.stringify({ updateFolder: 'x'.repeat(5000) })).updateFolder.length, 400);
  assert.equal(parseSettings(JSON.stringify({ skippedUpdate: '1'.repeat(99) })).skippedUpdate.length, 20);
});

test('the branch list matches whole names, ignoring case, with * as a wildcard', () => {
  const isMain = branchMatcher(DEFAULT_MAIN_BRANCHES);
  for (const name of ['main', 'master', 'dev', 'Develop', 'DEVELOPMENT', 'trunk', 'staging', 'production', 'release', 'release/2.4']) {
    assert.equal(isMain(name), true, name);
  }
  for (const name of ['feature/dev', 'dev/thing', 'devops', 'main-menu', 'releases', 'bugfix/release', '']) {
    assert.equal(isMain(name), false, name);
  }
});

test('the branch list accepts commas, spaces and new lines, and treats special characters literally', () => {
  const isMain = branchMatcher('qa\n  hotfix/*,v1.0 (old)');
  assert.equal(isMain('qa'), true);
  assert.equal(isMain('hotfix/urgent'), true);
  assert.equal(isMain('v1.0'), true);
  assert.equal(isMain('v1x0'), false, 'a dot is a dot, not "any character"');
  assert.equal(branchMatcher('')('main'), false, 'an empty list marks nothing');
  assert.equal(branchMatcher('a+b')('aab'), false);
});

test('main branches get a signature colour group', () => {
  assert.equal(branchGroup('dev'), 0);
  assert.equal(branchGroup('Develop'), 0);
  assert.equal(branchGroup('main'), 1);
  assert.equal(branchGroup('master'), 1);
  assert.equal(branchGroup('release/2.4'), 2);
  assert.equal(branchGroup('qa'), 2);
});

test('pills are ordered: checked out, main branches, other local, remote-only, tags', () => {
  const isMain = branchMatcher(DEFAULT_MAIN_BRANCHES);
  const labels = [
    ['tag', false, 'v1.0'],
    ['remote', false, 'feature/RH/add_key_control'],
    ['branch', false, 'feature/JSM/add_telemetry_units_page'],
    ['remote', false, 'dev'],
    ['branch', false, 'dev'],
    ['branch', true, 'feature/current-work'],
  ];
  const sorted = [...labels].sort((a, b) => labelRank(a[0], a[1], a[2], isMain) - labelRank(b[0], b[1], b[2], isMain)).map((l) => `${l[0]}:${l[2]}`);
  assert.deepEqual(sorted, [
    'branch:feature/current-work',
    'branch:dev',
    'remote:dev',
    'branch:feature/JSM/add_telemetry_units_page',
    'remote:feature/RH/add_key_control',
    'tag:v1.0',
  ]);
});
