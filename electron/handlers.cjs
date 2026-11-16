'use strict';
// Git backend. Shared by the Electron main process (via IPC) and the Vite dev
// server (via /rpc) so the UI can also be run and tested in a plain browser.
// Every git call uses an argument array (never a shell), and user supplied
// refs / paths are validated before they reach git.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never hang waiting for a console prompt
  GIT_OPTIONAL_LOCKS: '0', // read-only commands must not fight over index.lock
  GIT_EDITOR: 'true', // never open an editor from a background process
};
delete ENV.ELECTRON_RUN_AS_NODE;

const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];
// File paths are always treated literally (no ":(glob)" style magic from odd file names).
// Commands that take no paths opt out with { literal: false}: `git stash push -u` silently
// leaves untracked files on disk when this flag is set.
const LITERAL_ARGS = ['--literal-pathspecs'];

function run(repo, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const global = opts.literal === false ? BASE_ARGS : [...LITERAL_ARGS, ...BASE_ARGS];
    const child = spawn('git', [...global, ...args], { cwd: repo, env: ENV, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'git was not found on PATH' : e.message)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if ((opts.okCodes || [0]).includes(code)) resolve(stdout);
      else reject(new Error(classifyError((stderr || stdout || `git exited with code ${code}`).trim())));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input == null ? undefined : opts.input);
  });
}

// Failures that mean "you are not signed in, or signed in as the wrong GitHub account". The UI
// recognises the AUTH: prefix and offers to sign in instead of showing a raw git error.
const AUTH_RE =
  /Cannot prompt because user interactivity has been disabled|could not read (Username|Password) for|terminal prompts disabled|Authentication failed|Invalid username or (token|password)|Permission to .+ denied to|The requested URL returned error: 40[13]/i;
function classifyError(message) {
  return AUTH_RE.test(message) ? `AUTH: ${message}` : message;
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) throw new Error('Invalid repository path');
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new Error('Repository folder not found');
  return repo;
}

function safeRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) {
    throw new Error('Invalid reference');
  }
  return ref;
}

function safeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('No files given');
  for (const f of files) {
    if (typeof f !== 'string' || !f || f.includes('\0')) throw new Error('Invalid file path');
  }
  return files;
}

const STASH_RE = /^stash@\{\d+\}$/;
const HASH_RE = /^[0-9a-f]{40,64}$/;

// ---- undo / redo -------------------------------------------------------
// An undoable action is described by two snapshots of every local branch,
// every tag and HEAD. Undo/redo moves the repository from one snapshot to the
// other, but only if the repository is still exactly in the expected state.

function canon(s) {
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ head: s.head, branches: sorted(s.branches), tags: sorted(s.tags) });
}

function validateState(s) {
  if (!s || typeof s !== 'object' || !s.head || typeof s.head !== 'object') throw new Error('Invalid repository state');
  const hash = (h) => {
    if (!HASH_RE.test(h)) throw new Error('Invalid commit id in repository state');
    return h;
  };
  const refMap = (m) => {
    if (!m || typeof m !== 'object') throw new Error('Invalid repository state');
    const out = {};
    for (const [name, h] of Object.entries(m)) out[safeRef(name)] = hash(h);
    return out;
  };
  return {
    head: { branch: s.head.branch ? safeRef(s.head.branch) : null, hash: s.head.hash ? hash(s.head.hash) : null },
    branches: refMap(s.branches),
    tags: refMap(s.tags),
  };
}

async function hasHead(repo) {
  const out = await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] });
  return out.trim().length > 0;
}

// ---- GitHub accounts ----------------------------------------------------
// A profile is { username, name, email }. No passwords or tokens are ever stored here:
// Git Credential Manager (GCM) holds the sign-ins. Switching an account sets the repository's
// commit identity and tells GCM which GitHub account to use for this repository.

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const GITHUB_ACCOUNT_KEY = 'credential.https://github.com.username';

function accountsFile() {
  return path.join(process.env.GITGUI_HOME || path.join(os.homedir(), '.gitgui'), 'accounts.json');
}

