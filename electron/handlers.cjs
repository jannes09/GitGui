'use strict';
// Git backend. Shared by the Electron main process (via IPC) and the Vite dev
// server (via /rpc) so the UI can also be run and tested in a plain browser.
// Every git call uses an argument array (never a shell), and user supplied
// refs / paths are validated before they reach git.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never hang waiting for a console prompt
  GIT_OPTIONAL_LOCKS: '0', // read-only commands must not fight over index.lock
  GIT_EDITOR: 'true', // never open an editor from a background process
};
delete ENV.ELECTRON_RUN_AS_NODE;

const BASE_ARGS = ['--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'color.ui=false'];

function run(repo, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_ARGS, ...args], { cwd: repo, env: ENV, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'git was not found on PATH' : e.message)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if ((opts.okCodes || [0]).includes(code)) resolve(stdout);
      else reject(new Error((stderr || stdout || `git exited with code ${code}`).trim()));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input == null ? undefined : opts.input);
  });
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

async function hasHead(repo) {
  const out = await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] });
  return out.trim().length > 0;
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
      run(repo, ['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%at']).catch(() => ''),
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
        const [ref, hash, message, at] = l.split('\x1f');
        return { ref, hash, message, date: Number(at) };
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
    await run(repo, ['merge', '--no-edit', safeRef(ref)]);
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

  async stashPush({ repo, message }) {
    assertRepo(repo);
    const args = ['stash', 'push', '--include-untracked'];
    if (typeof message === 'string' && message.trim()) args.push('-m', message.trim());
    await run(repo, args);
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
