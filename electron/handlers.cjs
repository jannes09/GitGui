'use strict';
// Git backend. Shared by the Electron main process (via IPC) and the Vite dev
// server (via /rpc) so the UI can also be run and tested in a plain browser.
// Every git call uses an argument array (never a shell), and user supplied
// refs / paths are validated before they reach git.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRemoteUrl, parseCredentialOutput, listPullRequests } = require('./pullrequests.cjs');
const updates = require('./updates.cjs');

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
    const child = spawn('git', [...global, ...args], { cwd: repo, env: opts.env ? { ...ENV, ...opts.env } : ENV, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'git was not found on PATH' : e.message)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if ((opts.okCodes || [0]).includes(code)) resolve(opts.binary ? Buffer.concat(out) : stdout);
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

// ---- conflicts and unfinished operations -----------------------------------
// A merge, cherry-pick, revert or rebase that hits conflicts stops half way. Git records that in
// files inside the git directory; the UI shows a banner and lets the user resolve, continue or abort.

async function operationState(repo) {
  const dir = path.normalize((await run(repo, ['rev-parse', '--absolute-git-dir'])).trim());
  const has = (name) => fs.existsSync(path.join(dir, name));
  const first = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8').split('\n')[0].trim();
    } catch {
      return '';
    }
  };
  const rebaseDir = has('rebase-merge') ? 'rebase-merge' : has('rebase-apply') ? 'rebase-apply' : null;
  if (rebaseDir) {
    const merge = rebaseDir === 'rebase-merge';
    const now = first(`${rebaseDir}/${merge ? 'msgnum' : 'next'}`);
    const end = first(`${rebaseDir}/${merge ? 'end' : 'last'}`);
    return { kind: 'rebase', detail: now && end ? `commit ${now} of ${end}` : '' };
  }
  if (has('MERGE_HEAD')) return { kind: 'merge', detail: first('MERGE_MSG') };
  if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', detail: first('CHERRY_PICK_HEAD').slice(0, 7) };
  if (has('REVERT_HEAD')) return { kind: 'revert', detail: first('REVERT_HEAD').slice(0, 7) };
  return null;
}

// Stages of a conflicted file: 1 = common ancestor, 2 = ours (HEAD), 3 = theirs (incoming).
async function unmergedEntries(repo, files) {
  const out = await run(repo, ['ls-files', '-u', '-z', ...(files ? ['--', ...files] : [])]);
  const entries = new Map();
  for (const rec of out.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    if (!entries.has(m[3])) entries.set(m[3], {});
    entries.get(m[3])[m[2]] = m[1];
  }
  return entries;
}

// Files that were conflicted and have since been resolved, so a resolution can be reopened.
async function resolvedPaths(repo) {
  const out = await run(repo, ['ls-files', '--resolve-undo', '-z']).catch(() => '');
  const set = new Set();
  for (const rec of out.split('\0')) {
    const i = rec.indexOf('\t');
    if (i > 0) set.add(rec.slice(i + 1));
  }
  return [...set];
}

function insideRepo(repo, file) {
  safeFiles([file]);
  const root = path.resolve(repo);
  const abs = path.resolve(root, file);
  if (!abs.startsWith(root + path.sep)) throw new Error('Path is outside the repository');
  return abs;
}

async function requireConflict(repo, file) {
  const stages = (await unmergedEntries(repo, [file])).get(file);
  if (!stages) throw new Error('This file is not in conflict (any more). Refresh the view.');
  return stages;
}

// A failed merge-like command is not an error when it simply stopped on conflicts.
async function conflictsOrThrow(repo, error, extra = {}) {
  const [op, files] = await Promise.all([operationState(repo).catch(() => null), unmergedEntries(repo).catch(() => new Map())]);
  if (files.size > 0 && (op || /CONFLICT/i.test(error.message))) return { conflicts: true, files: files.size, ...extra };
  throw error;
}

// Asks Git Credential Manager (or whatever credential helper git is set up with) for the login it
// already holds for a host, without ever prompting. Returns null when there is none.
const tokenCache = new Map();
const TOKEN_TTL_MS = 2 * 60 * 1000;
async function credentialToken(repo, info) {
  const key = `${repo}|${info.credentialHost}|${info.credentialPath || ''}`;
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.value;
  let value = null;
  try {
    const lines = ['protocol=https', `host=${info.credentialHost}`];
    if (info.credentialPath) lines.push(`path=${info.credentialPath}`);
    const out = await run(repo, ['credential', 'fill'], {
      input: lines.join('\n') + '\n\n',
      env: { GCM_INTERACTIVE: 'never' }, // fail instead of opening a sign-in window
      literal: false,
    });
    value = parseCredentialOutput(out);
  } catch {
    value = null; // no stored login: public repositories still work without one
  }
  tokenCache.set(key, { value, at: Date.now() });
  return value;
}

