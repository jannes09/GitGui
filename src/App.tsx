import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, isElectron, pickFolder } from './api';
import { ConflictView } from './components/ConflictView';
import { DetachedBanner } from './components/DetachedBanner';
import { OperationBanner } from './components/OperationBanner';
import { RepoTabs, type RepoTab, type TabInfo } from './components/RepoTabs';
import { DiffView } from './components/DiffView';
import { GraphView } from './components/GraphView';
import { Splitter } from './components/Splitter';
import { AccountsDialog } from './components/AccountsDialog';
import { ConfirmDialog, ContextMenu, PromptDialog, type ConfirmSpec, type MenuItem, type PromptSpec } from './components/Overlays';
import { CommitPanel, StagingPanel } from './components/RightPanel';
import { Sidebar, type SidebarItem } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { basename, parseTrack, samePath } from './util';
import { DEFAULT_REFS_W, WIP_HASH, computeGraph } from './graph';
import { Icon } from './icons';
import type {
  AccountProfile,
  AccountsData,
  ActiveAccount,
  Commit,
  ConflictOutcome,
  DiffTarget,
  RefsData,
  RepoSnapshot,
  Selection,
  StatusData,
  StatusFile,
  UndoOp,
} from './types';

const LAST_REPO_KEY = 'gitgui.lastRepo';
const RECENT_KEY = 'gitgui.recent';
const TABS_KEY = 'gitgui.tabs';
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

/** The tabs that were open last time. Falls back to the single repository older versions remembered. */
function readTabs(): RepoTab[] {
  try {
    const v = JSON.parse(readStore(TABS_KEY) ?? 'null');
    if (Array.isArray(v)) {
      const tabs = v
        .filter((t): t is RepoTab => !!t && typeof t.root === 'string' && typeof t.name === 'string' && t.root.length > 0)
        .map((t) => ({ ...t, alias: typeof t.alias === 'string' && t.alias.trim() ? t.alias.trim().slice(0, 60) : undefined }));
      return tabs.filter((t, i) => tabs.findIndex((o) => samePath(o.root, t.root)) === i);
    }
  } catch {
    /* fall through to the old single-repository setting */
  }
  const last = readStore(LAST_REPO_KEY);
  return last ? [{ root: last, name: basename(last) }] : [];
}

function summarize(s: StatusData): TabInfo {
  return { branch: s.branch, changes: s.files.length, conflicts: s.files.filter((f) => f.conflicted).length };
}

/** What a tab remembers while another repository is showing. */
interface TabMemory {
  undo: UndoOp[];
  redo: UndoOp[];
  sel: Selection;
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
  const [accounts, setAccounts] = useState<AccountsData | null>(null);
  const [activeAcct, setActiveAcct] = useState<ActiveAccount | null>(null);
  const [acctDialog, setAcctDialog] = useState(false);
  const [acctBusy, setAcctBusy] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [tabs, setTabs] = useState<RepoTab[]>(readTabs);
  const [tabInfo, setTabInfo] = useState<Record<string, TabInfo | undefined>>({});
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const [redoStack, setRedoStack] = useState<UndoOp[]>([]);
  const [sidebarW, setSidebarW] = useState(() => readWidth(SIDEBAR));
  const [rightW, setRightW] = useState(() => readWidth(RIGHT));
  const [refsW, setRefsW] = useState(() => readWidth(REFS));

  useEffect(() => writeStore(SIDEBAR.key, String(sidebarW)), [sidebarW]);
  useEffect(() => writeStore(RIGHT.key, String(rightW)), [rightW]);
  useEffect(() => writeStore(REFS.key, String(refsW)), [refsW]);

  useEffect(() => writeStore(TABS_KEY, JSON.stringify(tabs)), [tabs]);