function cleanProfile(p) {
  if (!p || typeof p !== 'object') throw new Error('Invalid account');
  const username = typeof p.username === 'string' ? p.username.trim() : '';
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  const email = typeof p.email === 'string' ? p.email.trim() : '';
  if (!USERNAME_RE.test(username)) throw new Error('GitHub usernames are letters, numbers and hyphens, and cannot start with a hyphen');
  if (!name || name.length > 100 || /[\r\n\0<>]/.test(name) || name.startsWith('-')) throw new Error('Enter the name to use on commits');
  if (!EMAIL_RE.test(email) || email.length > 200 || email.startsWith('-')) throw new Error('Enter a valid email address for commits');
  return { username, name, email };
}

function readProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
    const out = [];
    for (const p of Array.isArray(raw) ? raw : []) {
      try {
        out.push(cleanProfile(p));
      } catch {
        /* skip a hand-edited entry that is no longer valid */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeProfiles(list) {
  const file = accountsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

const sameUser = (a, b) => a.toLowerCase() === b.toLowerCase();

// Runs `git credential-manager github ...`. Never rejects: callers inspect the exit code.
function gcm(args, { interactive = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...ENV };
    if (interactive) delete env.GIT_TERMINAL_PROMPT; // a browser sign-in is not a terminal prompt
    const child = spawn('git', ['credential-manager', ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function gcmStatus() {
  const v = await gcm(['--version'], { timeoutMs: 10000 });
  if (v.code !== 0) return { available: false, version: null, accounts: [] };
  const l = await gcm(['github', 'list']);
  const accounts = l.code === 0 ? l.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => USERNAME_RE.test(s)) : [];
  return { available: true, version: v.stdout.split('+')[0], accounts };
}

const handlers = {
  async openRepo({ path: p }) {
    assertRepo(p);
    const root = (await run(p, ['rev-parse', '--show-toplevel'])).trim();
    return { root: path.normalize(root), name: path.basename(root) };
  },

  async refs({ repo }) {
    assertRepo(repo);
    const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)'].join('%1f');
    const [refOut, remoteOut, stashOut, headOut, curOut] = await Promise.all([
      run(repo, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      run(repo, ['remote']),
      run(repo, ['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%at%x1f%P']).catch(() => ''),
      run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] }),
      run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] }),
    ]);
    const branches = [];
    const remoteBranches = [];
    const tags = [];
    for (const line of refOut.split('\n')) {
      if (!line) continue;
      const [ref, obj, deref, head, upstream, track] = line.split('\x1f');
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice(11), hash: obj, current: head === '*', upstream: upstream || null, track: track || '' });
      } else if (ref.startsWith('refs/remotes/')) {
        const name = ref.slice(13);
        if (name.endsWith('/HEAD')) continue;
        remoteBranches.push({ name, hash: obj, remote: name.split('/')[0] });
      } else if (ref.startsWith('refs/tags/')) {
        tags.push({ name: ref.slice(10), hash: deref || obj });
      }
    }
    const stashes = stashOut
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, hash, message, at, parents] = l.split('\x1f');
        // a stash commit's first parent is the commit the stash was made on
        return { ref, hash, message, date: Number(at), parent: (parents || '').split(' ')[0] || null };
      });
    return {
      head: headOut.trim() || null,
      current: curOut.trim() || null,
      remotes: remoteOut.split('\n').filter(Boolean),
      branches,
      remoteBranches,
      tags,
      stashes,
    };
  },

  async log({ repo, limit = 1000 }) {
    assertRepo(repo);
    const n = Math.max(1, Math.min(Number(limit) || 1000, 100000));
    const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';
    let out;
    try {
      out = await run(repo, ['log', '--date-order', '--branches', '--remotes', '--tags', 'HEAD', `--max-count=${n}`, `--format=${fmt}`]);
    } catch (e) {
      if (/does not have any commits|unknown revision|bad default revision|ambiguous argument/.test(e.message)) return [];
      throw e;
    }
    return out
      .split('\x1e')
      .map((r) => r.replace(/^\n+/, ''))
      .filter(Boolean)
      .map((r) => {
        const [hash, parents, author, email, at, refsRaw, subject] = r.split('\x1f');
        return { hash, parents: parents ? parents.split(' ') : [], author, email, date: Number(at), refsRaw, subject };
      });
  },

  async status({ repo }) {
    assertRepo(repo);
    const out = await run(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    const parts = out.split('\0');
    const info = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0 };
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (!e) continue;
      if (e.startsWith('# ')) {
        const [, key, ...rest] = e.split(' ');
        if (key === 'branch.head') info.branch = rest[0] === '(detached)' ? null : rest[0];
        else if (key === 'branch.oid') info.oid = rest[0] === '(initial)' ? null : rest[0];
        else if (key === 'branch.upstream') info.upstream = rest[0];
        else if (key === 'branch.ab') {
          info.ahead = Number(rest[0].slice(1));
          info.behind = Number(rest[1].slice(1));
        }
        continue;
      }
      let m;
      if (e[0] === '1' && (m = e.match(/^1 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]*)$/))) {
        files.push({ path: m[3], index: m[1], worktree: m[2] });
      } else if (e[0] === '2' && (m = e.match(/^2 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]*)$/))) {
        files.push({ path: m[3], index: m[1], worktree: m[2], orig: parts[++i] });
      } else if (e[0] === 'u' && (m = e.match(/^u (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ ([\s\S]*)$/))) {
        files.push({ path: m[3], index: m[1], worktree: m[2], conflicted: true });
      } else if (e[0] === '?') {
        files.push({ path: e.slice(2), index: '.', worktree: '?', untracked: true });
      }
    }
    return { ...info, files };
  },

  async commitDetail({ repo, hash }) {
    assertRepo(repo);
    const out = await run(repo, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B', safeRef(hash)]);
    const [h, parents, author, email, date, ...msg] = out.split('\x1f');
    return { hash: h, parents: parents ? parents.split(' ') : [], author, email, date, message: msg.join('\x1f').trim() };
  },

  async commitFiles({ repo, hash }) {
    assertRepo(repo);
    const out = await run(repo, ['show', '--no-color', '--format=', '-m', '--first-parent', '--name-status', '-z', safeRef(hash)]);
    const tokens = out.replace(/^\n+/, '').split('\0');
    const files = [];
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i];
      if (!status) continue;
      if (status[0] === 'R' || status[0] === 'C') {
        files.push({ status: status[0], orig: tokens[i + 1], path: tokens[i + 2] });
        i += 2;
      } else {
        files.push({ status: status[0], path: tokens[i + 1] });
        i += 1;
      }
    }
    return files;
  },

  async diff({ repo, file, staged, untracked, hash }) {
    assertRepo(repo);
    safeFiles([file]);
    let out;
    if (untracked) {
      const abs = path.resolve(repo, file);
      if (!abs.startsWith(path.resolve(repo) + path.sep)) throw new Error('Path is outside the repository');
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return 'Not a regular file';
      if (stat.size > 1024 * 1024) return 'File is too large to preview';
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) return 'Binary file';
      const lines = buf.toString('utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n`;
    }
    if (hash) {
      out = await run(repo, ['show', '--no-color', '--no-ext-diff', '--format=', '-m', '--first-parent', '-U3', safeRef(hash), '--', file]);
    } else {
      out = await run(repo, ['diff', '--no-color', '--no-ext-diff', '-U3', ...(staged ? ['--cached'] : []), '--', file]);
    }
    if (out.length > 2 * 1024 * 1024) return 'Diff is too large to display';
    return out;
  },

  async stage({ repo, files }) {
    assertRepo(repo);
    await run(repo, ['add', '--', ...safeFiles(files)]);
  },
  async unstage({ repo, files }) {
    assertRepo(repo);
    if (await hasHead(repo)) await run(repo, ['restore', '--staged', '--', ...safeFiles(files)]);
    else await run(repo, ['rm', '--cached', '-r', '-q', '--', ...safeFiles(files)]);
  },
  async stageAll({ repo }) {
    assertRepo(repo);
    await run(repo, ['add', '-A']);
  },
  async unstageAll({ repo }) {
    assertRepo(repo);
    if (await hasHead(repo)) await run(repo, ['reset', '-q']);
    else await run(repo, ['rm', '--cached', '-r', '-q', '--', '.']);
  },
  async discard({ repo, files, untracked }) {
    assertRepo(repo);
    if (untracked) await run(repo, ['clean', '-f', '--', ...safeFiles(files)]);
    else await run(repo, ['restore', '--', ...safeFiles(files)]);
  },
  async applyPatch({ repo, patch, reverse }) {
    assertRepo(repo);
    if (typeof patch !== 'string' || !patch) throw new Error('Empty patch');
    const args = ['apply', '--cached', '--recount', '--whitespace=nowarn'];
    if (reverse) args.push('--reverse');
    args.push('-');
    await run(repo, args, { input: patch.endsWith('\n') ? patch : patch + '\n' });
  },

  async commit({ repo, message, amend }) {
    assertRepo(repo);
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg && !amend) throw new Error('Commit message is empty');
    if (amend && !msg) await run(repo, ['commit', '--amend', '--no-edit']);
    else await run(repo, ['commit', ...(amend ? ['--amend'] : []), '-F', '-'], { input: msg + '\n' });
  },

  async fetch({ repo }) {
    assertRepo(repo);
    await run(repo, ['fetch', '--all', '--prune']);
  },
  async pull({ repo }) {
    assertRepo(repo);
    await run(repo, ['pull', '--no-edit']);
  },
  async push({ repo }) {
    assertRepo(repo);
    const upstream = (await run(repo, ['rev-parse', '--abbrev-ref', '@{u}'], { okCodes: [0, 128] }).catch(() => '')).trim();
    if (upstream) return void (await run(repo, ['push']));
    const branch = (await run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })).trim();
    if (!branch) throw new Error('Cannot push a detached HEAD');
    const remotes = (await run(repo, ['remote'])).split('\n').filter(Boolean);
    if (remotes.length === 0) throw new Error('This repository has no remote to push to');
    await run(repo, ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], branch]);
  },

  async checkout({ repo, ref, kind }) {
    assertRepo(repo);
    safeRef(ref);
    if (kind === 'remote') {
      const local = ref.slice(ref.indexOf('/') + 1);
      const existing = await run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { okCodes: [0, 1] });
      if (existing.trim()) await run(repo, ['checkout', local]);
      else await run(repo, ['checkout', '-b', local, '--track', ref]);
    } else if (kind === 'commit') {
      await run(repo, ['checkout', '--detach', ref]);
    } else {
      await run(repo, ['checkout', ref]);
    }
  },
  async createBranch({ repo, name, from, checkout = true }) {
    assertRepo(repo);
    safeRef(name);
    await run(repo, ['check-ref-format', '--branch', name]);
    const args = checkout ? ['checkout', '-b', name] : ['branch', name];
    if (from) args.push(safeRef(from));
    await run(repo, args);
  },
  async deleteBranch({ repo, name, force }) {
    assertRepo(repo);
    await run(repo, ['branch', force ? '-D' : '-d', safeRef(name)]);
  },
  async createTag({ repo, name, hash }) {
    assertRepo(repo);
    safeRef(name);
    await run(repo, ['check-ref-format', `refs/tags/${name}`]);
    await run(repo, ['tag', name, safeRef(hash)]);
  },
  async merge({ repo, ref }) {
    assertRepo(repo);
    const out = await run(repo, ['merge', '--no-edit', safeRef(ref)]);
    // tell the UI what happened: a fast-forward creates no merge commit, so it is easy to miss
    return { fastForward: /Fast-forward/.test(out), upToDate: /Already up to date/.test(out) };
  },
  async cherryPick({ repo, hash }) {
    assertRepo(repo);
    await run(repo, ['cherry-pick', safeRef(hash)]);
  },
  async revert({ repo, hash }) {
    assertRepo(repo);
    await run(repo, ['revert', '--no-edit', safeRef(hash)]);
  },
  async reset({ repo, hash, mode }) {
    assertRepo(repo);
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Invalid reset mode');
    await run(repo, ['reset', `--${mode}`, safeRef(hash)]);
  },

  async accountsList() {
    const cfg = (key) => run(os.homedir(), ['config', '--global', '--get', key], { okCodes: [0, 1], literal: false }).catch(() => '');
    const [gcmInfo, name, email] = await Promise.all([gcmStatus(), cfg('user.name'), cfg('user.email')]);
    // the existing global identity is offered as a starting point when adding the first account
    return { profiles: readProfiles(), gcm: gcmInfo, suggestion: { name: name.trim(), email: email.trim() } };
  },

  async accountSave({ profile }) {
    const p = cleanProfile(profile);
    const list = readProfiles();
    const i = list.findIndex((x) => sameUser(x.username, p.username));
    if (i >= 0) list[i] = p;
    else list.push(p);
    writeProfiles(list);
    return list;
  },

  async accountRemove({ username }) {
    if (typeof username !== 'string') throw new Error('Invalid account');
    const list = readProfiles().filter((x) => !sameUser(x.username, username));
    writeProfiles(list);
    return list;
  },

  // Which account this repository uses, and whether switching can affect its remotes.
  async accountActive({ repo }) {
    assertRepo(repo);
    const get = async (flag, key) => (await run(repo, ['config', flag, '--get', key], { okCodes: [0, 1], literal: false })).trim();
    const local = await get('--local', GITHUB_ACCOUNT_KEY);
    const global = local ? '' : await get('--global', GITHUB_ACCOUNT_KEY);
    const [name, email, remotes] = await Promise.all([
      run(repo, ['config', '--get', 'user.name'], { okCodes: [0, 1], literal: false }),
      run(repo, ['config', '--get', 'user.email'], { okCodes: [0, 1], literal: false }),
      run(repo, ['remote', '-v']).catch(() => ''),
    ]);
    const urls = [...new Set(remotes.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean))];
    return {
      username: local || global || null,
      scope: local ? 'local' : global ? 'global' : null,
      name: name.trim(),
      email: email.trim(),
      remotes: {
        count: urls.length,
        githubHttps: urls.some((u) => /^https:\/\/([^@/]+@)?github\.com\//i.test(u)),
        githubSsh: urls.some((u) => /^(git@github\.com:|ssh:\/\/git@github\.com)/i.test(u)),
      },
    };
  },

  async accountSwitch({ repo, username, scope = 'local' }) {
    if (scope !== 'local' && scope !== 'global') throw new Error('Invalid scope');
    if (typeof username !== 'string') throw new Error('Invalid account');
    const profile = readProfiles().find((x) => sameUser(x.username, username));
    if (!profile) throw new Error(`"${username}" is not a saved account`);
    let dir = os.homedir();
    if (scope === 'local') dir = assertRepo(repo);
    const set = (key, value) => run(dir, ['config', `--${scope}`, key, value], { literal: false });
    await set('user.name', profile.name);
    await set('user.email', profile.email);
    await set(GITHUB_ACCOUNT_KEY, profile.username);
    return profile;
  },

  // Opens Git Credential Manager's browser sign-in. Can take minutes, so it waits up to 5.
  async accountSignIn({ username, force }) {
    const args = ['github', 'login', '--browser'];
    if (username) {
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new Error('Invalid GitHub username');
      args.push('--username', username);
    }
    if (force) args.push('--force');
    const status = await gcmStatus();
    if (!status.available) throw new Error('Git Credential Manager is not installed, so the app cannot sign in for you. Sign in from a terminal with git.');
    const r = await gcm(args, { interactive: true, timeoutMs: 300000 });
    if (r.code !== 0) throw new Error(r.stderr || 'Sign-in was cancelled or did not finish');
    return gcmStatus();
  },

  async accountSignOut({ username }) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new Error('Invalid GitHub username');
    const r = await gcm(['github', 'logout', username]);
    if (r.code !== 0) throw new Error(r.stderr || 'Could not sign out');
    return gcmStatus();
  },

  async snapshot({ repo }) {
    assertRepo(repo);
    const [headOut, curOut, refOut] = await Promise.all([
      run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] }),
      run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] }),
      run(repo, ['for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/heads', 'refs/tags']),
    ]);
    const branches = {};
    const tags = {};
    for (const line of refOut.split('\n')) {
      if (!line) continue;
      const [ref, hash] = line.split('\x1f');
      if (ref.startsWith('refs/heads/')) branches[ref.slice(11)] = hash;
      else if (ref.startsWith('refs/tags/')) tags[ref.slice(10)] = hash;
    }
    return { head: { branch: curOut.trim() || null, hash: headOut.trim() || null }, branches, tags };
  },

  // Moves the repo from snapshot `from` to snapshot `to`. mode 'soft' keeps the
  // undone changes staged (used for commits); 'keep' refuses to overwrite local edits.
  async restoreState({ repo, from, to, mode }) {
    assertRepo(repo);
    const f = validateState(from);
    const t = validateState(to);
    if (mode !== 'soft' && mode !== 'keep') throw new Error('Invalid mode');
    if (!t.head.hash) throw new Error('Cannot restore to a repository with no commits');

    const current = await handlers.snapshot({ repo });
    if (canon(current) !== canon(f)) {
      throw new Error('STALE: The repository changed since this action, so it can no longer be undone or redone safely.');
    }

    // 1. move HEAD first: it is the step most likely to be refused (e.g. local edits in the way)
    if (f.head.branch === t.head.branch) {
      if (f.head.hash !== t.head.hash) {
        if (t.head.branch) await run(repo, ['reset', mode === 'soft' ? '--soft' : '--keep', t.head.hash]);
        else await run(repo, ['checkout', '--detach', t.head.hash]);
      }
    } else if (t.head.branch) {
      if (f.branches[t.head.branch] !== t.head.hash) await run(repo, ['update-ref', `refs/heads/${t.head.branch}`, t.head.hash]);
      await run(repo, ['checkout', t.head.branch]);
    } else {
      await run(repo, ['checkout', '--detach', t.head.hash]);
    }

    // 2. recreate or move the other refs, then remove the ones that did not exist
    for (const [prefix, fromMap, toMap] of [['refs/heads/', f.branches, t.branches], ['refs/tags/', f.tags, t.tags]]) {
      for (const [name, hash] of Object.entries(toMap)) {
        if (prefix === 'refs/heads/' && name === t.head.branch) continue;
        if (fromMap[name] !== hash) await run(repo, ['update-ref', prefix + name, hash]);
      }
      for (const name of Object.keys(fromMap)) {
        if (!(name in toMap)) await run(repo, ['update-ref', '-d', prefix + name]);
      }
    }

    const after = await handlers.snapshot({ repo });
    if (canon(after) !== canon(t)) throw new Error('The repository was only partly restored. Check the branch list.');
  },

  async stashPush({ repo, message }) {
    assertRepo(repo);
    const args = ['stash', 'push', '--include-untracked'];
    if (typeof message === 'string' && message.trim()) args.push('-m', message.trim());
    await run(repo, args, { literal: false });
  },
  async stashPop({ repo, ref }) {
    assertRepo(repo);
    if (!STASH_RE.test(ref || '')) throw new Error('Invalid stash');
    await run(repo, ['stash', 'pop', ref]);
  },
  async stashApply({ repo, ref }) {
    assertRepo(repo);
    if (!STASH_RE.test(ref || '')) throw new Error('Invalid stash');
    await run(repo, ['stash', 'apply', ref]);
  },
  async stashDrop({ repo, ref }) {
    assertRepo(repo);
    if (!STASH_RE.test(ref || '')) throw new Error('Invalid stash');
    await run(repo, ['stash', 'drop', ref]);
  },
};

async function call(method, args) {
  const fn = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
  if (!fn) return { ok: false, error: `Unknown method: ${method}` };
  try {
    const data = await fn(args && typeof args === 'object' ? args : {});
    return { ok: true, data: data === undefined ? null : data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { call };