// ---- editing the message of an unpushed commit ------------------------------------
// A commit's message is part of its id, so changing it makes a new commit, and a new version of every
// later commit on the branch (their parent changed). That is done with plumbing: each commit is rebuilt
// with `git commit-tree` from the same tree, author, committer and message, with only the parent (and,
// for the edited one, the message) different, then the branch moves with a single `git update-ref`.
// The files never change, so the working tree and the index are not touched and nothing can conflict.
// Only commits nobody else can have are allowed: not on any remote, and not on another local branch or
// tag, which would be left pointing at the old version.

const EDIT_SCAN = 5000; // how many commits are checked when listing the editable ones
const EDIT_MAX_REWRITE = 250; // later commits that may be rebuilt for one edit (each takes about 0.1 s)

// The new message: summary, a blank line, then the description.
function commitMessageText(summary, description) {
  const clean = (s) => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n') : '');
  const head = clean(summary).trim();
  if (!head) throw new Error('The summary cannot be empty.');
  if (head.includes('\n')) throw new Error('The summary must be a single line. Put the rest in the description.');
  const body = clean(description).replace(/^\n+/, '').trimEnd();
  if (head.includes('\0') || body.includes('\0')) throw new Error('The message cannot contain null characters.');
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

// "Name <email> 1700000000 +0200", as it is stored in a commit
function parseIdent(line) {
  const m = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(line || '');
  if (!m) throw new Error('Could not read the author or date of a commit.');
  return { name: m[1], email: m[2], date: `${m[3]} ${m[4]}` };
}

function parseCommitObject(buf) {
  const end = buf.indexOf('\n\n');
  const lines = (end < 0 ? buf : buf.subarray(0, end)).toString('utf8').split('\n');
  const c = { tree: '', parents: [], author: '', committer: '', encoding: '', message: end < 0 ? Buffer.alloc(0) : buf.subarray(end + 2) };
  for (const line of lines) {
    if (line.startsWith(' ')) continue; // the rest of a multi-line header such as a signature
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') c.tree = val;
    else if (key === 'parent') c.parents.push(val);
    else if (key === 'author') c.author = val;
    else if (key === 'committer') c.committer = val;
    else if (key === 'encoding') c.encoding = val;
  }
  return c;
}

// Reads commit objects byte for byte (a message may not be UTF-8), in the order given.
async function readCommits(repo, hashes) {
  const buf = await run(repo, ['cat-file', '--batch'], { input: hashes.join('\n') + '\n', binary: true });
  const out = new Map();
  let pos = 0;
  for (const h of hashes) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('Could not read the commits.');
    const [oid, type, size] = buf.toString('latin1', pos, nl).split(' ');
    if (type !== 'commit') throw new Error('That is not a commit.');
    const start = nl + 1;
    const n = Number(size);
    out.set(oid, parseCommitObject(buf.subarray(start, start + n)));
    pos = start + n + 1;
    if (!out.has(h)) throw new Error('Could not read the commits.');
  }
  return out;
}

const nameList = (names) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