  const undoRef = useRef(undoStack);
  const redoRef = useRef(redoStack);
  const busyRef = useRef<string | null>(null);
  const selRef = useRef<Selection>(null);
  const statusRef = useRef<StatusData | null>(null);
  const tabsRef = useRef(tabs);
  const memory = useRef(new Map<string, TabMemory>()); // per-repository undo history and selection
  const openSeq = useRef(0); // only the most recent tab switch may finish loading
  undoRef.current = undoStack;
  redoRef.current = redoStack;
  busyRef.current = busy;
  selRef.current = sel;
  statusRef.current = status;
  tabsRef.current = tabs;

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

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await call<AccountsData>('accountsList'));
    } catch (e) {
      notifyError((e as Error).message);
    }
  }, [notifyError]);

  const loadActive = useCallback(async (root: string) => {
    try {
      const a = await call<ActiveAccount>('accountActive', { repo: root });
      if (repoRef.current === root) setActiveAcct(a);
    } catch {
      /* the account button simply stays unset */
    }
  }, []);

  // Reads the status of every tab that is not showing, so their badges stay current.
  const refreshTabs = useCallback(async () => {
    const others = tabsRef.current.filter((t) => !repoRef.current || !samePath(t.root, repoRef.current));
    const entries = await Promise.all(
      others.map(async (t): Promise<[string, TabInfo]> => {
        try {
          return [t.root, summarize(await call<StatusData>('status', { repo: t.root }))];
        } catch {
          return [t.root, { branch: null, changes: 0, conflicts: 0, missing: true }];
        }
      }),
    );
    setTabInfo((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
  }, []);

  // Opening a repository shows it in its tab, adding the tab if it is new.
  const openRepo = useCallback(
    async (path: string) => {
      const seq = ++openSeq.current; // if the user clicks another tab meanwhile, only the last click wins
      try {
        const info = await call<{ root: string; name: string }>('openRepo', { path });
        if (seq !== openSeq.current) return;
        setTabs((list) =>
          list.some((t) => samePath(t.root, info.root))
            ? list.map((t) => (samePath(t.root, info.root) ? { ...t, root: info.root, name: info.name } : t))
            : [...list, { root: info.root, name: info.name }],
        );
        writeStore(LAST_REPO_KEY, info.root);
        const recents = [info.root, ...readRecent().filter((p) => p !== info.root)].slice(0, 8);
        writeStore(RECENT_KEY, JSON.stringify(recents));
        setRecent(recents);

        const prev = repoRef.current;
        if (prev && samePath(prev, info.root)) {
          await reload(info.root, true); // already showing: just refresh
          return;
        }
        if (prev) {
          // leaving a repository: keep its undo history and selection for when its tab is opened again
          memory.current.set(prev, { undo: undoRef.current, redo: redoRef.current, sel: selRef.current });
          const left = statusRef.current;
          if (left) setTabInfo((t) => ({ ...t, [prev]: summarize(left) }));
        }
        const saved = memory.current.get(info.root);
        repoRef.current = info.root;
        refsKey.current = '';
        setRepo(info);
        setActiveAcct(null);
        void loadActive(info.root);
        setRefs(null);
        setStatus(null);
        setCommits([]);
        setSel(saved?.sel ?? null);
        setDiff(null);
        setQuery('');
        setUndoStack(saved?.undo ?? []);
        setRedoStack(saved?.redo ?? []);
        setLimit(PAGE);
        limitRef.current = PAGE;
        await reload(info.root, true);
        void refreshTabs();
      } catch (e) {
        if (seq === openSeq.current) notifyError((e as Error).message);
      }
    },
    [reload, notifyError, loadActive, refreshTabs],
  );

  const closeTabs = useCallback(
    (roots: string[]) => {
      const list = tabsRef.current;
      const rest = list.filter((t) => !roots.some((r) => samePath(r, t.root)));
      if (rest.length === list.length) return;
      tabsRef.current = rest;
      setTabs(rest);
      for (const r of roots) memory.current.delete(r);
      setTabInfo((info) => Object.fromEntries(Object.entries(info).filter(([k]) => !roots.some((r) => samePath(r, k)))));
      const active = repoRef.current;
      if (!active || !roots.some((r) => samePath(r, active))) return;
      // the tab that was showing is gone: move to its right-hand neighbour, or the last one left
      const at = list.findIndex((t) => samePath(t.root, active));
      const next = rest.find((t) => list.indexOf(t) > at) ?? rest[rest.length - 1];
      if (next) {
        void openRepo(next.root);
        return;
      }
      // that was the last tab: back to the welcome screen
      openSeq.current++;
      repoRef.current = null;
      refsKey.current = '';
      setRepo(null);
      setRefs(null);
      setStatus(null);
      setCommits([]);
      setSel(null);
      setDiff(null);
      setUndoStack([]);
      setRedoStack([]);
      setActiveAcct(null);
      writeStore(LAST_REPO_KEY, '');
    },
    [openRepo],
  );
  const closeTab = useCallback((root: string) => closeTabs([root]), [closeTabs]);

  const moveTab = useCallback((from: number, to: number) => {
    setTabs((list) => {
      if (from === to || !list[from] || to < 0 || to >= list.length) return list;
      const next = [...list];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  }, []);

  useEffect(() => {
    const last = readStore(LAST_REPO_KEY);
    const start = last && tabsRef.current.some((t) => samePath(t.root, last)) ? last : tabsRef.current[0]?.root;
    if (start) void openRepo(start);
    void loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // pick up changes made outside the app whenever the window regains focus
  useEffect(() => {
    const onFocus = () => {
      void refreshTabs();
      const root = repoRef.current;
      if (!root) return;
      void reload(root).catch(() => {});
      void loadActive(root);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload, loadActive, refreshTabs]);

  // a tab that was just restored or added gets its badge without waiting for a focus event
  useEffect(() => {
    void refreshTabs();
  }, [tabs.length, refreshTabs]);

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
    const still = status.files.some(
      (f) =>
        f.path === diff.path &&
        (diff.conflict
          ? !!f.conflicted
          : !f.conflicted && (diff.staged ? f.index !== '.' && f.index !== '?' : f.worktree !== '.')),
    );
    if (!still) setDiff(null);
  }, [diff, status]);

  // When a merge (or similar) stops on conflicts, show the changes panel where they are listed.
  const conflictCountNow = status?.files.filter((f) => f.conflicted).length ?? 0;
  const lastConflicts = useRef(0);
  useEffect(() => {
    if (conflictCountNow > 0 && lastConflicts.current === 0) setSel({ kind: 'wip' });
    lastConflicts.current = conflictCountNow;
  }, [conflictCountNow]);

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
            if (repoRef.current === root) {
              setUndoStack((s) => [...s, op].slice(-MAX_HISTORY));
              setRedoStack([]);
            } else {
              // the user switched to another tab while this ran: file the step under its own repository
              const m = memory.current.get(root);
              if (m) memory.current.set(root, { ...m, undo: [...m.undo, op].slice(-MAX_HISTORY), redo: [] });
            }
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

  /* ---------- GitHub accounts ---------- */

  const isSignedIn = (username: string) => !!accounts?.gcm.accounts.some((a) => a.toLowerCase() === username.toLowerCase());

  const openAccounts = () => {
    void loadAccounts();
    setAcctDialog(true);
  };

  const signIn = async (username?: string): Promise<boolean> => {
    const msg = `Waiting for GitHub sign-in${username ? ` for ${username}` : ''} in your browser…`;
    setAcctBusy(msg);
    setBusy('Signing in');
    try {
      await call('accountSignIn', { username });
      await loadAccounts();
      notify(username ? `Signed in as ${username}` : 'Signed in to GitHub');
      return true;
    } catch (e) {
      notifyError((e as Error).message);
      return false;
    } finally {
      setAcctBusy(null);
      setBusy(null);
    }
  };

  const signOut = async (username: string) => {
    try {
      await call('accountSignOut', { username });
      await loadAccounts();
      notify(`Signed out ${username}`);
    } catch (e) {
      notifyError((e as Error).message);
    }
  };

  const saveAccount = async (profile: AccountProfile): Promise<string | null> => {
    try {
      await call('accountSave', { profile });
      await loadAccounts();
      if (repoRef.current) void loadActive(repoRef.current); // an edited account may be the active one
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  const removeAccount = async (username: string) => {
    if (!window.confirm(`Remove ${username} from this list?\n\nThis does not sign you out of GitHub or change any repository.`)) return;
    try {
      await call('accountRemove', { username });
      await loadAccounts();
    } catch (e) {
      notifyError((e as Error).message);
    }
  };

  // Points this repository (or every repository) at a saved account.
  const switchAccount = async (username: string, scope: 'local' | 'global' = 'local') => {
    const root = repoRef.current;
    if (scope === 'local' && !root) return;
    try {
      const p = await call<AccountProfile>('accountSwitch', { repo: root, username, scope });
      if (root) await loadActive(root);
      notify(
        scope === 'local'
          ? `Using ${p.username} for this repository. Commits will be made as ${p.name}.`
          : `${p.username} is now the default account for all repositories.`,
      );
      if (accounts?.gcm.available && !isSignedIn(p.username)) {
        setConfirm({
          title: `Sign in as ${p.username}?`,
          message: `${p.username} is not signed in to GitHub on this computer yet, so pushing and pulling would fail.\n\nA browser window will open to sign in.`,
          confirm: 'Sign in',
          onConfirm: () => void signIn(p.username),
        });
      }
    } catch (e) {
      notifyError((e as Error).message);
    }
  };

  // Like act(), for operations that talk to GitHub: when they fail because of sign-in or the wrong
  // account, offer to sign in (and then retry) instead of showing a raw git error.
  type ActOpts = Parameters<typeof act>[2];
  const netAct = (label: string, fn: () => Promise<unknown>, opts: ActOpts = {}): void => {
    void act(label, fn, {
      ...opts,
      onError: (msg) => {
        if (!msg.startsWith('AUTH:')) return false;
        const denied = /Permission to (\S+?)(?:\.git)? denied to (\S+?)\.?(?:\s|$)/i.exec(msg);
        if (denied) {
          setConfirm({
            title: 'GitHub refused this account',
            message: `${denied[2]} does not have access to ${denied[1]}.\n\nSwitch to an account that does, then try again.`,
            confirm: 'Open accounts',
            onConfirm: openAccounts,
          });
          return true;
        }
        const who = activeAcct?.username ?? undefined;
        setConfirm({
          title: who ? `Sign in as ${who}?` : 'Sign in to GitHub?',
          message:
            (who ? `${who} is not signed in to GitHub on this computer, so this could not be done.` : 'GitHub needs you to sign in before this can be done.') +
            '\n\nA browser window will open to sign in, and the action will be retried afterwards.',
          confirm: 'Sign in',
          onConfirm: () => void signIn(who).then((ok) => ok && netAct(label, fn, opts)),
        });
        return true;
      },
    });
  };

  const accountMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // the menu closes on any window click, including this one
    void loadAccounts();
    const r = e.currentTarget.getBoundingClientRect();
    const sep: MenuItem = { label: '', onClick: () => {}, separator: true };
    const profiles = accounts?.profiles ?? [];
    const items: MenuItem[] = [{ label: `GitHub account for ${repo?.name ?? 'this repository'}`, disabled: true, onClick: () => {} }];
    if (profiles.length === 0) items.push({ label: 'No accounts saved yet', disabled: true, onClick: () => {} });
    for (const p of profiles) {
      const on = !!activeAcct?.username && activeAcct.username.toLowerCase() === p.username.toLowerCase();
      const status = !accounts?.gcm.available ? '' : isSignedIn(p.username) ? '  ● signed in' : '  ○ not signed in';
      items.push({ label: `${on ? '✓' : ' '}  ${p.username}  ·  ${p.email}${status}`, onClick: () => void switchAccount(p.username) });
    }
    if (activeAcct && activeAcct.remotes.count > 0 && !activeAcct.remotes.githubHttps) {
      items.push(sep, {
        label: activeAcct.remotes.githubSsh
          ? 'This remote uses SSH: only the commit identity changes'
          : 'This remote is not GitHub over HTTPS: only the commit identity changes',
        disabled: true,
        onClick: () => {},
      });
    }
    items.push(sep, { label: 'Add account…', onClick: openAccounts }, { label: 'Manage accounts…', onClick: openAccounts });
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

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
  // Merge, cherry-pick, pull and friends stop on conflicts instead of failing; say so clearly.
  const conflictText = (what: string, r: unknown): string | null => {
    const c = r as ConflictOutcome | null;
    if (!c?.conflicts) return null;
    const n = c.files ?? 0;
    return `${what} stopped: ${n} file${n === 1 ? ' has' : 's have'} conflicts. Resolve them in the changes panel.${c.stashKept ? ' The stash was kept.' : ''}`;
  };

  const merge = (name: string) => {
    const into = refs?.current ?? 'the current branch';
    void act('Merging', () => git<ConflictOutcome>('merge', { ref: name }), {
      ok: (r) => {
        const stopped = conflictText('Merge', r);
        if (stopped) return stopped;
        const res = r as ConflictOutcome | null;
        if (res?.upToDate) return `${name} is already merged into ${into}`;
        if (res?.fastForward) return `Fast-forwarded ${into} to ${name} (no merge commit needed)`;
        return `Merged ${name} into ${into}`;
      },
      undo: { label: `Merge ${name}` },
    });
  };

  /* ---------- deleting branches ---------- */

  // The remote-tracking branch that belongs to a local branch, and the other way round.
  const remoteOf = (local: string): string | null => {
    const names = new Set((refs?.remoteBranches ?? []).map((r) => r.name));
    const upstream = refs?.branches.find((b) => b.name === local)?.upstream;
    if (upstream && names.has(upstream)) return upstream;
    return (refs?.remotes ?? []).map((r) => `${r}/${local}`).find((n) => names.has(n)) ?? null;
  };
  const localOf = (remote: string): string | null => refs?.branches.find((b) => remoteOf(b.name) === remote)?.name ?? null;

  const removeRemote = (full: string) => {
    const remote = (refs?.remotes ?? []).find((r) => full.startsWith(r + '/'));
    if (!remote) return notifyError(`Cannot tell which remote ${full} belongs to.`);
    netAct('Deleting on the remote', () => git('deleteRemoteBranch', { remote, branch: full.slice(remote.length + 1) }), {
      ok: `Deleted ${full} on the remote`,
    });
  };

  // Local first: git refuses it when commits would be lost, and then nothing has been deleted anywhere.
  const removeLocal = (name: string, alsoRemote: string | null, force = false) => {
    void act('Deleting', () => git('deleteBranch', { name, force }), {
      ok: `Deleted ${name}`,
      undo: { label: `Delete branch ${name}` },
      onError: (msg) => {
        if (!/not fully merged/i.test(msg)) return false;
        setConfirm({
          title: `${name} has unmerged commits`,
          message: `Some commits on "${name}" are not on any other branch. Deleting it makes them hard to find again.\n\nDelete it anyway?`,
          confirm: 'Delete anyway',
          onConfirm: () => removeLocal(name, alsoRemote, true),
        });
        return true;
      },
    }).then((ok) => {
      if (ok && alsoRemote) removeRemote(alsoRemote);
    });
  };

  // Delete options for a branch: the local copy, the copy on the remote, or both.
  const deleteItems = (localIn: string | null, remoteIn: string | null): MenuItem[] => {
    const local = localIn ?? (remoteIn ? localOf(remoteIn) : null);
    const remote = remoteIn ?? (localIn ? remoteOf(localIn) : null);
    const canLocal = !!local && refs?.current !== local; // the checked-out branch cannot be deleted
    const gone = 'It cannot be undone from here.';
    const items: MenuItem[] = [];
    if (local && canLocal) {
      items.push({
        label: remote ? `Delete ${local} (local only)…` : `Delete branch ${local}…`,
        danger: true,
        onClick: () =>
          setConfirm({
            title: `Delete ${local}?`,
            message: `Deletes the local branch. ${remote ? `The copy on ${remote} stays.\n\n` : ''}You can undo this with Ctrl+Z.`,
            confirm: 'Delete',
            onConfirm: () => removeLocal(local, null),
          }),
      });
    }
    if (remote) {
      items.push({
        label: `Delete ${remote} (on the remote)…`,
        danger: true,
        onClick: () =>
          setConfirm({
            title: `Delete ${remote} on the remote?`,
            message: `Removes the branch from the remote for everyone who uses it. ${local ? `Your local branch "${local}" stays.\n\n` : ''}${gone}`,
            confirm: 'Delete on remote',
            onConfirm: () => removeRemote(remote),
          }),
      });
    }
    if (local && canLocal && remote) {
      items.push({
        label: `Delete ${local} and ${remote} (both)…`,
        danger: true,
        onClick: () =>
          setConfirm({
            title: `Delete ${local} everywhere?`,
            message: `Deletes the local branch, then removes it from the remote for everyone who uses it. The remote part cannot be undone from here.`,
            confirm: 'Delete both',
            onConfirm: () => removeLocal(local, remote),
          }),
      });
    }
    return items;
  };

  const stashItems = (ref: string): MenuItem[] => [
    {
      label: 'Pop stash',
      onClick: () => void act('Popping stash', () => git('stashPop', { ref }), { ok: (r) => conflictText('Applying the stash', r) ?? 'Stash applied and dropped' }),
    },
    {
      label: 'Apply stash',
      onClick: () => void act('Applying stash', () => git('stashApply', { ref }), { ok: (r) => conflictText('Applying the stash', r) ?? 'Stash applied' }),
    },
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
    // Delete: every branch on this commit, local and remote, each paired with its counterpart
    const deleteMenu: MenuItem[] = [];
    const paired = new Set<string>();
    for (const b of refs?.branches ?? []) {
      if (b.hash !== hash) continue;
      deleteMenu.push(...deleteItems(b.name, null));
      const r = remoteOf(b.name);
      if (r) paired.add(r);
    }
    for (const r of refs?.remoteBranches ?? []) {
      if (r.hash === hash && !paired.has(r.name)) deleteMenu.push(...deleteItems(null, r.name));
    }
    if (deleteMenu.length) deleteMenu.push(sep);
    const items: MenuItem[] = [
      ...branchItems,
      ...mergeItems,
      ...deleteMenu,
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
        onClick: () =>
          void act('Cherry-picking', () => git('cherryPick', { hash }), {
            ok: (r) => conflictText('Cherry-pick', r) ?? `Cherry-picked ${short}`,
            undo: { label: `Cherry-pick ${short}` },
          }),
      },
      {
        label: 'Revert commit',
        onClick: () =>
          void act('Reverting', () => git('revert', { hash }), {
            ok: (r) => conflictText('Revert', r) ?? `Reverted ${short}`,
            undo: { label: `Revert ${short}` },
          }),
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
        ...deleteItems(item.name, null),
      );
    } else if (item.kind === 'remote') {
      items.push(
        { label: 'Checkout (track)', onClick: () => checkout(item.name, 'remote') },
        { label: `Merge into ${refs?.current ?? 'current branch'}`, disabled: !refs?.current, onClick: () => merge(item.name) },
        ...deleteItems(null, item.name),
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

  /* ---------- conflicts and unfinished operations ---------- */

  const operation = status?.operation ?? null;
  const conflicted = status?.files.filter((f) => f.conflicted) ?? [];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const continueOperation = () => {
    if (!operation) return;
    const name = cap(operation.kind);
    void act('Continuing', () => git<ConflictOutcome>('operationContinue'), {
      ok: (r) => ((r as ConflictOutcome | null)?.conflicts ? 'The next step stopped on conflicts. Resolve them to carry on.' : `${name} complete`),
      undo: operation.kind === 'rebase' ? undefined : { label: name },
    });
  };
  const skipOperation = () => {
    void act('Skipping', () => git<ConflictOutcome>('operationSkip'), {
      ok: (r) => ((r as ConflictOutcome | null)?.conflicts ? 'The next step stopped on conflicts. Resolve them to carry on.' : 'Skipped'),
    });
  };
  const abortOperation = () => {
    if (!operation) return;
    setConfirm({
      title: `Abort the ${operation.kind}?`,
      message: 'Everything done so far, including the conflicts you resolved, is thrown away and the repository goes back to how it was before it started.',
      confirm: `Abort ${operation.kind}`,
      onConfirm: () => void act('Aborting', () => git('operationAbort'), { ok: `${cap(operation.kind)} aborted` }),
    });
  };
  const reopenConflict = async (path: string) => {
    const ok = await act('Reopening', () => git('conflictReopen', { file: path }), { log: false, ok: `Reopened the conflict in ${path}` });
    if (ok) setDiff({ path, conflict: true });
  };
  // after a file was resolved: carry straight on to the next conflicted file
  const afterResolved = async (path: string) => {
    const root = repoRef.current;
    if (!root) return;
    try {
      const s = await call<StatusData>('status', { repo: root });
      if (repoRef.current !== root) return;
      setStatus(s);
      const next = s.files.find((f) => f.conflicted && f.path !== path);
      setDiff(next ? { path: next.path, conflict: true } : null);
      notify(
        next
          ? `Resolved ${path}. ${s.files.filter((f) => f.conflicted).length} left.`
          : s.operation
            ? `All conflicts resolved. Press "Continue ${s.operation.kind}" to finish.`
            : 'All conflicts resolved.',
      );
    } catch (e) {
      notifyError((e as Error).message);
    }
    void reload(root).catch(() => {});
  };

  const selectedHash = sel?.kind === 'wip' ? WIP_HASH : sel ? sel.hash : null;
  const branchName = status?.branch ?? refs?.current ?? null;
  // a rebase also runs on a detached HEAD, but that is not something to "get out of"
  const detachedAt = repo && refs && refs.current === null && operation?.kind !== 'rebase' ? refs.head : null;

  /* ---------- repository tabs ---------- */

  const tabBadges = useMemo(
    () => ({ ...tabInfo, ...(repo && status ? { [repo.root]: summarize(status) } : {}) }),
    [tabInfo, repo, status],
  );

  const repoMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // the menu closes on any window click, including this one
    const r = e.currentTarget.getBoundingClientRect();
    const sep: MenuItem = { label: '', onClick: () => {}, separator: true };
    const items: MenuItem[] = [{ label: 'Open repository…', onClick: () => void openDialog() }];
    const others = recent.filter((p) => !tabs.some((t) => samePath(t.root, p)));
    if (others.length) {
      items.push(sep, { label: 'Recent', disabled: true, onClick: () => {} }, ...others.map((p) => ({ label: p, onClick: () => void openRepo(p) })));
    }
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  // An alias is only a label on the tab: the repository and its folder are not renamed.
  const setAlias = (root: string, alias: string | undefined) =>
    setTabs((list) => list.map((t) => (samePath(t.root, root) ? { ...t, alias } : t)));

  const renameTab = (root: string) => {
    const tab = tabs.find((t) => samePath(t.root, root));
    if (!tab) return;
    setPrompt({
      title: 'Rename tab',
      label: `Name to show on this tab (the repository stays "${tab.name}")`,
      value: tab.alias ?? tab.name,
      submit: 'Rename',
      onSubmit: (v) => setAlias(root, v.trim().slice(0, 60) === tab.name ? undefined : v.trim().slice(0, 60)),
    });
  };

  const tabMenu = (e: React.MouseEvent, root: string) => {
    e.preventDefault();
    const sep: MenuItem = { label: '', onClick: () => {}, separator: true };
    const at = tabs.findIndex((t) => samePath(t.root, root));
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename tab…', onClick: () => renameTab(root) },
        { label: 'Reset tab name', disabled: !tabs[at]?.alias, onClick: () => setAlias(root, undefined) },
        sep,
        { label: 'Close tab', onClick: () => closeTab(root) },
        { label: 'Close other tabs', disabled: tabs.length < 2, onClick: () => closeTabs(tabs.filter((t) => !samePath(t.root, root)).map((t) => t.root)) },
        { label: 'Close tabs to the right', disabled: at < 0 || at >= tabs.length - 1, onClick: () => closeTabs(tabs.slice(at + 1).map((t) => t.root)) },
        sep,
        { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(root) },
      ],
    });
  };

  // Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+PageDown/PageUp) cycle, Ctrl+1…9 jump, Ctrl+W closes, Ctrl+T opens
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const list = tabsRef.current;
      const here = list.findIndex((t) => !!repoRef.current && samePath(t.root, repoRef.current));
      const key = e.key.toLowerCase();
      if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
        if (list.length < 2) return;
        e.preventDefault();
        const dir = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
        void openRepo(list[(Math.max(here, 0) + dir + list.length) % list.length].root);
      } else if (key === 'w' && !e.shiftKey && here >= 0) {
        e.preventDefault();
        closeTabs([list[here].root]);
      } else if (key === 't' && !e.shiftKey) {
        e.preventDefault();
        void openDialog();
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const t = list[e.key === '9' ? list.length - 1 : Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          void openRepo(t.root);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRepo, closeTabs, openDialog]);

  const switchBranchMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // the menu closes on any window click, including this one
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = (refs?.branches ?? []).map((b) => ({ label: b.name, onClick: () => checkout(b.name, 'local') }));
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  return (
    <div className="app">
      <RepoTabs
        tabs={tabs}
        active={repo?.root ?? null}
        info={tabBadges}
        onSelect={(root) => void openRepo(root)}
        onClose={closeTab}
        onRename={renameTab}
        onAdd={() => void openDialog()}
        onMove={moveTab}
        onContext={tabMenu}
      />
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
        onOpen={repoMenu}
        account={
          repo
            ? {
                username: activeAcct?.username ?? null,
                signedIn: activeAcct?.username && accounts?.gcm.available ? isSignedIn(activeAcct.username) : undefined,
                title: activeAcct?.username
                  ? `Commits as ${activeAcct.name} <${activeAcct.email}>. Click to switch account.`
                  : 'No GitHub account is chosen for this repository. Click to choose one.',
              }
            : null
        }
        onAccount={accountMenu}
        onFetch={() => netAct('Fetching', () => git('fetch'), { ok: 'Fetched all remotes' })}
        undoLabel={undoStack.length ? undoStack[undoStack.length - 1].label : null}
        redoLabel={redoStack.length ? redoStack[redoStack.length - 1].label : null}
        onUndo={() => void stepHistory('undo')}
        onRedo={() => void stepHistory('redo')}
        onPull={() => netAct('Pulling', () => git('pull'), { ok: (r) => conflictText('Pull', r) ?? 'Pull complete', undo: { label: 'Pull' } })}
        onPush={() => netAct('Pushing', () => git('push'), { ok: 'Push complete' })}
        onBranch={() => askBranch()}
        onStash={() => {
          if (!status?.files.length) return notify('Nothing to stash', true);
          void act('Stashing', () => git('stashPush'), { ok: 'Changes stashed' });
        }}
        onPop={() => {
          if (!refs?.stashes.length) return notify('No stashes to pop', true);
          void act('Popping stash', () => git('stashPop', { ref: refs.stashes[0].ref }), {
            ok: (r) => conflictText('Applying the stash', r) ?? 'Stash applied and dropped',
          });
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

      {operation && (
        <OperationBanner
          operation={operation}
          remaining={conflicted.length}
          busy={busy !== null}
          onContinue={continueOperation}
          onSkip={skipOperation}
          onAbort={abortOperation}
        />
      )}
      {!operation && conflicted.length > 0 && (
        <div className="banner conflict" role="status">
          <Icon name="warn" size={15} />
          <span className="banner-text">
            <strong>{conflicted.length} file{conflicted.length === 1 ? ' has' : 's have'} conflicts.</strong> Resolve each one in the changes panel and stage it. If this came from a stash, it was kept: drop it when you are done.
          </span>
        </div>
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
            {diff?.conflict ? (
              <ConflictView
                repo={repo.root}
                path={diff.path}
                onClose={() => setDiff(null)}
                onResolved={(p) => void afterResolved(p)}
                onError={notifyError}
              />
            ) : diff ? (
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
          <aside className="right" tabIndex={-1}>
            {sel?.kind === 'wip' && status ? (
              <StagingPanel
                files={status.files}
                branch={branchName}
                author={activeAcct?.name ? `${activeAcct.name} <${activeAcct.email}>` : undefined}
                busy={busy !== null}
                active={diff}
                resolved={status.resolved}
                onReopen={(p) => void reopenConflict(p)}
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
      {acctDialog && accounts && (
        <AccountsDialog
          data={accounts}
          active={activeAcct}
          busy={acctBusy}
          onSave={saveAccount}
          onRemove={(u) => void removeAccount(u)}
          onUse={(u, scope) => void switchAccount(u, scope)}
          onSignIn={(u) => void signIn(u)}
          onSignOut={(u) => void signOut(u)}
          onClose={() => setAcctDialog(false)}
        />
      )}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
