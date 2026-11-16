import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, isElectron, pickFolder } from './api';
import { DetachedBanner } from './components/DetachedBanner';
import { DiffView } from './components/DiffView';
import { GraphView } from './components/GraphView';
import { Splitter } from './components/Splitter';
import { ConfirmDialog, ContextMenu, PromptDialog, type ConfirmSpec, type MenuItem, type PromptSpec } from './components/Overlays';
import { CommitPanel, StagingPanel } from './components/RightPanel';
import { Sidebar, type SidebarItem } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { parseTrack } from './util';
import { DEFAULT_REFS_W, WIP_HASH, computeGraph } from './graph';
import { Icon } from './icons';
import type { Commit, DiffTarget, RefsData, RepoSnapshot, Selection, StatusData, StatusFile, UndoOp } from './types';

const LAST_REPO_KEY = 'gitgui.lastRepo';
const RECENT_KEY = 'gitgui.recent';
const PAGE = 1000;
const MAX_HISTORY = 50;

const SIDEBAR = { key: 'gitgui.sidebarWidth', def: 250, min: 180, max: 480 };
const RIGHT = { key: 'gitgui.rightWidth', def: 380, min: 300, max: 640 };
const REFS = { key: 'gitgui.refsWidth', def: DEFAULT_REFS_W, min: 120, max: 420 };

