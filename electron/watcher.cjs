'use strict';
// Watches the open repositories on disk so the window can refresh when something outside the app (a terminal,
// an editor, another tool) changes them, even while the window is in the background. One recursive fs.watch per
// repository covers the working tree and its .git folder; events that cannot change what the app shows (object
// writes, lock files, anything git ignores) are dropped, and the rest are debounced into one "changed".
//
// What git ignores is asked of git itself (`loadIgnored`), not guessed from folder names: a tracked folder that
// happens to be called `bin` still counts, and a build folder with an unusual name does not. Until git has
// answered (a fraction of a second after a repository is opened) a short list of well-known generated folders
// stands in. A watcher that dies, because its folder was deleted or replaced, is noticed and started again.

const fs = require('node:fs');
const path = require('node:path');

const DEBOUNCE_MS = 400;
const MAX_WAIT_MS = 2000; // a steady stream of writes still refreshes now and then
const HEALTH_MS = 5000; // how often each folder is checked to still be the one that was opened
const IGNORE_REFRESH_MS = 60_000; // how stale git's list of ignored paths may get while changes keep coming
const PENDING_MAX = 500; // paths remembered per burst; a bigger burst simply counts as a change

// Folders that are generated rather than edited. Only used until git has said what it ignores (or when it cannot).
const NOISE_DIRS = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  '.vs',
  '.angular',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.cache',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.venv',
]);

// Inside .git, only these say something the app shows has changed: the staging area, the branch that is checked
// out, the branches, tags and stash, and the state of a merge, rebase, cherry-pick or revert in progress.
const GIT_FILES = new Set(['index', 'HEAD', 'packed-refs', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']);
const GIT_DIRS = new Set(['refs', 'rebase-merge', 'rebase-apply']);

const lower = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
const split = (rel) => String(rel).split(/[\\/]+/).filter(Boolean);

/**
 * Turns git's list of ignored paths into a test for one path. `dirs` are whole ignored folders (git does not list
 * what is inside them) and `files` single ignored files; `rel` is relative to the repository, with / as separator.
 */
function makeIgnoreMatcher({ dirs = [], files = [] } = {}) {
  const dirSet = new Set(dirs.map((d) => lower(String(d).replace(/\/+$/, ''))));
  const fileSet = new Set(files.map((f) => lower(String(f))));
  return (rel) => {
    const p = lower(rel);
    if (fileSet.has(p) || dirSet.has(p)) return true;
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) if (dirSet.has(p.slice(0, i))) return true;
    return false;
  };
}

/**
 * Is a change at `rel` (relative to the watched folder, either slash) worth a refresh? `inGitDir` when the watched
 * folder is the git directory itself (a linked worktree's or the common one). `ignored`, when git's list of ignored
 * paths is known, replaces the guess from folder names.
 */
function isRelevant(rel, inGitDir = false, ignored = null) {
  if (rel == null || rel === '') return true; // the platform did not say which file: refresh to be safe
  const parts = split(rel);
  if (!parts.length) return true;
  const name = parts[parts.length - 1];
  if (!inGitDir) {
    if (parts[0] !== '.git') {
      if (parts.includes('.git')) return false; // a nested repository's own folder
      return ignored ? !ignored(parts.join('/')) : !parts.some((p) => NOISE_DIRS.has(p));
    }
    parts.shift();
    // Windows also reports the folder itself whenever a file in it is added, even a lock file; the file's
    // own event says whether that matters
    if (!parts.length) return false;
  }
  if (parts.length === 2 && parts[0] === 'info' && parts[1] === 'exclude') return true; // changes what counts as untracked
  if (name.endsWith('.lock')) return false; // git writes x.lock and renames it to x: the rename is what counts
  if (parts.length === 1) return GIT_FILES.has(parts[0]) || GIT_DIRS.has(parts[0]);
  return GIT_DIRS.has(parts[0]);
}

/** The git directories of a working tree that live outside it: a linked worktree's own folder and the common
 *  folder its branches are stored in. Empty for an ordinary repository, whose .git is inside the tree. */
function outsideGitDirs(root) {
  const dot = path.join(root, '.git');
  let stat;
  try {
    stat = fs.statSync(dot);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dot, 'utf8'));
  if (!m) return [];
  const gitDir = path.resolve(root, m[1]);
  const dirs = [gitDir];
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (common) dirs.push(path.resolve(gitDir, common));
  } catch {
    /* a submodule's git directory has no commondir */
  }
  const inside = (d) => !path.relative(root, d).startsWith('..') && !path.isAbsolute(path.relative(root, d));
  return dirs.filter((d, i) => dirs.indexOf(d) === i && !inside(d) && fs.existsSync(d));
}

