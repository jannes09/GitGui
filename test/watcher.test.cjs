// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRepoWatcher, isRelevant, outsideGitDirs, makeIgnoreMatcher } = require('../electron/watcher.cjs');
const { call } = require('../electron/handlers.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls until `cond()` is true (or the time is up), so a slow machine only makes a test slower, never wrong. */
async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}
const made = [];
function tmp(prefix = 'gitgui-watch-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
test.after(() => {
  for (const d of made) {
    try {
      for (const f of fs.readdirSync(d, { recursive: true })) {
        try {
          fs.chmodSync(path.join(d, f), 0o666);
        } catch {
          /* gone */
        }
      }
    } catch {
      /* gone */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repoWith(files = {}) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@e.c');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

/* ---------- which changes count ---------- */

test('working tree files are relevant, generated folders are not (until git has said what it ignores)', () => {
  for (const p of ['README.md', 'src/App.tsx', 'src\\app\\x.ts', 'build/icon.png', 'yarn.lock']) assert.equal(isRelevant(p), true, p);
  for (const p of ['node_modules/a/b.js', 'web/node_modules/x', 'Web\\bin\\Debug\\a.dll', 'obj/x', 'dist/index.html', '.vs/x']) {
    assert.equal(isRelevant(p), false, p);
  }
});

test('inside .git only the index, HEAD, refs and the exclude file count', () => {
  for (const p of ['.git/index', '.git\\HEAD', '.git/refs/heads/main', '.git/refs/tags/v1', '.git/packed-refs', '.git/MERGE_HEAD', '.git/rebase-merge/done', '.git/info/exclude']) {
    assert.equal(isRelevant(p), true, p);
  }
  for (const p of ['.git', '.git/objects', '.git/objects/ab/cdef', '.git/index.lock', '.git/refs/heads/main.lock', '.git/logs/HEAD', '.git/FETCH_HEAD', '.git/config', '.git/COMMIT_EDITMSG', '.git/info/exclude.lock', '.git/info/other']) {
    assert.equal(isRelevant(p), false, p);
  }
});

test('a watched git directory is filtered the same way', () => {
  assert.equal(isRelevant('HEAD', true), true);
  assert.equal(isRelevant('refs/heads/x', true), true);
  assert.equal(isRelevant('info/exclude', true), true);
  assert.equal(isRelevant('objects/aa/bb', true), false);
  assert.equal(isRelevant('index.lock', true), false);
});

test('an event without a file name refreshes to be safe', () => {
  assert.equal(isRelevant(null), true);
  assert.equal(isRelevant(''), true);
});

test('what git says it ignores replaces the guess from folder names', () => {
  const ignored = makeIgnoreMatcher({ dirs: ['build/', 'src/generated/', 'node_modules/'], files: ['app.log', 'electron/build-info.json'] });
  for (const p of ['build/x.o', 'build', 'src/generated/a.ts', 'src\\generated\\deep\\b.ts', 'node_modules/a/b.js', 'app.log', 'electron/build-info.json']) {
    assert.equal(isRelevant(p, false, ignored), false, `${p} is ignored by git`);
  }
  for (const p of ['src/real.ts', 'logs/app.log', 'build-tools/x.js', 'builds/x', 'src/generated.ts', 'README.md']) {
    assert.equal(isRelevant(p, false, ignored), true, `${p} is not ignored`);
  }
  // a tracked folder that happens to have a "generated" name still counts, and a nested repository's folder never does
  assert.equal(isRelevant('bin/deploy.sh', false, ignored), true, 'tracked, though a folder called bin is usually build output');
  assert.equal(isRelevant('dist/index.js', false, ignored), true);
  assert.equal(isRelevant('sub/.git/index', false, ignored), false);
  assert.equal(isRelevant('.git/index', false, ignored), true);
});

test('the ignore list copes with an empty answer and, on Windows, with capitals', () => {
  assert.equal(makeIgnoreMatcher({})('anything/at/all'), false);
  assert.equal(makeIgnoreMatcher()('x'), false);
  if (process.platform === 'win32') assert.equal(makeIgnoreMatcher({ dirs: ['build/'] })('Build\\X.o'.replace(/\\/g, '/')), true);
});

test('git lists what it ignores: whole folders, single files, and never a tracked file', async () => {
  const repo = repoWith({ '.gitignore': 'build/\n*.log\nnode_modules/\n', 'bin/deploy.sh': '#!/bin/sh\n', 'src/a.ts': '1\n' });
  fs.mkdirSync(path.join(repo, 'build', 'obj'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'build', 'obj', 'x.o'), '1');
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), '1');
  fs.writeFileSync(path.join(repo, 'app.log'), '1');
  fs.writeFileSync(path.join(repo, 'src', 'debug.log'), '1');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const r = await call('ignoredPaths', { repo });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([...r.data.dirs].sort(), ['build/', 'node_modules/']);
  assert.deepEqual([...r.data.files].sort(), ['app.log', 'src/debug.log']);
  const ignored = makeIgnoreMatcher(r.data);
  assert.equal(isRelevant('build/obj/x.o', false, ignored), false);
  assert.equal(isRelevant('src/debug.log', false, ignored), false);
  assert.equal(isRelevant('bin/deploy.sh', false, ignored), true, 'tracked');
  assert.equal(isRelevant('src/a.ts', false, ignored), true);
});

test('outside a repository there is no answer, so the watcher keeps to the folder names', async () => {
  const r = await call('ignoredPaths', { repo: tmp('gitgui-notarepo-') });
  assert.equal(r.ok, false);
});

test('an ordinary repository has no git directory outside its tree; a linked worktree has two', () => {
  const dir = tmp();
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(path.join(plain, '.git'), { recursive: true });
  assert.deepEqual(outsideGitDirs(plain), []);

  const common = path.join(dir, 'main', '.git');
  const own = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'commondir'), '../..\n');
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${own}\n`);
  assert.deepEqual(outsideGitDirs(wt), [own, common]);
});

/* ---------- the watcher itself ---------- */

test('a burst of writes is reported once, and noise not at all', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 150 });
  try {
    watcher.set([dir, 'relative/path']);
    assert.deepEqual(watcher.watching(), [dir]);
    await sleep(100); // let the watch start

    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');
    fs.writeFileSync(path.join(dir, '.git', 'objects', 'blob'), '1');
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '1');
    await sleep(500);
    assert.deepEqual(seen, [], 'noise only');

    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'file.txt'), String(i));
    fs.writeFileSync(path.join(dir, '.git', 'index'), '1');
    assert.ok(await waitFor(() => seen.length >= 1), 'reported');
    await sleep(500);
    assert.deepEqual(seen, [dir], 'once');

    watcher.set([]);
    assert.deepEqual(watcher.watching(), []);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'after');
    await sleep(500);
    assert.deepEqual(seen, [dir], 'nothing after the tab closed');
  } finally {
    watcher.close();
  }
});

test('asking again for a repository that is already watched does not watch it twice', async () => {
  const dir = tmp();
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 100 });
  try {
    for (let i = 0; i < 3; i++) watcher.set([dir]);
    // on Windows the same folder spelled with other capitals is still the same folder
    watcher.set(process.platform === 'win32' ? [dir, dir.toLowerCase()] : [dir]);
    assert.deepEqual(watcher.watching(), [dir]);
    await sleep(100);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    assert.ok(await waitFor(() => seen.length >= 1));
    await sleep(500);
    assert.equal(seen.length, 1, 'one change, one report');
  } finally {
    watcher.close();
  }
});

test('a steady stream of writes still gets a report now and then', async () => {
  const dir = tmp();
  const stamps = [];
  const t0 = Date.now();
  const watcher = createRepoWatcher(() => stamps.push(Date.now() - t0), { debounceMs: 200, maxWaitMs: 600 });
  try {
    watcher.set([dir]);
    await sleep(150);
    const end = Date.now() + 2400;
    while (Date.now() < end) {
      fs.writeFileSync(path.join(dir, 'stream.txt'), String(Date.now()));
      await sleep(40); // faster than the debounce, so only the cap can report
    }
    const during = stamps.filter((s) => s < end - t0);
    assert.ok(during.length >= 3, `reported ${during.length} times during the stream: ${during.join(', ')}`);
    for (let i = 1; i < during.length; i++) assert.ok(during[i] - during[i - 1] < 1100, `a gap of ${during[i] - during[i - 1]} ms`);
    assert.ok(await waitFor(() => stamps.some((s) => s > end - t0)), 'and once more after it stops');
  } finally {
    watcher.close();
  }
});

test('what git ignores is not reported, and what it does not ignore is, whatever the folder is called', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'build'));
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), {
    debounceMs: 100,
    loadIgnored: async () => ({ dirs: ['build/'], files: [] }), // build is ignored; bin is tracked here
  });
  try {
    watcher.set([dir]);
    await sleep(250); // git's answer arrives
    fs.writeFileSync(path.join(dir, 'build', 'out.o'), '1');
    await sleep(500);
    assert.deepEqual(seen, [], 'ignored build output');
    fs.writeFileSync(path.join(dir, 'bin', 'deploy.sh'), '1');
    assert.ok(await waitFor(() => seen.length === 1), 'a tracked file in a folder called bin');
  } finally {
    watcher.close();
  }
});

test('a folder that appears later is looked up again, and the writes that made it are judged by the new answer', async () => {
  const dir = tmp();
  let asked = 0;
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), {
    debounceMs: 100,
    loadIgnored: async () => {
      asked++;
      return { dirs: asked >= 2 ? ['gen/'] : [], files: [] }; // git learns about gen/ once it exists
    },
  });
  try {
    watcher.set([dir]);
    assert.ok(await waitFor(() => asked >= 1));
    fs.mkdirSync(path.join(dir, 'gen'));
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'gen', `first${i}.js`), String(i));
    assert.ok(await waitFor(() => asked >= 2), 'asked again for the new top-level folder');
    await sleep(600);
    assert.deepEqual(seen, [], 'the first writes into it are not a change either: they were judged when git had answered');
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'gen', `f${i}.js`), String(i));
    await sleep(500);
    assert.deepEqual(seen, [], 'and neither are the later ones');
    fs.writeFileSync(path.join(dir, 'real.txt'), '1');
    assert.ok(await waitFor(() => seen.length === 1), 'a real file still is');
  } finally {
    watcher.close();
  }
});

test('a burst is judged by git\'s latest answer, and a slow answer is waited for', async () => {
  const dir = tmp();
  const seen = [];
  let answer;
  const watcher = createRepoWatcher((root) => seen.push(root), {
    debounceMs: 100,
    maxWaitMs: 2000,
    loadIgnored: () => new Promise((resolve) => (answer = resolve)), // git answers when the test says so
  });
  try {
    watcher.set([dir]);
    await sleep(100);
    answer({ dirs: [], files: [] }); // the first answer: nothing ignored
    await sleep(100);
    // a new folder: git is asked again, and does not answer for a while
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'x.o'), '1');
    await sleep(400); // longer than the debounce
    assert.deepEqual(seen, [], 'waiting for git rather than reporting a write that may be ignored');
    answer({ dirs: ['build/'], files: [] });
    await sleep(400);
    assert.deepEqual(seen, [], 'git said build/ is ignored');
  } finally {
    watcher.close();
  }

  // and when git is too slow, the cap reports the change rather than waiting for ever
  const dir2 = tmp();
  const seen2 = [];
  const slow = createRepoWatcher((root) => seen2.push(root), { debounceMs: 100, maxWaitMs: 600, loadIgnored: () => new Promise(() => {}) });
  try {
    slow.set([dir2]);
    await sleep(100);
    fs.writeFileSync(path.join(dir2, 'a.txt'), '1');
    assert.ok(await waitFor(() => seen2.length === 1, 3000), 'reported once the cap ran out');
  } finally {
    slow.close();
  }
});

test('a changed .gitignore makes the watcher ask git again, and is itself a change', async () => {
  const dir = tmp();
  let asked = 0;
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), {
    debounceMs: 100,
    loadIgnored: async () => {
      asked++;
      return { dirs: [], files: [] };
    },
  });
  try {
    watcher.set([dir]);
    assert.ok(await waitFor(() => asked >= 1));
    const before = asked;
    fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\n');
    assert.ok(await waitFor(() => asked > before), 'asked again');
    assert.ok(await waitFor(() => seen.length >= 1), 'and the status may have changed');
  } finally {
    watcher.close();
  }
});

test('if git cannot answer, the watcher keeps to the folder names', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 100, loadIgnored: async () => null });
  try {
    watcher.set([dir]);
    await sleep(250);
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '1');
    await sleep(500);
    assert.deepEqual(seen, []);
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    assert.ok(await waitFor(() => seen.length === 1));
  } finally {
    watcher.close();
  }
});

/* ---------- a folder that goes away and comes back ---------- */

test('a deleted folder is reported, and watched again when it comes back', async () => {
  const base = tmp();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 80, healthMs: 100 });
  try {
    watcher.set([repo]);
    assert.deepEqual(watcher.watching(), [repo]);
    await sleep(150);

    fs.rmSync(repo, { recursive: true, force: true });
    assert.ok(await waitFor(() => seen.length >= 1), 'the page is told, so it can find the folder gone');
    assert.ok(await waitFor(() => watcher.watching().length === 0), 'no longer counted as watched');

    fs.mkdirSync(repo);
    assert.ok(await waitFor(() => watcher.watching().length === 1), 'watched again');
    const n = seen.length;
    assert.ok(await waitFor(() => seen.length > n), 'and the page is told it is back');
    await sleep(300);
    const m = seen.length;
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    assert.ok(await waitFor(() => seen.length > m), 'changes in it are reported again');
  } finally {
    watcher.close();
  }
});

test('a folder replaced by another of the same name between two checks is noticed too', async () => {
  const base = tmp();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 80, healthMs: 150 });
  try {
    watcher.set([repo]);
    await sleep(100);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo); // gone and back before anyone looked
    await sleep(500); // a check or two
    const n = seen.length;
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    assert.ok(await waitFor(() => seen.length > n), 'the new folder is being watched');
  } finally {
    watcher.close();
  }
});

test('a repository whose folder is missing at the start is picked up when the folder appears', async () => {
  const base = tmp();
  const repo = path.join(base, 'later');
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 80, healthMs: 100 });
  try {
    watcher.set([repo, path.join(base, 'not-a-dir.txt')]);
    assert.deepEqual(watcher.watching(), [], 'nothing to watch yet');
    fs.mkdirSync(repo); // the drive comes back
    assert.ok(await waitFor(() => watcher.watching().length === 1), 'watched as soon as it exists');
    assert.ok(await waitFor(() => seen.length >= 1), 'and the page is told');
    const n = seen.length;
    await sleep(200);
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    assert.ok(await waitFor(() => seen.length > n));
  } finally {
    watcher.close();
  }
});

test('closing the watcher stops everything, including the checks', async () => {
  const dir = tmp();
  const seen = [];
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 50, healthMs: 50 });
  watcher.set([dir]);
  await sleep(100);
  watcher.close();
  assert.deepEqual(watcher.watching(), []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  await sleep(400);
  assert.deepEqual(seen, [], 'silent once closed');
});

test('deleting a watched folder does not flood the watcher: it lets go at once (it would not for seconds otherwise)', async () => {
  // On Windows a watched folder that is deleted keeps reporting itself, by full path, some 190,000 times a second.
  const base = tmp();
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  const seen = [];
  // the health check is far away (the real default), so only the watcher's own reaction can stop the flood
  const watcher = createRepoWatcher((root) => seen.push(root), { debounceMs: 100, healthMs: 60_000 });
  try {
    watcher.set([repo]);
    assert.deepEqual(watcher.watching(), [repo]);
    await sleep(300);
    let maxLag = 0;
    let last = Date.now();
    const lag = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 25);
      last = now;
    }, 25);
    try {
      fs.rmSync(repo, { recursive: true, force: true });
      assert.ok(await waitFor(() => watcher.watching().length === 0, 2000), 'let go of the deleted folder straight away');
      await sleep(1500);
    } finally {
      clearInterval(lag);
    }
    assert.ok(seen.length >= 1 && seen.length <= 3, `the page was told ${seen.length} time(s), not once per flooded event`);
    assert.ok(maxLag < 500, `timers kept running (slowest was ${maxLag} ms late)`);
  } finally {
    watcher.close();
  }
});