// Throws a sentence for the user when this commit may not be edited; otherwise says what editing it involves.
async function checkEditable(repo, hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new Error('Invalid commit');
  // the questions below are independent, so ask them together: every git call costs about 0.1 s on Windows
  const [hasCommits, op] = await Promise.all([hasHead(repo), operationState(repo).catch(() => null)]);
  if (!hasCommits) throw new Error('This repository has no commits.');
  if (op) throw new Error(`Finish or abort the ${op.kind} that is in progress first.`);
  const [type, headOut, currentOut, holdersOut] = await Promise.all([
    run(repo, ['cat-file', '-t', hash], { okCodes: [0, 128] }),
    run(repo, ['rev-parse', 'HEAD']),
    run(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] }), // refs/heads/name, or nothing when detached
    run(repo, ['for-each-ref', '--contains', hash, '--format=%(refname)', 'refs/remotes', 'refs/heads', 'refs/tags']).catch(() => ''),
  ]);
  if (type.trim() !== 'commit') throw new Error('That commit was not found.');
  const head = headOut.trim();
  const current = currentOut.trim();
  const holders = holdersOut.split('\n').filter(Boolean);
  const remote = holders.filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')).map((r) => r.slice(13));
  if (remote.length) {
    throw new Error(`This commit is already on ${nameList(remote)}. Only commits that have not been pushed can be edited, because changing a pushed commit needs a force push.`);
  }
  const [notOnHead, laterOut] = await Promise.all([
    run(repo, ['rev-list', '--max-count=1', hash, `^${head}`]),
    run(repo, ['rev-list', '--topo-order', '--reverse', '--ancestry-path', `${hash}..${head}`]),
  ]);
  if (notOnHead.trim()) throw new Error('This commit is not on the checked-out branch. Check out the branch it belongs to first.');
  const branches = holders.filter((r) => r.startsWith('refs/heads/') && r !== current).map((r) => r.slice(11));
  if (branches.length) throw new Error(`This commit is also on ${branches.length === 1 ? 'branch' : 'branches'} ${nameList(branches)}, which would keep the old version of it.`);
  const tags = holders.filter((r) => r.startsWith('refs/tags/')).map((r) => r.slice(10));
  if (tags.length) throw new Error(`This commit is tagged ${nameList(tags)}, and the tag would keep pointing at the old version.`);

  const later = laterOut.split('\n').filter(Boolean);
  if (later.length > EDIT_MAX_REWRITE) {
    throw new Error(`Editing this commit would rewrite the ${later.length} commits after it. The limit is ${EDIT_MAX_REWRITE}.`);
  }
  return { head, later, branch: current ? current.slice(11) : null };
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
    const [out, operation] = await Promise.all([
      run(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      operationState(repo).catch(() => null),
    ]);
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
    const resolved = operation ? await resolvedPaths(repo) : [];
    return { ...info, files, operation, resolved };
  },

  async commitDetail({ repo, hash }) {
    assertRepo(repo);
    const out = await run(repo, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B', safeRef(hash)]);
    const [h, parents, author, email, date, ...msg] = out.split('\x1f');
    return { hash: h, parents: parents ? parents.split(' ') : [], author, email, date, message: msg.join('\x1f').trim() };
  },

  async commitFiles({ repo, hash }) {
    assertRepo(repo);
    const nameStatus = async (ref) => {
      const out = await run(repo, ['show', '--no-color', '--format=', '-m', '--first-parent', '--name-status', '-z', ref]);
      const tokens = out.replace(/^\n+/, '').split('\0');
      const list = [];
      for (let i = 0; i < tokens.length; i++) {
        const status = tokens[i];
        if (!status) continue;
        if (status[0] === 'R' || status[0] === 'C') {
          list.push({ status: status[0], orig: tokens[i + 1], path: tokens[i + 2] });
          i += 2;
        } else {
          list.push({ status: status[0], path: tokens[i + 1] });
          i += 1;
        }
      }
      return list;
    };
    const files = await nameStatus(safeRef(hash));

    // `git stash -u` keeps the untracked (new) files in a separate commit, the stash's third parent,
    // which `git show` on the stash never lists. Only real stashes get this: an octopus merge also
    // has a third parent, but that is ordinary history.
    const stashes = (await run(repo, ['stash', 'list', '--format=%H']).catch(() => '')).split('\n');
    if (stashes.includes(hash)) {
      const untracked = (await run(repo, ['rev-parse', '--verify', '-q', `${hash}^3`], { okCodes: [0, 1] })).trim();
      if (untracked) {
        const known = new Set(files.map((f) => f.path));
        for (const f of await nameStatus(untracked)) {
          // `ref` is the commit to diff this file against, since it is not in the stash commit itself
          if (!known.has(f.path)) files.push({ ...f, status: 'A', ref: untracked });
        }
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
  // Throws away every unstaged change: tracked files go back to what is staged (or committed), and
  // untracked files are deleted unless `untracked` is false. Staged changes and ignored files are kept.
  async discardAll({ repo, untracked = true }) {
    assertRepo(repo);
    if ((await unmergedEntries(repo)).size > 0) throw new Error('Resolve the conflicted files first.');
    // `git restore .` fails when nothing is tracked yet, so only run it when there is something to revert
    if ((await run(repo, ['diff', '--name-only', '-z'])).length > 0) await run(repo, ['restore', '--worktree', '--', '.']);
    if (untracked) await run(repo, ['clean', '-f', '-d']);
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

  // Commits on the checked-out branch whose message may be edited (see "editing the message" above).
  async editableCommits({ repo }) {
    assertRepo(repo);
    if (!(await hasHead(repo))) return { hashes: [], reason: null };
    const op = await operationState(repo).catch(() => null);
    if (op) return { hashes: [], reason: `Finish or abort the ${op.kind} first` };
    const current = (await run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })).trim();
    const args = ['rev-list', `--max-count=${EDIT_SCAN}`, 'HEAD', '--not', '--remotes'];
    if (current) args.push(`--exclude=${current}`); // the checked-out branch is allowed to contain them
    args.push('--branches', '--tags');
    const out = await run(repo, args);
    return { hashes: out.split('\n').filter(Boolean), reason: null };
  },

  // The message of a commit split for editing, or the reason it cannot be edited.
  async commitEditInfo({ repo, hash }) {
    assertRepo(repo);
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new Error('Invalid commit');
    const [{ later, branch }, shown] = await Promise.all([checkEditable(repo, hash), run(repo, ['show', '-s', '--format=%B', hash]).catch(() => '')]);
    const text = shown.replace(/\r\n?/g, '\n').trimEnd();
    const nl = text.indexOf('\n');
    const summary = nl < 0 ? text : text.slice(0, nl);
    const description = nl < 0 ? '' : text.slice(nl + 1).replace(/^\n+/, '');
    return { summary, description, later: later.length, branch };
  },

  // Gives a commit a new message. The commits after it on the branch are rebuilt on top of it, with
  // everything else about them unchanged, and the branch moves to the new tip. `map` lists old -> new ids.
  async rewordCommit({ repo, hash, summary, description }) {
    assertRepo(repo);
    const message = Buffer.from(commitMessageText(summary, description), 'utf8');
    const { head, later } = await checkEditable(repo, hash);
    const chain = [hash, ...later];
    const commits = await readCommits(repo, chain);
    if (Buffer.compare(commits.get(hash).message, message) === 0) throw new Error('The message is unchanged.');

    // like `git commit --amend`, the edited commit gets the person who edits it as its committer
    let editor = null;
    try {
      editor = parseIdent((await run(repo, ['var', 'GIT_COMMITTER_IDENT'])).trim());
    } catch {
      /* no identity set up: keep the original committer */
    }
    const made = new Map();
    for (const old of chain) {
      const c = commits.get(old);
      const author = parseIdent(c.author);
      const committer = old === hash && editor ? editor : parseIdent(c.committer);
      const args = [];
      if (old !== hash && /^[\w.:-]+$/.test(c.encoding)) args.push('-c', `i18n.commitEncoding=${c.encoding}`); // keep a non-UTF-8 message as it was
      args.push('commit-tree', c.tree);
      for (const p of c.parents) args.push('-p', made.get(p) ?? p);
      const out = await run(repo, args, {
        input: old === hash ? message : c.message,
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_DATE: author.date,
          GIT_COMMITTER_NAME: committer.name,
          GIT_COMMITTER_EMAIL: committer.email,
          GIT_COMMITTER_DATE: committer.date,
        },
      });
      made.set(old, out.trim());
    }

    // the files must be exactly what they were; then move the branch, but only if it is still where it was
    const newHead = made.get(head);
    const tree = async (c) => (await run(repo, ['rev-parse', `${c}^{tree}`])).trim();
    if (!newHead || (await tree(newHead)) !== (await tree(head))) throw new Error('The files would have changed, so nothing was changed.');
    await run(repo, ['update-ref', '-m', `reword: ${String(summary).trim()}`, 'HEAD', newHead, head]);
    return { hash: made.get(hash), head: newHead, map: Object.fromEntries(made) };
  },

  async fetch({ repo }) {
    assertRepo(repo);
    await run(repo, ['fetch', '--all', '--prune']);
  },
  async pull({ repo }) {
    assertRepo(repo);
    try {
      await run(repo, ['pull', '--no-edit']);
    } catch (e) {
      return conflictsOrThrow(repo, e);
    }
    return { conflicts: false };
  },
  async push({ repo }) {
    assertRepo(repo);
    const upstream = (await run(repo, ['rev-parse', '--abbrev-ref', '@{u}'], { okCodes: [0, 128] }).catch(() => '')).trim();
    const branch = (await run(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })).trim();
    const publish = async (remote) => {
      await run(repo, ['push', '-u', remote, branch]);
      return { published: `${remote}/${branch}` };
    };
    if (upstream) {
      try {
        await run(repo, ['push']);
        return {};
      } catch (e) {
        // A branch created from origin/main tracks origin/main, and git refuses to push it under a
        // different name. Publish it as its own branch on that remote (and track that) instead of
        // failing; main itself is never touched.
        if (!branch || !/upstream branch of your current branch does not match\s+the name/i.test(e.message)) throw e;
        const remote = (await run(repo, ['config', '--get', `branch.${branch}.remote`], { okCodes: [0, 1] })).trim() || 'origin';
        return publish(remote);
      }
    }
    if (!branch) throw new Error('Cannot push a detached HEAD');
    const remotes = (await run(repo, ['remote'])).split('\n').filter(Boolean);
    if (remotes.length === 0) throw new Error('This repository has no remote to push to');
    return publish(remotes.includes('origin') ? 'origin' : remotes[0]);
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
  // Deletes a branch on the remote itself (git push --delete); the remote-tracking ref disappears with it.
  async deleteRemoteBranch({ repo, remote, branch }) {
    assertRepo(repo);
    safeRef(remote);
    safeRef(branch);
    const remotes = (await run(repo, ['remote'])).split('\n').filter(Boolean);
    if (!remotes.includes(remote)) throw new Error(`"${remote}" is not a remote of this repository`);
    await run(repo, ['push', remote, '--delete', branch]);
  },
  async createTag({ repo, name, hash }) {
    assertRepo(repo);
    safeRef(name);
    await run(repo, ['check-ref-format', `refs/tags/${name}`]);
    await run(repo, ['tag', name, safeRef(hash)]);
  },
  async merge({ repo, ref }) {
    assertRepo(repo);
    let out;
    try {
      out = await run(repo, ['merge', '--no-edit', safeRef(ref)]);
    } catch (e) {
      return { fastForward: false, upToDate: false, ...(await conflictsOrThrow(repo, e)) };
    }
    // tell the UI what happened: a fast-forward creates no merge commit, so it is easy to miss
    return { fastForward: /Fast-forward/.test(out), upToDate: /Already up to date/.test(out), conflicts: false };
  },
  async cherryPick({ repo, hash }) {
    assertRepo(repo);
    try {
      await run(repo, ['cherry-pick', safeRef(hash)]);
    } catch (e) {
      return conflictsOrThrow(repo, e);
    }
    return { conflicts: false };
  },
  async revert({ repo, hash }) {
    assertRepo(repo);
    try {
      await run(repo, ['revert', '--no-edit', safeRef(hash)]);
    } catch (e) {
      return conflictsOrThrow(repo, e);
    }
    return { conflicts: false };
  },

  // ---- resolving conflicts ----

  // Everything the resolver needs about one conflicted file.
  async conflictFile({ repo, file }) {
    assertRepo(repo);
    const stages = await requireConflict(repo, file);
    const abs = insideRepo(repo, file);
    const info = {
      path: file,
      hasBase: !!stages[1],
      hasOurs: !!stages[2],
      hasTheirs: !!stages[3],
      exists: false,
      content: null,
      binary: false,
      tooLarge: false,
      lossy: false,
    };
    let stat = null;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      /* deleted in the working tree */
    }
    if (!stat || !stat.isFile()) return info; // missing, or a symlink / folder we never edit
    info.exists = true;
    if (stat.size > 2 * 1024 * 1024) return { ...info, tooLarge: true };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { ...info, binary: true };
    const text = buf.toString('utf8');
    // text that does not survive a round trip (e.g. Latin-1) would be damaged by editing it here
    if (!Buffer.from(text, 'utf8').equals(buf)) return { ...info, lossy: true };
    return { ...info, content: text };
  },

  // Settles a whole file at once: ours, theirs, keep what is on disk, or delete it.
  async conflictResolve({ repo, file, action }) {
    assertRepo(repo);
    const stages = await requireConflict(repo, file);
    if (action === 'ours' || action === 'theirs') {
      if (!stages[action === 'ours' ? 2 : 3]) throw new Error(`The ${action} side has no version of this file. Choose Keep or Delete instead.`);
      await run(repo, ['checkout', `--${action}`, '--', file]);
      await run(repo, ['add', '--', file]);
    } else if (action === 'keep') {
      if (!fs.existsSync(insideRepo(repo, file))) throw new Error('The file is not on disk, so there is nothing to keep.');
      await run(repo, ['add', '--', file]);
    } else if (action === 'delete') {
      await run(repo, ['rm', '-f', '--', file]);
    } else {
      throw new Error('Invalid resolution');
    }
  },

  // Writes the resolved text and stages it.
  async conflictSave({ repo, file, content }) {
    assertRepo(repo);
    await requireConflict(repo, file);
    if (typeof content !== 'string' || content.length > 20 * 1024 * 1024) throw new Error('Invalid file content');
    const abs = insideRepo(repo, file);
    const stat = fs.lstatSync(abs);
    if (!stat.isFile()) throw new Error('Only regular files can be edited here');
    fs.writeFileSync(abs, content, 'utf8');
    await run(repo, ['add', '--', file]);
  },

  // Puts the conflict markers back into a file that was resolved by mistake.
  async conflictReopen({ repo, file }) {
    assertRepo(repo);
    insideRepo(repo, file);
    if (!(await resolvedPaths(repo)).includes(file)) throw new Error('Git no longer remembers this conflict, so it cannot be reopened.');
    await run(repo, ['checkout', '--merge', '--', file]);
  },

  async operationContinue({ repo }) {
    assertRepo(repo);
    const op = await operationState(repo);
    if (!op) throw new Error('Nothing is in progress');
    if ((await unmergedEntries(repo)).size > 0) throw new Error('Resolve all conflicted files first.');
    try {
      await run(repo, [op.kind, '--continue']);
    } catch (e) {
      return conflictsOrThrow(repo, e); // a rebase can stop again on the next commit
    }
    return { conflicts: false };
  },
  async operationSkip({ repo }) {
    assertRepo(repo);
    const op = await operationState(repo);
    if (!op || op.kind === 'merge') throw new Error('There is nothing to skip');
    try {
      await run(repo, [op.kind, '--skip']);
    } catch (e) {
      return conflictsOrThrow(repo, e);
    }
    return { conflicts: false };
  },
  async operationAbort({ repo }) {
    assertRepo(repo);
    const op = await operationState(repo);
    if (!op) throw new Error('Nothing is in progress');
    await run(repo, [op.kind, '--abort']);
  },
  async reset({ repo, hash, mode }) {
    assertRepo(repo);
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Invalid reset mode');
    await run(repo, ['reset', `--${mode}`, safeRef(hash)]);
  },

  // Open pull requests of this repository's GitHub / Azure DevOps remote (read only). The login is
  // whatever Git Credential Manager already holds for that host; it is asked for without any prompt,
  // kept in memory for a couple of minutes, and sent only to the provider's own API.
  async pullRequests({ repo }) {
    assertRepo(repo);
    const remotes = (await run(repo, ['remote', '-v']).catch(() => ''))
      .split('\n')
      .map((l) => /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => ({ name: m[1], url: m[2] }));
    // origin first, then any other remote that is hosted somewhere we know
    remotes.sort((a, b) => (a.name === 'origin' ? -1 : 0) - (b.name === 'origin' ? -1 : 0));
    const found = remotes.map((r) => ({ remote: r.name, info: parseRemoteUrl(r.url) })).find((r) => r.info);
    if (!found) return { provider: null, prs: [] };
    const { info, remote } = found;

    const token = await credentialToken(repo, info);
    const result = await listPullRequests(info, token ? token.token : null);
    return {
      provider: info.provider,
      remote,
      name: info.name,
      webUrl: info.webUrl,
      listUrl: info.listUrl,
      prs: result.prs,
      error: result.error || null,
      authenticated: result.authenticated,
    };
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
    try {
      await run(repo, ['stash', 'pop', ref]);
    } catch (e) {
      return conflictsOrThrow(repo, e, { stashKept: true }); // git keeps the stash when applying it conflicts
    }
    return { conflicts: false };
  },
  async stashApply({ repo, ref }) {
    assertRepo(repo);
    if (!STASH_RE.test(ref || '')) throw new Error('Invalid stash');
    try {
      await run(repo, ['stash', 'apply', ref]);
    } catch (e) {
      return conflictsOrThrow(repo, e, { stashKept: true });
    }
    return { conflicts: false };
  },
  async stashDrop({ repo, ref }) {
    assertRepo(repo);
    if (!STASH_RE.test(ref || '')) throw new Error('Invalid stash');
    await run(repo, ['stash', 'drop', ref]);
  },

  // Is a newer build of the app waiting in a local folder? (Installing it is the shell's job, see main.cjs.)
  async checkUpdate({ folder }) {
    return updates.check({ folder });
  },
  async verifyUpdate({ folder, version }) {
    return updates.verify({ folder, version });
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
