import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, installUpdate, isElectron, onRepoChanged, pickFolder, watchRepos } from './api';
import { ConflictView } from './components/ConflictView';
import { DetachedBanner } from './components/DetachedBanner';
import { OperationBanner } from './components/OperationBanner';
import { RepoTabs, type RepoTab, type TabInfo } from './components/RepoTabs';
import { DiffView } from './components/DiffView';
import { GraphView } from './components/GraphView';
import { Splitter } from './components/Splitter';
import { AccountsDialog } from './components/AccountsDialog';
import { EditMessageDialog, type EditMessageSpec } from './components/EditMessageDialog';
import { ConfirmDialog, ContextMenu, PromptDialog, type ConfirmSpec, type MenuItem, type PromptSpec } from './components/Overlays';
import { CommitPanel, StagingPanel } from './components/RightPanel';
import { Sidebar, type SidebarItem } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { basename, parseTrack, samePath } from './util';
import { createPrUrl, isSafePrUrl, mergedPrNumber, publishedName, pullRequestUrl } from './pullRequests';
import { forcePushNotice, forcePushText } from './forcePush';
import { checkoutTargets, resetPrompt } from './remoteCheckout';
import { DEFAULT_REFS_W, MAIN_COLOR_BY_GROUP, WIP_HASH, computeGraph, findMainLines, pinWithWip } from './graph';
import { PictureSourcesProvider } from './components/AuthorPicture';
import { SettingsDialog } from './components/SettingsDialog';
import type { PictureSources } from './avatars';
import { UpdateDialog } from './components/UpdateDialog';
import { branchGroup, branchMatcher } from './refLabels';
import { readSettings, writeSettings, type Settings } from './settings';
import { Icon } from './icons';
import type {
  AccountProfile,
  AccountsData,
  ActiveAccount,
  Commit,
  CommitEditInfo,
  ConflictOutcome,
  DiffTarget,
  EditableCommits,
  ForcePushInfo,
  PullRequest,
  PullRequestInfo,
  RefsData,
  RemoteCheckoutInfo,
  RemoteWeb,
  RepoSnapshot,
  RewordResult,
  Selection,
  StatusData,
  StatusFile,
  UndoOp,
  UpdateInfo,
} from './types';

const LAST_REPO_KEY = 'gitgui.lastRepo';
const RECENT_KEY = 'gitgui.recent';
const TABS_KEY = 'gitgui.tabs';
const PAGE = 1000;
const MAX_HISTORY = 50;