const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

/**
 * Keeps one watcher per repository and calls `onChange(root)` once per burst of relevant changes.
 * `set(roots)` starts and stops watchers to match the open tabs; `close()` stops them all.
 *
 * Options: `loadIgnored(root)` returns a promise of `{ dirs, files }` (what git ignores) or null;
 * `debounceMs`, `maxWaitMs`, `healthMs` and `ignoreRefreshMs` are the timings above, for tests.
 */
function createRepoWatcher(onChange, opts = {}) {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const healthMs = opts.healthMs ?? HEALTH_MS;
  const ignoreRefreshMs = opts.ignoreRefreshMs ?? IGNORE_REFRESH_MS;
  const loadIgnored = opts.loadIgnored;
  const repos = new Map(); // key -> entry
  const current = (entry) => repos.get(key(entry.root)) === entry;

  /** Asks git again what is ignored; asks that arrive while it is answering are folded into one more question. */
  const refreshIgnore = (entry) => {
    if (!loadIgnored) return;
    if (entry.loadingIgnore) {
      entry.ignoreAgain = true;
      return;
    }
    entry.loadingIgnore = true;
    Promise.resolve()
      .then(() => loadIgnored(entry.root))
      .then((list) => {
        if (current(entry) && list) entry.ignore = makeIgnoreMatcher(list); // a failed answer keeps the last good one
      })
      .catch(() => {})
      .finally(() => {
        entry.ignoreAt = Date.now();
        entry.loadingIgnore = false;
        if (entry.ignoreAgain && current(entry)) {
          entry.ignoreAgain = false;
          refreshIgnore(entry);
        }
      });
  };

  const fire = (entry) => {
    clearTimeout(entry.timer);
    entry.timer = null;
    if (!current(entry)) return;
    // git is still answering what it ignores (a new folder just appeared): wait for it, within the cap, so the
    // writes are judged by the fresh answer and the first writes into a new build folder do not count
    if (entry.loadingIgnore && entry.first && Date.now() - entry.first < maxWaitMs) {
      entry.timer = setTimeout(() => fire(entry), 40);
      return;
    }
    // the burst is judged now, not as each event came in: an event is only a change if it still is by the latest answer
    const changed = entry.sure || [...entry.pending].some((k) => isRelevant(k.slice(2), k[0] === 'g', entry.ignore));
    entry.first = 0;
    entry.pending.clear();
    entry.sure = false;
    if (!changed) return;
    onChange(entry.root);
    if (Date.now() - entry.ignoreAt > ignoreRefreshMs) refreshIgnore(entry); // new ignored folders appear over time
  };
  /** `sure`: a change that needs no judging (the folder came back, was lost, or an event had no file name). */
  const schedule = (entry, sure = false) => {
    const now = Date.now();
    if (sure) entry.sure = true;
    if (!entry.first) entry.first = now;
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(debounceMs, entry.first + maxWaitMs - now));
    entry.timer = setTimeout(() => fire(entry), wait);
  };

  const closeWatchers = (entry) => {
    for (const w of entry.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    entry.watchers = [];
  };
  const stop = (entry) => {
    clearTimeout(entry.timer);
    clearInterval(entry.health);
    closeWatchers(entry);
  };

  const onEvent = (entry, file, inGitDir) => {
    const rel = file == null ? null : String(file);
    if (rel && !inGitDir) {
      const parts = split(rel);
      // a folder that was not there when the repository opened (a first build creating bin/): git may ignore it,
      // so ask again, rather than treating everything a build writes there as a change
      if (parts.length && parts[0] !== '.git' && !entry.seen.has(lower(parts[0]))) {
        entry.seen.add(lower(parts[0]));
        refreshIgnore(entry);
      }
      // the rules themselves changed
      if (parts[parts.length - 1] === '.gitignore' || (parts[0] === '.git' && parts[1] === 'info' && parts[2] === 'exclude')) {
        refreshIgnore(entry);
      }
    }
    if (!isRelevant(rel, inGitDir, entry.ignore)) return;
    // remember what changed so the burst can be judged again when it fires, by git's latest answer
    if (rel == null || rel === '' || entry.pending.size >= PENDING_MAX) entry.sure = true;
    else entry.pending.add((inGitDir ? 'g:' : 'w:') + rel);
    schedule(entry);
  };

  /** Opens the watchers of an entry and records which folder they are on, so a replaced folder can be told apart. */
  const begin = (entry) => {
    let st = null;
    try {
      st = fs.statSync(entry.root);
    } catch {
      /* gone already: the health check will keep trying */
    }
    entry.ino = st ? st.ino : null;
    entry.birth = st ? st.birthtimeMs : null;
    entry.seen = new Set();
    try {
      for (const n of fs.readdirSync(entry.root)) entry.seen.add(lower(n));
    } catch {
      /* nothing known yet */
    }
    // let go of one watcher whose folder is gone or unreadable; the health check starts a new one when it can
    const drop = (w) => {
      try {
        w.close();
      } catch {
        /* already closed */
      }
      entry.watchers = entry.watchers.filter((x) => x !== w);
      entry.healthy = false;
      schedule(entry, true); // the page re-reads and finds out what happened
    };
    const watch = (dir, inGitDir) => {
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (_type, file) => {
          // When the watched folder itself is deleted, Windows goes on reporting it, by its full path, some 190,000
          // times a second and never stops. A change inside the folder always has a relative path, so an absolute one
          // means the folder is gone: let go of it at once rather than choke on the flood until the next health check.
          if (file != null && path.isAbsolute(String(file))) return drop(w);
          onEvent(entry, file, inGitDir);
        });
        w.on('error', () => drop(w));
        entry.watchers.push(w);
      } catch {
        /* a folder that cannot be watched is tried again at the next health check, and refreshes on focus meanwhile */
      }
    };
    watch(entry.root, false);
    for (const dir of outsideGitDirs(entry.root)) watch(dir, true);
    entry.expected = entry.watchers.length;
    refreshIgnore(entry);
  };

  /**
   * A watcher on a folder that was deleted, replaced by another folder of the same name, or whose handle failed
   * says nothing any more, and does not say so either. Look from time to time, and start again when needed.
   */
  const check = (entry) => {
    if (!current(entry)) return;
    let st = null;
    try {
      st = fs.statSync(entry.root);
    } catch {
      /* gone */
    }
    if (!st || !st.isDirectory()) {
      if (entry.healthy) {
        closeWatchers(entry);
        entry.healthy = false;
        schedule(entry, true); // the page re-reads and finds the folder gone
      }
      return;
    }
    if (entry.healthy && entry.watchers.length === entry.expected && entry.expected > 0 && st.ino === entry.ino && st.birthtimeMs === entry.birth) return;
    closeWatchers(entry);
    begin(entry);
    if (entry.watchers.length > 0) {
      entry.healthy = true;
      schedule(entry, true); // it is back, or something may have changed while nobody was watching
    }
  };

  const start = (root) => {
    const entry = {
      root,
      watchers: [],
      expected: 0,
      timer: null,
      first: 0,
      pending: new Set(), // what changed in the current burst, to be judged when it fires
      sure: false, // the burst holds a change that needs no judging
      ino: null,
      birth: null,
      seen: new Set(),
      ignore: null,
      ignoreAt: 0,
      loadingIgnore: false,
      ignoreAgain: false,
      healthy: false,
      health: null,
    };
    begin(entry);
    entry.healthy = entry.watchers.length > 0;
    entry.health = setInterval(() => check(entry), healthMs);
    if (entry.health.unref) entry.health.unref();
    return entry;
  };

  return {
    set(roots) {
      const wanted = new Map();
      for (const r of Array.isArray(roots) ? roots : []) {
        if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
        try {
          if (!fs.statSync(r).isDirectory()) continue; // a file is not a repository
        } catch {
          /* not there (an unplugged drive): kept, and watched as soon as it appears */
        }
        wanted.set(key(r), r);
      }
      for (const [k, entry] of repos) {
        if (!wanted.has(k)) {
          stop(entry);
          repos.delete(k);
        }
      }
      for (const [k, root] of wanted) if (!repos.has(k)) repos.set(k, start(root));
    },
    /** the repositories that are being watched right now (not the ones waiting for their folder to appear) */
    watching() {
      return [...repos.values()].filter((e) => e.healthy).map((e) => e.root);
    },
    close() {
      for (const entry of repos.values()) stop(entry);
      repos.clear();
    },
  };
}

module.exports = { createRepoWatcher, isRelevant, outsideGitDirs, makeIgnoreMatcher };
