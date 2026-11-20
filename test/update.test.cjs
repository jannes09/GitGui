// Run with: npm test
// Looking for a newer build in a local folder, and checking it before it is run.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { call } = require('../electron/handlers.cjs');
const { compareVersions, parseLatest } = require('../electron/updates.cjs');

const current = require('../package.json').version;
const bump = (v, part) => {
  const [a, b, c] = v.split('.').map(Number);
  return part === 'major' ? `${a + 1}.0.0` : part === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};

const made = [];
test.after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A folder shaped like electron-builder's output. Options let each test break one thing. */
function release({ version = bump(current, 'minor'), bytes = 'installer bytes', yml, file, sha } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-upd-'));
  made.push(dir);
  const name = file ?? `GitGui-Setup-${version}.exe`;
  if (bytes !== null) fs.writeFileSync(path.join(dir, `GitGui-Setup-${version}.exe`), bytes);
  const sum = sha ?? crypto.createHash('sha512').update(bytes ?? '').digest('base64');
  fs.writeFileSync(
    path.join(dir, 'latest.yml'),
    yml ??
      [
        `version: ${version}`,
        'files:',
        `  - url: ${name}`,
        `    sha512: ${sum}`,
        '    size: 15',
        `path: ${name}`,
        `sha512: ${sum}`,
        "releaseDate: '2026-11-20T09:48:31.739Z'",
        '',
      ].join('\r\n'),
  );
  return dir;
}
const check = async (folder) => {
  const r = await call('checkUpdate', { folder });
  assert.equal(r.ok, true, r.error);
  return r.data;
};

test('versions compare number by number, not as text', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(compareVersions('0.2.0', '0.10.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('latest.yml is read from its top-level keys, ignoring quotes and the files list', () => {
  const y = parseLatest("version: 1.2.3\nfiles:\n  - url: a.exe\n    sha512: inner\npath: a.exe\nsha512: outer\nreleaseDate: '2026-01-02T03:04:05.000Z'\n");
  assert.equal(y.version, '1.2.3');
  assert.equal(y.sha512, 'outer');
  assert.equal(y.releaseDate, '2026-01-02T03:04:05.000Z');
});

test('a higher version in the folder is offered', async () => {
  const dir = release({ version: bump(current, 'minor') });
  const r = await check(dir);
  assert.equal(r.available, true);
  assert.equal(r.current, current);
  assert.equal(r.latest, bump(current, 'minor'));
  assert.equal(r.error, null);
  assert.equal(r.size, 'installer bytes'.length);
  assert.equal(r.releaseDate, '2026-11-20T09:48:31.739Z');
  assert.equal(r.folder, dir);
});

test('a patch release counts, and a major one too', async () => {
  assert.equal((await check(release({ version: bump(current, 'patch') }))).available, true);
  assert.equal((await check(release({ version: bump(current, 'major') }))).available, true);
});

test('the same version, or an older one, is not offered', async () => {
  const same = await check(release({ version: current }));
  assert.equal(same.available, false);
  assert.equal(same.latest, current);
  assert.equal(same.error, null);
  const [a, b, c] = current.split('.').map(Number);
  if (c > 0) assert.equal((await check(release({ version: `${a}.${b}.${c - 1}` }))).available, false);
});

test('a missing folder or latest.yml is reported, not thrown', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-upd-'));
  made.push(empty);
  const r = await check(empty);
  assert.equal(r.available, false);
  assert.match(r.error, /no latest\.yml/i);
  const gone = await check(path.join(empty, 'nope'));
  assert.equal(gone.available, false);
  assert.match(gone.error, /does not exist or cannot be reached/);
});

test('a relative folder is refused', async () => {
  const r = await check('release');
  assert.equal(r.available, false);
  assert.match(r.error, /full path/);
});

test('a latest.yml that is damaged or points somewhere odd is refused', async () => {
  const v = bump(current, 'minor');
  const sum = crypto.createHash('sha512').update('x').digest('base64');
  const bad = [
    ['no version', 'path: GitGui-Setup-9.9.9.exe\nsha512: ' + sum + '\n', /valid version/],
    ['version not numeric', `version: latest\npath: GitGui-Setup-${v}.exe\nsha512: ${sum}\n`, /valid version/],
    ['path climbs out of the folder', `version: ${v}\npath: ..\\GitGui-Setup-${v}.exe\nsha512: ${sum}\n`, /installer/],
    ['path is another program', `version: ${v}\npath: evil.exe\nsha512: ${sum}\n`, /installer/],
    ['path names another version', `version: ${v}\npath: GitGui-Setup-${bump(v, 'major')}.exe\nsha512: ${sum}\n`, /installer/],
    ['checksum is not a sha512', `version: ${v}\npath: GitGui-Setup-${v}.exe\nsha512: abc\n`, /checksum/],
  ];
  for (const [what, yml, expected] of bad) {
    const r = await check(release({ version: v, yml }));
    assert.equal(r.available, false, what);
    assert.match(r.error, expected, what);
  }
});

test('an installer that is listed but missing is reported', async () => {
  const r = await check(release({ bytes: null }));
  assert.equal(r.available, false);
  assert.match(r.error, /not in/);
});

test('verifying passes for an intact newer installer and returns where it is', async () => {
  const v = bump(current, 'minor');
  const dir = release({ version: v });
  const r = await call('verifyUpdate', { folder: dir, version: v });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.version, v);
  assert.equal(r.data.installer, path.join(dir, `GitGui-Setup-${v}.exe`));
});

test('verifying refuses an installer whose checksum does not match', async () => {
  const v = bump(current, 'minor');
  const dir = release({ version: v });
  fs.writeFileSync(path.join(dir, `GitGui-Setup-${v}.exe`), 'half written');
  const r = await call('verifyUpdate', { folder: dir, version: v });
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum/);
});

test('verifying refuses when the folder no longer holds the version the user was told about', async () => {
  const dir = release({ version: bump(current, 'minor') });
  const r = await call('verifyUpdate', { folder: dir, version: bump(current, 'major') });
  assert.equal(r.ok, false);
  assert.match(r.error, /Check again/);
});

test('verifying refuses a folder with nothing newer', async () => {
  const r = await call('verifyUpdate', { folder: release({ version: current }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no newer version/i);
});

test('with no folder given the default is used (GITGUI_UPDATE_DIR first)', async () => {
  const dir = release();
  process.env.GITGUI_UPDATE_DIR = dir;
  try {
    const r = await check(undefined);
    assert.equal(r.folder, dir);
    assert.equal(r.available, true);
    assert.equal((await check('   ')).folder, dir, 'a blank setting means the default too');
  } finally {
    delete process.env.GITGUI_UPDATE_DIR;
  }
});