const NO_HASHES = new Set<string>();

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
  const [editable, setEditable] = useState<Set<string>>(NO_HASHES); // unpushed commits whose message can be edited
  const [editMsg, setEditMsg] = useState<EditMessageSpec | null>(null);
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
  const [prInfo, setPrInfo] = useState<PullRequestInfo | null>(null);
  const [web, setWeb] = useState<RemoteWeb | null>(null); // the remote's pages, for a merge commit's pull request shortcut
  const lastPr = useRef({ root: '', at: 0, authenticated: false });
  const [acctDialog, setAcctDialog] = useState(false);
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => writeSettings(settings), [settings]);
  const changeSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  // which profile picture sources are on; the saved accounts let a user's own commits show their picture
  const pictureAccounts = accounts?.profiles;
  const pictureSources = useMemo<PictureSources>(
    () => ({ github: settings.profilePictures, gravatar: settings.gravatarLookups, accounts: pictureAccounts ?? [] }),
    [settings.profilePictures, settings.gravatarLookups, pictureAccounts],
  );
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

  /* ---------- updates: a newer build of the app in a local folder ---------- */

  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // At start-up (manual = false) this says nothing unless a newer version that was not skipped is waiting.
  const checkForUpdate = useCallback(
    async (manual: boolean) => {
      setCheckingUpdate(true);
      try {
        const info = await call<UpdateInfo>('checkUpdate', { folder: settingsRef.current.updateFolder });
        setUpdate(info);
        if (info.available && (manual || info.latest !== settingsRef.current.skippedUpdate)) setUpdatePrompt(true);
      } catch (e) {
        if (manual) notifyError(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setCheckingUpdate(false);
      }
    },
    [notifyError],
  );
  useEffect(() => {
    if (settingsRef.current.updateCheck) void checkForUpdate(false);
  }, [checkForUpdate]);

  const skipUpdate = useCallback(() => {
    setUpdatePrompt(false);
    if (!update?.latest) return;
    changeSettings({ skippedUpdate: update.latest });
    notify(`Version ${update.latest} will not be offered again at start-up. Settings → Updates still finds it.`);
  }, [update, changeSettings, notify]);

  /* ---------- loading ---------- */

  const reload = useCallback(async (root: string, forceLog = false) => {
    const [r, s] = await Promise.all([call<RefsData>('refs', { repo: root }), call<StatusData>('status', { repo: root })]);
    if (repoRef.current !== root) return;
    const key = JSON.stringify([r.head, r.branches, r.remoteBranches, r.tags]);
    setRefs(r);
    setStatus(s);
    if (forceLog || key !== refsKey.current) {
      refsKey.current = key;
      const [log, ed] = await Promise.all([
        call<Commit[]>('log', { repo: root, limit: limitRef.current }),
        // which commits can have their message edited; the app works without this if it fails
        call<EditableCommits>('editableCommits', { repo: root }).catch(() => null),
      ]);
      if (repoRef.current === root) {
        setCommits(log);
        setEditable(ed && ed.hashes.length ? new Set(ed.hashes) : NO_HASHES);
      }
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

  // Open pull requests of the repository's GitHub / Azure DevOps remote, for the badges. Asking often
  // is cheap with a login (5000 requests an hour) but not without one (60), so wait longer then.
  const loadPrs = useCallback(async (root: string, force = false) => {
    if (!settingsRef.current.prLookups) return;
    const last = lastPr.current;
    const wait = last.authenticated ? 20_000 : 120_000;
    if (!force && last.root === root && Date.now() - last.at < wait) return;
    lastPr.current = { root, at: Date.now(), authenticated: last.root === root && last.authenticated };
    try {
      const info = await call<PullRequestInfo>('pullRequests', { repo: root });
      lastPr.current.authenticated = !!info.authenticated;
      if (repoRef.current === root) setPrInfo(info);
    } catch {
      /* no badges; everything else works without them */
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
        setPrInfo(null);
        setWeb(null);
        void loadActive(info.root);
        setRefs(null);
        setStatus(null);
        setCommits([]);
        setEditable(NO_HASHES);
        setEditMsg(null);
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
      setEditable(NO_HASHES);
      setEditMsg(null);
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
      void loadPrs(root);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload, loadActive, refreshTabs, loadPrs]);

  // The desktop app watches every open tab's folder and says when one changed on disk (a terminal, an editor,
  // another tool), so the window stays current even while it is in the background.
  const watchKey = JSON.stringify([...tabs.map((t) => t.root), repo?.root ?? ''].filter(Boolean));
  useEffect(() => watchRepos(JSON.parse(watchKey) as string[]), [watchKey]);

  const watchRun = useRef<{ running: boolean; again: Set<string> }>({ running: false, again: new Set() });
  useEffect(() => {
    const refresh = async (root: string) => {
      const active = repoRef.current;
      if (active && samePath(root, active)) {
        // an operation of the app's own is running and reloads when it is done, which covers this change
        if (busyRef.current) return;
        // refs and status only: which account is active comes from git config and the remotes, which a changed file
        // cannot alter (the focus refresh still re-reads it)
        await reload(active).catch(() => {});
      } else if (tabsRef.current.some((t) => samePath(t.root, root))) {
        let info: TabInfo;
        try {
          info = summarize(await call<StatusData>('status', { repo: root }));
        } catch {
          info = { branch: null, changes: 0, conflicts: 0, missing: true };
        }
        setTabInfo((prev) => ({ ...prev, [root]: info }));
      }
    };
    // one refresh at a time: changes that arrive meanwhile are read once it finishes
    const onChanged = async (root: string) => {
      const run = watchRun.current;
      run.again.add(root);
      if (run.running) return;
      run.running = true;
      try {
        while (run.again.size) {
          const next = [...run.again];
          run.again.clear();
          for (const r of next) await refresh(r);
        }
      } finally {
        run.running = false;
      }
    };
    return onRepoChanged((root) => void onChanged(root));
  }, [reload]);

  // turning the pull request lookups off clears the badges; turning them on fetches them
  useEffect(() => {
    if (!settings.prLookups) setPrInfo(null);
    else if (repoRef.current) void loadPrs(repoRef.current, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.prLookups]);

  // Ctrl+, opens the settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // where the remote's pages live: from its address alone, so it is cheap and needs no login or lookups setting
  const remotesKey = (refs?.remotes ?? []).join('|');
  useEffect(() => {
    const root = repo?.root;
    if (!root || !refs) return;
    let live = true;
    call<RemoteWeb>('remoteWeb', { repo: root })
      .then((w) => live && repoRef.current === root && setWeb(w))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.root, !!refs, remotesKey]);

  // (re)load pull requests when a repository has been read, and when its set of remote branches changes
  const remoteKey = (refs?.remoteBranches ?? []).map((r) => r.name).join('|');
  useEffect(() => {
    if (repo && refs) void loadPrs(repo.root, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.root, remoteKey, loadPrs]);

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
        undo?: { label: string; mode?: 'soft' | 'keep'; remap?: () => Record<string, string> | undefined };
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
            const op: UndoOp = { label: undo.label, before, after, mode: undo.mode ?? 'keep', remap: undo.remap?.() };
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
        if (op.remap) {
          // commits that were rebuilt have other ids now: keep the selection on the same commit
          const to = dir === 'undo' ? Object.fromEntries(Object.entries(op.remap).map(([from, now]) => [now, from])) : op.remap;
          setSel((s) => (s?.kind === 'commit' && to[s.hash] ? { kind: 'commit', hash: to[s.hash] } : s));
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

  const removeAccount = (username: string) =>
    setConfirm({
      title: `Remove ${username}?`,
      message: 'It is only removed from this list. It does not sign you out of GitHub or change any repository.',
      confirm: 'Remove',
      onConfirm: () =>
        void (async () => {
          try {
            await call('accountRemove', { username });
            await loadAccounts();
          } catch (e) {
            notifyError((e as Error).message);
          }
        })(),
    });

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
  const netAct = (label: string, fn: () => Promise<unknown>, opts: ActOpts = {}): Promise<boolean> =>
    act(label, fn, {
      ...opts,
      onError: (msg) => {
        if (!msg.startsWith('AUTH:')) return opts?.onError?.(msg) ?? false;
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

  // Replacing the remote's copy of the checked-out branch (after a rebase, an amend or an edited message). First the
  // remote is looked at and the commits it would lose are shown; the push itself is pinned to the commit that was
  // shown, so it only goes through if nobody has pushed since.
  const startForcePush = () =>
    netAct('Checking the remote', async () => {
      const info = await git<ForcePushInfo>('forcePushInfo');
      const notice = forcePushNotice(info);
      if (notice) return notify(notice);
      setConfirm({
        ...forcePushText(info, branchMatcher(settingsRef.current.mainBranches)(info.branch)),
        danger: true,
        onConfirm: () =>
          void netAct('Force pushing', () => git('forcePush', { head: info.head, expect: info.remoteTip }), {
            ok: `Replaced ${info.remote}/${info.branch} with your branch`,
          }),
      });
    });

  // A normal push. When the remote turns it away because it has commits this branch lacks (the branch was rewritten),
  // the force push check opens instead of an error.
  const pushNow = () => {
    let rejected = false;
    void netAct('Pushing', () => git<{ published?: string }>('push'), {
      ok: (r) => ((r as { published?: string } | null)?.published ? `Pushed as the new branch ${(r as { published: string }).published}, which this branch now tracks` : 'Push complete'),
      onError: (msg) => (rejected = msg.startsWith('REJECTED:')),
    }).then(() => rejected && startForcePush());
  };

  const accountMenu =(e: React.MouseEvent<HTMLButtonElement>) => {
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
  //
  // A remote branch whose local branch of the same name is somewhere else is first asked about: checking the local
  // branch out as it is (what git does) leaves you away from the remote commit, so the choice is to reset it there.
  const doCheckout = (ref: string, kind: 'local' | 'remote' | 'commit', reset = false) => {
    const run = (stashFirst: boolean) =>
      act(
        stashFirst ? 'Stashing and checking out' : reset ? 'Resetting and checking out' : 'Checking out',
        async () => {
          if (stashFirst) await git('stashPush', { message: `Auto-stash before checkout of ${ref}` });
          await git('checkout', { ref, kind, reset });
        },
        {
          ok: stashFirst ? `Stashed your changes and checked out ${ref}` : reset ? `Reset ${ref.slice(ref.indexOf('/') + 1)} to ${ref} and checked it out` : `Checked out ${ref}`,
          undo: { label: reset ? `Reset ${ref.slice(ref.indexOf('/') + 1)} to ${ref}` : `Checkout ${ref}` },
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
  const checkout = (ref: string, kind: 'local' | 'remote' | 'commit') => {
    if (kind !== 'remote') return doCheckout(ref, kind);
    void (async () => {
      let info: RemoteCheckoutInfo;
      try {
        info = await git<RemoteCheckoutInfo>('remoteCheckoutInfo', { ref });
      } catch (e) {
        return notifyError((e as Error).message);
      }
      const ask = resetPrompt(info);
      if (!ask) return doCheckout(ref, kind); // no local branch yet, or it is already there
      setConfirm({
        title: ask.title,
        message: ask.message,
        confirm: ask.confirm,
        danger: ask.danger,
        alt: ask.keep ? { label: ask.keep, onClick: () => doCheckout(ref, kind) } : undefined,
        onConfirm: () => doCheckout(ref, kind, true),
      });
    })();
  };

  // Branches that can be checked out from a commit: local branches pointing at it, and remote branches pointing at it
  // (a new local branch, or the local one of the same name reset to here).
  const branchesAt = (hash: string) => checkoutTargets(refs?.branches ?? [], refs?.remoteBranches ?? [], hash);

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

  /* ---------- pull requests ---------- */

  // Open pull requests by the names the graph and sidebar use: a local branch name, or `origin/name`.
  // A local branch is matched by the name it is published under, and pull requests from forks are left out
  // because their branch names are not this repository's.
  const prLabels = useMemo(() => {
    const out: Record<string, PullRequest> = {};
    if (!prInfo?.prs.length) return out;
    const byBranch = new Map(prInfo.prs.filter((p) => !p.fork).map((p) => [p.branch, p]));
    for (const b of refs?.branches ?? []) {
      const pr = byBranch.get(publishedName(b.name, b.upstream));
      if (pr) out[b.name] = pr;
    }
    for (const r of refs?.remoteBranches ?? []) {
      if (prInfo.remote && r.remote !== prInfo.remote) continue;
      const pr = byBranch.get(r.name.slice(r.name.indexOf('/') + 1));
      if (pr) out[r.name] = pr;
    }
    return out;
  }, [prInfo, refs]);

  const openUrl = (url: string) => {
    if (!isSafePrUrl(url)) return notifyError('That address is not on GitHub or Azure DevOps, so it was not opened.');
    window.open(url, '_blank', 'noopener,noreferrer'); // Electron hands this to the user's browser
  };
  const openPr = (pr: PullRequest) => openUrl(pr.url);

  // The pull request a commit was merged by ("Merge pull request #6 from…", "Title (#6)", "Merged PR 6: …"), with its page.
  const mergedPrOf = (hash: string | undefined): { number: number; url: string } | null => {
    const host = prInfo?.provider ? prInfo : web;
    if (!hash || !host?.provider) return null;
    const number = mergedPrNumber(commits.find((c) => c.hash === hash)?.subject, host.provider);
    const url = number ? pullRequestUrl(host, number) : null;
    return number && url ? { number, url } : null;
  };

  // "Open pull request #N" for a branch that has one, or "Create pull request" for a pushed branch that has none.
  const prItems = (localIn: string | null, remoteIn: string | null): MenuItem[] => {
    if (!prInfo?.provider) return [];
    const local = localIn ?? (remoteIn ? localOf(remoteIn) : null);
    const remote = remoteIn ?? (localIn ? remoteOf(localIn) : null);
    const pr = (local && prLabels[local]) || (remote && prLabels[remote]) || null;
    if (pr) return [{ label: `Open pull request #${pr.number}${pr.draft ? ' (draft)' : ''}…`, onClick: () => openPr(pr) }];
    const url = remote ? createPrUrl(prInfo, remote.slice(remote.indexOf('/') + 1)) : null;
    const name = local ?? (remote ? remote.slice(remote.indexOf('/') + 1) : null);
    return url && name && !/^(main|master)$/.test(name) ? [{ label: `Create pull request for ${name}…`, onClick: () => openUrl(url) }] : [];
  };

  // "Force push": for a local branch that has a copy on the remote. It works on the checked-out branch, like Push.
  const pushItems = (local: string): MenuItem[] => {
    if (!remoteOf(local)) return [];
    const current = refs?.current === local;
    return [
      {
        label: `Force push ${local}…`,
        danger: true,
        disabled: !current,
        title: current
          ? 'Replace the remote copy with this branch after a rebase, amend or edited message. It shows what would be lost and asks first.'
          : 'Check this branch out first: pushing works on the checked-out branch',
        onClick: () => void startForcePush(),
      },
    ];
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
      onClick: () =>
        setConfirm({
          title: 'Drop this stash?',
          message: 'The stashed changes are deleted. This cannot be undone.',
          confirm: 'Drop stash',
          danger: true,
          onConfirm: () => void act('Dropping stash', () => git('stashDrop', { ref })),
        }),
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

  // Which branches count as "main", and which commits are on their first-parent lines.
  const isMain = useMemo(() => branchMatcher(settings.mainBranches), [settings.mainBranches]);
  const usesMainLines =
    settings.laneBold || settings.lanePin || settings.laneBand || settings.boldMessages || settings.fixedColors || settings.laneChips;
  const mainLines = useMemo(() => {
    if (!usesMainLines || !refs) return null;
    const short = (n: string) => n.slice(n.indexOf('/') + 1);
    const tips = [
      ...refs.branches.filter((b) => isMain(b.name)).map((b) => ({ name: b.name, hash: b.hash })),
      ...refs.remoteBranches.filter((r) => isMain(short(r.name))).map((r) => ({ name: short(r.name), hash: r.hash })),
    ];
    return findMainLines(commits, tips);
  }, [usesMainLines, refs, commits, isMain]);

  const graph = useMemo(() => {
    const list = [...withStashes];
    const hasWip = !!status && status.files.length > 0;
    if (hasWip) {
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
    return computeGraph(list, {
      main: mainLines?.main,
      pin: settings.lanePin && mainLines && mainLines.primary.size > 0 ? pinWithWip(mainLines.primary, hasWip ? refs?.head : null) : undefined,
      fixedColors: settings.fixedColors ? (name) => MAIN_COLOR_BY_GROUP[branchGroup(name)] : undefined,
      remotes: refs?.remotes,
    });
  }, [withStashes, status, refs?.head, refs?.remotes, mainLines, settings.lanePin, settings.fixedColors]);

  const look = useMemo(
    () => ({ bold: settings.laneBold, band: settings.laneBand, boldMessages: settings.boldMessages, chips: settings.laneChips }),
    [settings.laneBold, settings.laneBand, settings.boldMessages, settings.laneChips],
  );

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

  /* ---------- editing a commit's message ---------- */

  // null when the message of this commit can be edited, otherwise why not (shown as a tooltip)
  const editBlocked = (hash: string): string | null =>
    operation
      ? `Finish or abort the ${operation.kind} first`
      : editable.has(hash)
        ? null
        : 'Only commits that have not been pushed, and are on the checked-out branch only, can be edited';

  const openEditMessage = async (hash: string) => {
    if (busyRef.current) return;
    setBusy('Reading commit');
    try {
      const info = await git<CommitEditInfo>('commitEditInfo', { hash });
      setEditMsg({ ...info, hash });
    } catch (e) {
      notifyError((e as Error).message); // the backend says exactly why, e.g. which remote already has the commit
    } finally {
      setBusy(null);
    }
  };

  const saveMessage = async (hash: string, summary: string, description: string) => {
    let result: RewordResult | null = null;
    const ok = await act(
      'Editing message',
      async () => (result = await git<RewordResult>('rewordCommit', { hash, summary, description })),
      { ok: 'Commit message updated', undo: { label: 'Edit commit message', mode: 'keep', remap: () => (result as RewordResult | null)?.map } },
    );
    const made = result as RewordResult | null;
    if (!ok || !made) return;
    // the commit and the ones after it have new ids: keep the selection on the same commit
    const current = selRef.current;
    if (current?.kind === 'commit' && made.map[current.hash]) {
      const next = made.map[current.hash];
      setSel({ kind: 'commit', hash: next });
      if (current.hash === hash) focusHash(next);
    }
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
    // pull requests of the branches here, written next to the branch operations
    const prMenu: MenuItem[] = [];
    const merged = mergedPrOf(hash); // and the one this commit was merged by
    if (merged) prMenu.push({ label: `Open pull request #${merged.number}…`, title: 'The pull request this commit was merged by', onClick: () => openUrl(merged.url) });
    const seenRemote = new Set<string>();
    for (const b of refs?.branches ?? []) {
      if (b.hash !== hash) continue;
      prMenu.push(...prItems(b.name, null), ...pushItems(b.name));
      const r = remoteOf(b.name);
      if (r) seenRemote.add(r);
    }
    for (const r of refs?.remoteBranches ?? []) {
      if (r.hash === hash && !seenRemote.has(r.name)) prMenu.push(...prItems(null, r.name));
    }
    if (prMenu.length) prMenu.push(sep);
    if (deleteMenu.length) deleteMenu.push(sep);
    const items: MenuItem[] = [
      ...branchItems,
      ...mergeItems,
      ...prMenu,
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
        label: 'Edit commit message…',
        disabled: editBlocked(hash) !== null,
        title: editBlocked(hash) ?? undefined,
        onClick: () => void openEditMessage(hash),
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
        onClick: () =>
          setConfirm({
            title: `Hard reset to ${short}?`,
            message: 'The current branch moves to this commit and uncommitted changes are lost. You can undo the move with Ctrl+Z, but not the lost changes.',
            confirm: 'Hard reset',
            danger: true,
            onConfirm: () => void act('Resetting', () => git('reset', { hash, mode: 'hard' }), { undo: { label: `Hard reset to ${short}` } }),
          }),
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
        ...prItems(item.name, null),
        ...pushItems(item.name),
        ...deleteItems(item.name, null),
      );
    } else if (item.kind === 'remote') {
      items.push(
        { label: 'Checkout (track)', onClick: () => checkout(item.name, 'remote') },
        { label: `Merge into ${refs?.current ?? 'current branch'}`, disabled: !refs?.current, onClick: () => merge(item.name) },
        ...prItems(null, item.name),
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
    setConfirm({
      title: f.untracked ? 'Delete this file?' : 'Discard changes to this file?',
      message: f.untracked ? 'The untracked file will be deleted. This cannot be undone.' : 'All unstaged changes to the file will be thrown away. This cannot be undone.',
      detail: f.path,
      danger: true,
      confirm: f.untracked ? 'Delete file' : 'Discard changes',
      onConfirm: () => void act('Discarding', () => git('discard', { files: [f.path], untracked: f.untracked }), { log: false }),
    });
  };

  const discardAll = () => {
    const unstaged = (status?.files ?? []).filter((f) => !f.conflicted && f.worktree !== '.');
    const untracked = unstaged.filter((f) => f.untracked).length;
    const modified = unstaged.length - untracked;
    if (unstaged.length === 0) return;
    const lines = [
      modified > 0 ? `• ${modified} changed file${modified === 1 ? '' : 's'} ${modified === 1 ? 'goes' : 'go'} back to how ${modified === 1 ? 'it is' : 'they are'} staged or committed` : '',
      untracked > 0 ? `• ${untracked} untracked file${untracked === 1 ? ' is' : 's are'} deleted` : '',
    ].filter(Boolean);
    setConfirm({
      title: 'Discard all unstaged changes?',
      message: `${lines.join('\n')}\n\nStaged changes are kept. This cannot be undone.`,
      confirm: 'Discard all',
      danger: true,
      onConfirm: () => void act('Discarding', () => git('discardAll'), { ok: 'Discarded all unstaged changes', log: false }),
    });
  };

  // Right-click on an unstaged file.
  const unstagedMenu = (e: React.MouseEvent, f: StatusFile) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Stage file', onClick: () => void act('Staging', () => git('stage', { files: [f.path] }), { log: false }) },
        { label: f.untracked ? 'Delete file…' : 'Discard changes…', danger: true, onClick: () => discard(f) },
        { label: '', onClick: () => {}, separator: true },
        { label: 'Copy file path', onClick: () => void navigator.clipboard.writeText(f.path) },
      ],
    });
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

  // The toolbar shortcut: this branch's pull request, or "Create PR" when it is pushed without one,
  // or the repository's pull request list otherwise. Hidden for hosts other than GitHub / Azure DevOps.
  const toolbarPr = (() => {
    if (!prInfo?.provider) return null;
    const current = branchName ? prLabels[branchName] : undefined;
    if (current) {
      return { label: `PR #${current.number}`, has: true, title: `Open pull request #${current.number}: ${current.title}`, onClick: () => openPr(current) };
    }
    const published = branchName ? remoteOf(branchName) : null;
    const createUrl = published ? createPrUrl(prInfo, published.slice(published.indexOf('/') + 1)) : null;
    if (createUrl && branchName && !/^(main|master)$/.test(branchName)) {
      return { label: 'Create PR', has: false, title: `Open a new pull request for ${branchName}`, onClick: () => openUrl(createUrl) };
    }
    const list = prInfo.listUrl;
    return {
      label: 'PRs',
      has: false,
      title: prInfo.error ? `Open the pull request list. Could not check for open pull requests: ${prInfo.error}` : 'Open the repository’s pull requests',
      onClick: () => list && openUrl(list),
    };
  })();

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
    <PictureSourcesProvider value={pictureSources}>
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
        onSettings={() => setSettingsOpen(true)}
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
        onFetch={() =>
          netAct('Fetching', () => git('fetch'), {
            ok: () => {
              if (repoRef.current) void loadPrs(repoRef.current, true); // fetching is also the "refresh" button for pull requests
              return 'Fetched all remotes';
            },
          })
        }
        undoLabel={undoStack.length ? undoStack[undoStack.length - 1].label : null}
        redoLabel={redoStack.length ? redoStack[redoStack.length - 1].label : null}
        onUndo={() => void stepHistory('undo')}
        onRedo={() => void stepHistory('redo')}
        onPull={() => netAct('Pulling', () => git('pull'), { ok: (r) => conflictText('Pull', r) ?? 'Pull complete', undo: { label: 'Pull' } })}
        onPush={pushNow}
        onBranch={() => askBranch()}
        onStash={() => {
          if (!status?.files.length) return notify('Nothing to stash', true);
          void act('Stashing', () => git('stashPush'), { ok: 'Changes stashed' });
        }}
        pr={toolbarPr}
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
          <Sidebar refs={refs} prs={prLabels} onOpenPr={openPr} onFocus={onSidebarFocus} onActivate={onSidebarActivate} onContext={sidebarMenu} />
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
                look={look}
                isMain={isMain}
                remotes={refs?.remotes ?? []}
                selected={selectedHash}
                matches={matchSet}
                focus={focus}
                hasMore={commits.length >= limit}
                refsW={refsW}
                onRefsW={setRefsW}
                tracks={tracks}
                prs={prLabels}
                onOpenPr={openPr}
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
                onDiscardAll={discardAll}
                onUnstagedMenu={unstagedMenu}
                onCommit={(message, amend) =>
                  act('Committing', () => git('commit', { message, amend }), {
                    ok: amend ? 'Commit amended' : 'Commit created',
                    undo: { label: amend ? 'Amend commit' : 'Commit', mode: 'soft' },
                  })
                }
              />
            ) : sel && sel.kind !== 'wip' ? (
              <CommitPanel
                key={sel.hash}
                repo={repo.root}
                hash={sel.hash}
                active={diff}
                onOpen={setDiff}
                onError={notifyError}
                onEdit={sel.kind === 'commit' ? () => void openEditMessage(sel.hash) : undefined}
                editBlocked={editBlocked(sel.hash)}
                pr={sel.kind === 'commit' ? mergedPrOf(sel.hash) : null}
                onOpenPr={openUrl}
              />
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
      {editMsg && (
        <EditMessageDialog
          spec={editMsg}
          onClose={() => setEditMsg(null)}
          onSave={(summary, description) => void saveMessage(editMsg.hash, summary, description)}
        />
      )}
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
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
          update={update}
          checkingUpdate={checkingUpdate}
          onCheckUpdate={() => void checkForUpdate(true)}
        />
      )}
      {updatePrompt && update?.available && update.latest && (
        <UpdateDialog
          info={update}
          onInstall={() => installUpdate(update.folder ?? '', update.latest!)}
          onLater={() => setUpdatePrompt(false)}
          onSkip={skipUpdate}
        />
      )}
      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />}
    </div>
    </PictureSourcesProvider>
  );
}
