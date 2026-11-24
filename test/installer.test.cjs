'use strict';
// Run with: npm test
// The installer's optional desktop shortcut. The hooks in build/installer.nsh are compiled into a stand-in installer
// (test/fixtures/installer-harness.nsi) that runs them the way electron-builder's installer does, with the NSIS that
// electron-builder downloads. It only runs on Windows and when that NSIS is there (a build has been made once);
// otherwise those tests are skipped. The test shortcut has a name of its own, so a real GitGui shortcut is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('electron-builder is told not to create the desktop shortcut itself', () => {
  assert.equal(pkg.build.nsis.createDesktopShortcut, false);
  assert.equal(pkg.build.nsis.oneClick, false, 'the wizard (and so the page) is only shown by the assisted installer');
});

test('the installer script adds the page, the shortcut and its removal', () => {
  for (const hook of ['customInit', 'customPageAfterChangeDir', 'customInstall', 'customUnInstall']) {
    assert.match(nsh, new RegExp(`!macro ${hook}\\b`), hook);
  }
  assert.match(nsh, /Page custom gitguiTasksPage gitguiTasksPageLeave/);
  assert.match(nsh, /Create a &desktop shortcut/);
  assert.match(nsh, /click Install/, 'the page comes right before Install, so it says Install');
  // the box is ticked only when a shortcut already exists (an update keeps it); a fresh install starts unticked
  assert.match(nsh, /StrCpy \$gitguiDesktopShortcut "0"[\s\S]*FileExists\} "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"[\s\S]*StrCpy \$gitguiDesktopShortcut "1"/);
});

function findTools() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
  const find = (dir, test, depth = 4) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (test(e, p)) return p;
      if (e.isDirectory() && depth > 0) {
        const hit = find(p, test, depth - 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const makensis = find(path.join(cache, 'nsis-3.0.4.1'), (e) => e.isFile() && e.name === 'makensis.exe');
  const plugins = find(path.join(cache, 'nsis-resources-3.4.1'), (e, p) => e.isDirectory() && e.name === 'x86-unicode' && fs.existsSync(path.join(p, 'WinShell.dll')));
  return makensis && plugins ? { makensis, plugins } : null;
}
const tools = findTools();
const skip = tools ? false : 'needs Windows and the NSIS that electron-builder downloads (build the installer once)';

let desktop = null;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitgui-installer-test-'));
const exe = path.join(dir, 'harness.exe');
const logFile = path.join(os.tmpdir(), 'gitgui-installer-harness.log');
let lnk = null;
const cleanup = () => {
  if (lnk) fs.rmSync(lnk, { force: true });
  fs.rmSync(logFile, { force: true });
};
test.after(() => {
  cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'gitgui-installer-test'), { recursive: true, force: true });
});

test('the hooks compile as part of an installer, with every NSIS warning an error', { skip }, () => {
  desktop = execFileSync('powershell', ['-NoProfile', '-Command', '[Environment]::GetFolderPath("Desktop")'], { encoding: 'utf8' }).trim();
  lnk = path.join(desktop, 'GitGui Installer Test.lnk');
  const out = execFileSync(
    tools.makensis,
    ['-WX', '/V2', `/DOUT_FILE=${exe}`, `/DPLUGINS=${tools.plugins}`, `/DINSTALLER_NSH=${path.join(root, 'build', 'installer.nsh')}`, path.join(__dirname, 'fixtures', 'installer-harness.nsi')],
    { encoding: 'utf8' },
  );
  assert.ok(fs.existsSync(exe), out);
});

/** Runs the stand-in installer silently; `existing` first puts a dummy file where a desktop shortcut would be. */
function run(args, existing = false) {
  cleanup();
  if (existing) fs.writeFileSync(lnk, 'dummy');
  execFileSync(exe, ['/S', ...args]); // throws on a non-zero exit code
  const present = fs.existsSync(lnk);
  return { present, replaced: present && fs.readFileSync(lnk, 'latin1') !== 'dummy', log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '' };
}

test('a fresh install creates no desktop shortcut unless it is chosen', { skip }, () => {
  assert.equal(run([]).present, false, 'nothing chosen: no shortcut');
  assert.equal(run(['/CHOOSE=0']).present, false, 'box left unticked');
  const ticked = run(['/CHOOSE=1']);
  assert.equal(ticked.present, true, 'box ticked: shortcut created');
  assert.equal(ticked.replaced, true, 'and it is a real shortcut, written by the installer');
  assert.match(ticked.log, /chosen = 1/);
});

test('an update keeps the shortcut the user already has: the box starts ticked', { skip }, () => {
  const r = run([], true);
  assert.match(r.log, /chosen = 1/, 'the installer saw that a shortcut existed');
  assert.equal(r.replaced, true, 'and put it back');
});

test('unticking the box on an update does not recreate the shortcut', { skip }, () => {
  const r = run(['/CHOOSE=0'], true);
  assert.match(r.log, /chosen = 0/);
  assert.equal(r.replaced, false, 'the installer wrote nothing (the old uninstaller is what removes the old one)');
});

test('uninstalling removes the desktop shortcut, unless Setup is only replacing the old version', { skip }, () => {
  assert.equal(run(['/REMOVE=1'], true).present, false, 'removed');
  assert.equal(run(['/REMOVE=1', '/KEEP=1'], true).present, true, 'kept while upgrading');
  assert.equal(run(['/REMOVE=1']).present, false, 'nothing there, nothing to do, no error');
});