function readWidth(p: { key: string; def: number; min: number; max: number }): number {
  const n = Number(readStore(p.key));
  return Number.isFinite(n) && n >= p.min && n <= p.max ? n : p.def;
}

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable; the app works without it */
  }
}
function readRecent(): string[] {
  try {
    const v = JSON.parse(readStore(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface Toast {
  text: string;
  error: boolean;
}

export function App() {
  const [repo, setRepo] = useState<{ root: string; name: string } | null>(null);
  const [refs, setRefs] = useState<RefsData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [sel, setSel] = useState<Selection>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [focus, setFocus] = useState<{ hash: string; nonce: number } | null>(null);
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [prompt, setPrompt] = useState<PromptSpec | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const [redoStack, setRedoStack] = useState<UndoOp[]>([]);
  const [sidebarW, setSidebarW] = useState(() => readWidth(SIDEBAR));
  const [rightW, setRightW] = useState(() => readWidth(RIGHT));
  const [refsW, setRefsW] = useState(() => readWidth(REFS));

  useEffect(() => writeStore(SIDEBAR.key, String(sidebarW)), [sidebarW]);
  useEffect(() => writeStore(RIGHT.key, String(rightW)), [rightW]);
  useEffect(() => writeStore(REFS.key, String(refsW)), [refsW]);

  const undoRef = useRef(undoStack);
  const redoRef = useRef(redoStack);
  const busyRef = useRef<string | null>(null);
  undoRef.current = undoStack;
  redoRef.current = redoStack;
  busyRef.current = busy;

  const refsKey = useRef('');
  const limitRef = useRef(limit);
  const repoRef = useRef<string | null>(null);
  limitRef.current = limit;
  repoRef.current = repo?.root ?? null;

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const notifyError = useCallback((text: string) => setToast({ text, error: true }), []);

  useEffect(() => {
    if (!toast || toast.error) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  /* ---------- loading ---------- */

  const reload = useCallback(async (root: string, forceLog = false) => {
    const [r, s] = await Promise.all([call<RefsData>('refs', { repo: root }), call<StatusData>('status', { repo: root })]);
    if (repoRef.current !== root) return;
    const key = JSON.stringify([r.head, r.branches, r.remoteBranches, r.tags]);
    setRefs(r);
    setStatus(s);
    if (forceLog || key !== refsKey.current) {
      refsKey.current = key;
      const log = await call<Commit[]>('log', { repo: root, limit: limitRef.current });
      if (repoRef.current === root) setCommits(log);
    }
  }, []);

  const openRepo = useCallback(
    async (path: string) => {
      try {
        const info = await call<{ root: string; name: string }>('openRepo', { path });
        repoRef.current = info.root;
        refsKey.current = '';
        setRepo(info);
        setRefs(null);
        setStatus(null);
        setCommits([]);
        setSel(null);
        setDiff(null);
        setQuery('');
        setUndoStack([]);
        setRedoStack([]);
        setLimit(PAGE);
        limitRef.current = PAGE;
        writeStore(LAST_REPO_KEY, info.root);
        const list = [info.root, ...readRecent().filter((p) => p !== info.root)].slice(0, 8);
        writeStore(RECENT_KEY, JSON.stringify(list));
        setRecent(list);
        await reload(info.root, true);
      } catch (e) {
        notifyError((e as Error).message);
      }
    },
    [reload, notifyError],
  );

  useEffect(() => {
    const last = readStore(LAST_REPO_KEY);
    if (last) void openRepo(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // pick up changes made outside the app whenever the window regains focus
  useEffect(() => {
    const onFocus = () => repoRef.current && void reload(repoRef.current).catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  // load more history when the user scrolls near the end
  useEffect(() => {
    if (repoRef.current && limit > PAGE) void reload(repoRef.current, true).catch(() => {});
  }, [limit, reload]);

  // choose a sensible selection
  useEffect(() => {
    if (!status || !refs) return;
    const dirty = status.files.length > 0;
    if (!sel) setSel(dirty ? { kind: 'wip' } : refs.head ? { kind: 'commit', hash: refs.head } : null);
    else if (sel.kind === 'wip' && !dirty) setSel(refs.head ? { kind: 'commit', hash: refs.head } : null);
  }, [sel, status, refs]);

  useEffect(() => setDiff(null), [sel]);

  // a working-tree diff has nothing left to show once its file is committed, reverted or fully (un)staged
  useEffect(() => {
    if (!diff || diff.hash || !status) return;
    const still = status.files.some((f) =>
      f.path === diff.path && (diff.staged ? f.index !== '.' && f.index !== '?' : f.worktree !== '.' || !!f.conflicted),
    );
    if (!still) setDiff(null);
  }, [diff, status]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setDiff(null);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  /* ---------- actions ---------- */

  const act = useCallback(
    async (
      label: string,
      fn: () => Promise<unknown>,
      opts: {
        ok?: string | ((result: unknown) => string);
        log?: boolean;
        undo?: { label: string; mode?: 'soft' | 'keep' };
        /** return true when the failure was handled (e.g. by opening a dialog) so no error toast is shown */
        onError?: (message: string) => boolean;
      } = {},
    ) => {
      const root = repoRef.current;
      if (!root) return false;
      setBusy(label);
      let ok = true;
      try {
        const undo = opts.undo;
        const before = undo ? await call<RepoSnapshot>('snapshot', { repo: root }).catch(() => null) : null;
        const result = await fn();
        if (undo && before?.head.hash) {
          const after = await call<RepoSnapshot>('snapshot', { repo: root }).catch(() => null);
          if (after && JSON.stringify(after) !== JSON.stringify(before)) {
            const op: UndoOp = { label: undo.label, before, after, mode: undo.mode ?? 'keep' };
            setUndoStack((s) => [...s, op].slice(-MAX_HISTORY));
            setRedoStack([]);
          }
        }
        if (opts.ok) notify(typeof opts.ok === 'function' ? opts.ok(result) : opts.ok);
      } catch (e) {
        ok = false;
        const msg = (e as Error).message;
        if (!opts.onError?.(msg)) notify(msg, true);
      }
      try {
        await reload(root, opts.log ?? true);
      } catch (e) {
        notify((e as Error).message, true);
      }
      setBusy(null);
      return ok;
    },
    [reload, notify],
  );

  const stepHistory = useCallback(
    async (dir: 'undo' | 'redo') => {
      const root = repoRef.current;
      const stack = dir === 'undo' ? undoRef.current : redoRef.current;
      const op = stack[stack.length - 1];
      if (!root || !op || busyRef.current) return;
      setBusy(dir === 'undo' ? 'Undoing' : 'Redoing');
      try {
        await call('restoreState', {
          repo: root,
          from: dir === 'undo' ? op.after : op.before,
          to: dir === 'undo' ? op.before : op.after,
          mode: op.mode,
        });
        if (dir === 'undo') {
          setUndoStack((s) => s.slice(0, -1));
          setRedoStack((s) => [...s, op]);
        } else {
          setRedoStack((s) => s.slice(0, -1));
          setUndoStack((s) => [...s, op]);
        }
        notify(`${dir === 'undo' ? 'Undid' : 'Redid'}: ${op.label}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith('STALE:')) {
          setUndoStack([]);
          setRedoStack([]);
        }
        notify(msg.replace(/^STALE:\s*/, ''), true);
      }
      try {
        await reload(root, true);
      } catch {
        /* the next focus or action refreshes again */
      }
      setBusy(null);
    },
    [reload, notify],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void stepHistory('undo');
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void stepHistory('redo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stepHistory]);

  const git = useCallback(<T,>(method: string, args: object = {}) => call<T>(method, { repo: repoRef.current, ...args }), []);

  const openDialog = useCallback(async () => {
    if (isElectron) {
      const p = await pickFolder();
      if (p) await openRepo(p);
    } else {
      setPrompt({
        title: 'Open repository',
        label: 'Absolute path to the repository folder',
        placeholder: 'F:\\projects\\my-repo',
        submit: 'Open',
        onSubmit: (v) => void openRepo(v),
      });
    }
  }, [openRepo]);

  const askBranch = (from?: string) =>
    setPrompt({
      title: 'Create branch',
      label: from ? 'Branch name (created at the selected commit)' : 'Branch name (created at HEAD)',
      submit: 'Create branch',
      onSubmit: (name) =>
        void act('Creating branch', () => git('createBranch', { name, from }), { ok: `Created ${name}`, undo: { label: `Create branch ${name}` } }),
    });

  // Git refuses to switch when uncommitted changes would be overwritten. Instead of a bare error,
  // offer to stash those changes first (they stay in the stash list and show in the graph).
  const checkout = (ref: string, kind: 'local' | 'remote' | 'commit') => {
    const run = (stashFirst: boolean) =>
      act(
        stashFirst ? 'Stashing and checking out' : 'Checking out',
        async () => {
          if (stashFirst) await git('stashPush', { message: `Auto-stash before checkout of ${ref}` });
          await git('checkout', { ref, kind });
        },
        {
          ok: stashFirst ? `Stashed your changes and checked out ${ref}` : `Checked out ${ref}`,
          undo: { label: `Checkout ${ref}` },
          onError: stashFirst
            ? undefined
            : (msg) => {
                if (!/would be overwritten by checkout/.test(msg)) return false;
                const files = msg.split('\n').filter((l) => l.startsWith('\t')).map((l) => `• ${l.trim()}`);
                setConfirm({
                  title: `Can't switch to ${ref} yet`,
                  message:
                    'These files have changes that checking out would overwrite:\n' +
                    (files.length ? files.join('\n') : '• (see the changes panel)') +
                    '\n\nStash them and switch? You can pop the stash afterwards.',
                  confirm: 'Stash & checkout',
                  onConfirm: () => void run(true),
                });
                return true;
              },
        },
      );
    void run(false);
  };

  // Branches that can be checked out from a commit: local branches pointing at it, and
  // remote branches pointing at it that have no local branch of the same name yet.
  const branchesAt = (hash: string) => {
    const localNames = new Set((refs?.branches ?? []).map((b) => b.name));
    const locals = (refs?.branches ?? []).filter((b) => b.hash === hash && !b.current).map((b) => b.name);
    const remotes = (refs?.remoteBranches ?? [])
      .filter((r) => r.hash === hash && !localNames.has(r.name.slice(r.name.indexOf('/') + 1)))
      .map((r) => r.name);
    return [
      ...locals.map((name) => ({ name, kind: 'local' as const, label: `Checkout ${name}` })),
      ...remotes.map((name) => ({ name, kind: 'remote' as const, label: `Checkout ${name} (new local branch)` })),
    ];
  };

  // Every branch (local, or remote) at a commit that could be merged into the current branch.
  const mergeTargetsAt = (hash: string) => {
    if (!refs?.current) return [];
    const locals = refs.branches.filter((b) => b.hash === hash && !b.current).map((b) => b.name);
    const remotes = refs.remoteBranches.filter((r) => r.hash === hash).map((r) => r.name);
    return [...locals, ...remotes];
  };
  const merge = (name: string) => {
    const into = refs?.current ?? 'the current branch';
    void act('Merging', () => git<{ fastForward: boolean; upToDate: boolean }>('merge', { ref: name }), {
      ok: (r) => {
        const res = r as { fastForward: boolean; upToDate: boolean } | null;
        if (res?.upToDate) return `${name} is already merged into ${into}`;
        if (res?.fastForward) return `Fast-forwarded ${into} to ${name} (no merge commit needed)`;
        return `Merged ${name} into ${into}`;
      },
      undo: { label: `Merge ${name}` },
    });
  };

  const stashItems = (ref: string): MenuItem[] => [
    { label: 'Pop stash', onClick: () => void act('Popping stash', () => git('stashPop', { ref }), { ok: 'Stash applied and dropped' }) },
    { label: 'Apply stash', onClick: () => void act('Applying stash', () => git('stashApply', { ref }), { ok: 'Stash applied' }) },
    {
      label: 'Drop stash',
      danger: true,
      onClick: () => {
        if (window.confirm('Drop this stash? This cannot be undone.')) void act('Dropping stash', () => git('stashDrop', { ref }));
      },
    },
  ];

  const activateCommit = (e: React.MouseEvent, hash: string) => {
    if (hash === WIP_HASH) return;
    if (stashByHash.has(hash)) return notify('Right-click a stash to pop, apply or drop it.');
    const targets = branchesAt(hash);
    if (targets.length === 1) checkout(targets[0].name, targets[0].kind);
    else if (targets.length > 1) {
      setMenu({ x: e.clientX, y: e.clientY, items: targets.map((t) => ({ label: t.label, onClick: () => checkout(t.name, t.kind) })) });
    } else if ((refs?.branches ?? []).some((b) => b.hash === hash && b.current)) notify(`Already on ${refs?.current}`);
    else notify('No branch points here. Right-click the commit to create a branch or check it out.');
  };

  const focusHash = (hash: string) => setFocus({ hash, nonce: Date.now() });

  /* ---------- graph data ---------- */

  // Stashes appear as their own rows, directly above the commit they were made on.
  const withStashes = useMemo(() => {
    const byParent = new Map<string, Commit[]>();
    for (const s of refs?.stashes ?? []) {
      if (!s.parent) continue;
      const row: Commit = { hash: s.hash, parents: [s.parent], author: '', email: '', date: s.date, refsRaw: '', subject: s.message, stashRef: s.ref };
      byParent.set(s.parent, [...(byParent.get(s.parent) ?? []), row]);
    }
    if (byParent.size === 0) return commits;
    const out: Commit[] = [];
    for (const c of commits) {
      out.push(...(byParent.get(c.hash) ?? []), c);
    }
    return out;
  }, [commits, refs?.stashes]);

  const stashByHash = useMemo(() => new Map((refs?.stashes ?? []).map((s) => [s.hash, s])), [refs?.stashes]);

  // unpushed / unpulled counts shown on local branch pills
  const tracks = useMemo(() => {
    const out: Record<string, { ahead: number; behind: number }> = {};
    for (const b of refs?.branches ?? []) {
      const t = parseTrack(b.track);
      if (t.ahead || t.behind) out[b.name] = t;
    }
    return out;
  }, [refs?.branches]);

  const graph = useMemo(() => {
    const list = [...withStashes];
    if (status && status.files.length > 0) {
      list.unshift({
        hash: WIP_HASH,
        parents: refs?.head ? [refs.head] : [],
        author: '',
        email: '',
        date: 0,
        refsRaw: '',
        subject: '// WIP',
      });
    }
    return computeGraph(list);
  }, [withStashes, status, refs?.head]);

  const commitSet = useMemo(() => new Set(commits.map((c) => c.hash)), [commits]);

  /* ---------- search ---------- */

  const matchList = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return commits.filter((c) => c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q)).map((c) => c.hash);
  }, [commits, query]);
  const matchSet = useMemo(() => new Set(matchList), [matchList]);

  useEffect(() => setMatchIdx(0), [query]);

  const jumpTo = (hash: string) => {
    setSel({ kind: 'commit', hash });
    focusHash(hash);
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || matchList.length === 0) return;
    const next = (matchIdx + (e.shiftKey ? -1 : 1) + matchList.length) % matchList.length;
    setMatchIdx(next);
    jumpTo(matchList[next]);
  };

  /* ---------- context menus ---------- */

  const commitMenu = (e: React.MouseEvent, hash: string) => {
    e.preventDefault();
    if (hash === WIP_HASH) return;
    const stash = stashByHash.get(hash);
    if (stash) {
      setMenu({ x: e.clientX, y: e.clientY, items: stashItems(stash.ref) });
      return;
    }
    const short = hash.slice(0, 7);
    const sep: MenuItem = { label: '', onClick: () => {}, separator: true };
    const branchItems: MenuItem[] = branchesAt(hash).map((t) => ({ label: t.label, onClick: () => checkout(t.name, t.kind) }));
    if (branchItems.length) branchItems.push(sep);
    // Merge: every branch at this commit, or the commit itself when no branch points at it
    const into = refs?.current;
    const mergeTargets = mergeTargetsAt(hash);
    const mergeItems: MenuItem[] = !into
      ? []
      : mergeTargets.length > 0
        ? mergeTargets.map((name) => ({ label: `Merge ${name} into ${into}`, onClick: () => merge(name) }))
        : hash === refs?.head
          ? []
          : [{ label: `Merge this commit into ${into}`, onClick: () => merge(hash) }];
    if (mergeItems.length) mergeItems.push(sep);
    const items: MenuItem[] = [
      ...branchItems,
      ...mergeItems,
      { label: 'Checkout this commit (detached HEAD)', onClick: () => checkout(hash, 'commit') },
      { label: 'Create branch here…', onClick: () => askBranch(hash) },
      {
        label: 'Create tag here…',
        onClick: () =>
          setPrompt({
            title: 'Create tag',
            label: 'Tag name',
            submit: 'Create tag',
            onSubmit: (name) =>
              void act('Tagging', () => git('createTag', { name, hash }), { ok: `Created tag ${name}`, undo: { label: `Create tag ${name}` } }),
          }),
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Cherry-pick commit',
        onClick: () => void act('Cherry-picking', () => git('cherryPick', { hash }), { ok: `Cherry-picked ${short}`, undo: { label: `Cherry-pick ${short}` } }),
      },
      {
        label: 'Revert commit',
        onClick: () => void act('Reverting', () => git('revert', { hash }), { ok: `Reverted ${short}`, undo: { label: `Revert ${short}` } }),
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Reset current branch here (soft)',
        onClick: () => void act('Resetting', () => git('reset', { hash, mode: 'soft' }), { undo: { label: `Soft reset to ${short}` } }),
      },
      {
        label: 'Reset current branch here (mixed)',
        onClick: () => void act('Resetting', () => git('reset', { hash, mode: 'mixed' }), { undo: { label: `Mixed reset to ${short}` } }),
      },
      {
        label: 'Reset current branch here (hard)',
        danger: true,
        onClick: () => {
          if (window.confirm(`Hard reset to ${short}? Uncommitted changes will be lost.`)) {
            void act('Resetting', () => git('reset', { hash, mode: 'hard' }), { undo: { label: `Hard reset to ${short}` } });
          }
        },
      },
      { label: '', onClick: () => {}, separator: true },
      { label: 'Copy commit SHA', onClick: () => void navigator.clipboard.writeText(hash) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const sidebarMenu = (e: React.MouseEvent, item: SidebarItem) => {
    e.preventDefault();
    const items: MenuItem[] = [];
    if (item.kind === 'branch') {
      const isCurrent = refs?.current === item.name;
      items.push(
        { label: 'Checkout', disabled: isCurrent, onClick: () => checkout(item.name, 'local') },
        { label: `Merge into ${refs?.current ?? 'current branch'}`, disabled: isCurrent || !refs?.current, onClick: () => merge(item.name) },
        { label: 'Create branch here…', onClick: () => askBranch(item.name) },
        {
          label: 'Delete branch',
          danger: true,
          disabled: isCurrent,
          onClick: () => {
            if (window.confirm(`Delete branch "${item.name}"?`)) {
              void act('Deleting', () => git('deleteBranch', { name: item.name }), { ok: `Deleted ${item.name}`, undo: { label: `Delete branch ${item.name}` } });
            }
          },
        },
      );
    } else if (item.kind === 'remote') {
      items.push(
        { label: 'Checkout (track)', onClick: () => checkout(item.name, 'remote') },
        { label: `Merge into ${refs?.current ?? 'current branch'}`, disabled: !refs?.current, onClick: () => merge(item.name) },
      );
    } else if (item.kind === 'stash') {
      items.push(...stashItems(item.ref));
    } else {
      items.push({ label: 'Checkout', onClick: () => checkout(item.name, 'commit') });
    }
    if (item.kind !== 'stash') items.push({ label: 'Copy name', onClick: () => void navigator.clipboard.writeText(item.name) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onSidebarFocus = (item: SidebarItem) => {
    if (item.kind === 'stash') {
      setSel({ kind: 'stash', hash: item.hash });
      focusHash(item.hash);
    } else if (commitSet.has(item.hash)) jumpTo(item.hash);
  };
  const onSidebarActivate = (item: SidebarItem) => {
    if (item.kind === 'branch') checkout(item.name, 'local');
    else if (item.kind === 'remote') checkout(item.name, 'remote');
  };

  /* ---------- working directory ---------- */

  const discard = (f: StatusFile) => {
    const msg = f.untracked ? `Delete the untracked file "${f.path}"? This cannot be undone.` : `Discard all unstaged changes to "${f.path}"? This cannot be undone.`;
    if (window.confirm(msg)) void act('Discarding', () => git('discard', { files: [f.path], untracked: f.untracked }), { log: false });
  };

  const selectedHash = sel?.kind === 'wip' ? WIP_HASH : sel ? sel.hash : null;
  const branchName = status?.branch ?? refs?.current ?? null;
  const detachedAt = repo && refs && refs.current === null ? refs.head : null;

  const switchBranchMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // the menu closes on any window click, including this one
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = (refs?.branches ?? []).map((b) => ({ label: b.name, onClick: () => checkout(b.name, 'local') }));
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  return (
    <div className="app">
      <Toolbar
        repoName={repo?.name ?? null}
        branch={repo ? branchName : null}
        ahead={status?.ahead ?? 0}
        behind={status?.behind ?? 0}
        busy={busy}
        query={query}
        matchInfo={matchList.length ? `${Math.min(matchIdx + 1, matchList.length)}/${matchList.length}` : '0'}
        onQuery={setQuery}
        onSearchKey={onSearchKey}
        onOpen={() => void openDialog()}
        onFetch={() => void act('Fetching', () => git('fetch'), { ok: 'Fetched all remotes' })}
        undoLabel={undoStack.length ? undoStack[undoStack.length - 1].label : null}
        redoLabel={redoStack.length ? redoStack[redoStack.length - 1].label : null}
        onUndo={() => void stepHistory('undo')}
        onRedo={() => void stepHistory('redo')}
        onPull={() => void act('Pulling', () => git('pull'), { ok: 'Pull complete', undo: { label: 'Pull' } })}
        onPush={() => void act('Pushing', () => git('push'), { ok: 'Push complete' })}
        onBranch={() => askBranch()}
        onStash={() => {
          if (!status?.files.length) return notify('Nothing to stash', true);
          void act('Stashing', () => git('stashPush'), { ok: 'Changes stashed' });
        }}
        onPop={() => {
          if (!refs?.stashes.length) return notify('No stashes to pop', true);
          void act('Popping stash', () => git('stashPop', { ref: refs.stashes[0].ref }), { ok: 'Stash applied and dropped' });
        }}
      />

      {detachedAt && (
        <DetachedBanner
          hash={detachedAt}
          atHead={(refs?.branches ?? []).filter((b) => b.hash === detachedAt).map((b) => b.name)}
          hasBranches={(refs?.branches.length ?? 0) > 0}
          busy={busy !== null}
          onCheckout={(name) => checkout(name, 'local')}
          onSwitch={switchBranchMenu}
          onCreate={() => askBranch()}
        />
      )}

      {repo ? (
        <div className="main" style={{ ['--sb-w' as string]: `${sidebarW}px`, ['--rp-w' as string]: `${rightW}px` }}>
          <Sidebar refs={refs} onFocus={onSidebarFocus} onActivate={onSidebarActivate} onContext={sidebarMenu} />
          <Splitter
            label="Resize sidebar"
            value={sidebarW}
            min={SIDEBAR.min}
            max={SIDEBAR.max}
            onChange={setSidebarW}
            onReset={() => setSidebarW(SIDEBAR.def)}
          />
          <section className="center">
            {diff ? (
              <DiffView
                repo={repo.root}
                target={diff}
                onClose={() => setDiff(null)}
                onChanged={() => void reload(repo.root).catch(() => {})}
                onError={notifyError}
              />
            ) : (
              <GraphView
                data={graph}
                remotes={refs?.remotes ?? []}
                selected={selectedHash}
                matches={matchSet}
                focus={focus}
                hasMore={commits.length >= limit}
                refsW={refsW}
                onRefsW={setRefsW}
                tracks={tracks}
                onSelect={(hash) => setSel(hash === WIP_HASH ? { kind: 'wip' } : stashByHash.has(hash) ? { kind: 'stash', hash } : { kind: 'commit', hash })}
                onContext={(e, hash) => commitMenu(e, hash)}
                onActivate={activateCommit}
                onNearEnd={() => setLimit((l) => (commits.length >= l ? l + PAGE : l))}
              />
            )}
          </section>
          <Splitter
            invert
            label="Resize details panel"
            value={rightW}
            min={RIGHT.min}
            max={RIGHT.max}
            onChange={setRightW}
            onReset={() => setRightW(RIGHT.def)}
          />
          <aside className="right">
            {sel?.kind === 'wip' && status ? (
              <StagingPanel
                files={status.files}
                branch={branchName}
                busy={busy !== null}
                active={diff}
                onOpen={setDiff}
                onStage={(paths) => void act('Staging', () => git('stage', { files: paths }), { log: false })}
                onUnstage={(paths) => void act('Unstaging', () => git('unstage', { files: paths }), { log: false })}
                onStageAll={() => void act('Staging', () => git('stageAll'), { log: false })}
                onUnstageAll={() => void act('Unstaging', () => git('unstageAll'), { log: false })}
                onDiscard={discard}
                onCommit={(message, amend) =>
                  act('Committing', () => git('commit', { message, amend }), {
                    ok: amend ? 'Commit amended' : 'Commit created',
                    undo: { label: amend ? 'Amend commit' : 'Commit', mode: 'soft' },
                  })
                }
              />
            ) : sel && sel.kind !== 'wip' ? (
              <CommitPanel key={sel.hash} repo={repo.root} hash={sel.hash} active={diff} onOpen={setDiff} onError={notifyError} />
            ) : (
              <div className="rp-empty">Select a commit to see its details</div>
            )}
          </aside>
        </div>
      ) : (
        <div className="welcome">
          <div className="welcome-card">
            <h1>GitGui</h1>
            <p>Open a Git repository to see its history, branches and changes.</p>
            <button className="btn primary big" onClick={() => void openDialog()}>
              <Icon name="folder" size={16} /> Open repository
            </button>
            {recent.length > 0 && (
              <div className="recent">
                <h4>Recent</h4>
                {recent.map((p) => (
                  <button key={p} className="recent-item" onClick={() => void openRepo(p)}>
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={'toast' + (toast.error ? ' error' : '')} role="status">
          <span>{toast.text}</span>
          <button className="icon-btn" onClick={() => setToast(null)} aria-label="Dismiss">
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog spec={prompt} onClose={() => setPrompt(null)} />}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
