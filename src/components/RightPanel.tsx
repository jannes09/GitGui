import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { Icon } from '../icons';
import type { CommitDetail, CommitFile, DiffTarget, StatusFile } from '../types';
import { basename, dirname, fullDate, initials, shortHash } from '../util';

const STATUS_CLASS: Record<string, string> = { A: 'add', '?': 'add', M: 'mod', D: 'del', R: 'ren', C: 'ren', U: 'del', T: 'mod' };

function Badge({ code }: { code: string }) {
  const label = code === '?' ? 'A' : code;
  return <span className={'badge ' + (STATUS_CLASS[code] ?? 'mod')}>{label}</span>;
}

function FileName({ path }: { path: string }) {
  return (
    <span className="f-name" title={path}>
      <span className="f-base">{basename(path)}</span>
      <span className="f-dir">{dirname(path)}</span>
    </span>
  );
}

/** A commit's description, limited to a few lines until the user asks for all of it. */
function CommitBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!open) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure); // the panel can be resized, which changes the wrapping
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);

  return (
    <div className="cd-body-wrap">
      <pre ref={ref} className={'cd-body' + (open ? ' open' : overflows ? ' clipped' : '')}>
        {text}
      </pre>
      {(overflows || open) && (
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function sameTarget(a: DiffTarget, b: DiffTarget): boolean {
  return a.path === b.path && !!a.staged === !!b.staged && !!a.conflict === !!b.conflict && a.hash === b.hash;
}

/** What git's two-letter conflict code means, in words. */
const CONFLICT_KIND: Record<string, string> = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  DU: 'deleted by us',
  UD: 'deleted by them',
  AU: 'added by us',
  UA: 'added by them',
};

/**
 * Up/Down arrows move through the listed files and open each one's diff.
 * Listens on the window so it works wherever focus is, except in text fields,
 * menus and dialogs.
 */
function useFileNav(targets: DiffTarget[], active: DiffTarget | null, open: (t: DiffTarget) => void) {
  const latest = useRef({ targets, active, open });
  latest.current = { targets, active, open };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      // only while the file panel has focus; the graph uses the arrows when it has focus
      if (!el?.closest('.right') || el.closest('input, textarea, select, [contenteditable="true"], .ctx-menu, .modal')) return;
      const { targets: list, active: current, open: openFile } = latest.current;
      if (list.length === 0) return;
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const at = current ? list.findIndex((t) => sameTarget(t, current)) : -1;
      const next = at < 0 ? (dir === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + dir));
      if (next !== at) openFile(list[next]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // keep the active row visible while arrowing through a long list
  useEffect(() => {
    document.querySelector('.f-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
}

/* ---------- selected commit ---------- */

interface CommitPanelProps {
  repo: string;
  hash: string;
  active: DiffTarget | null;
  onOpen: (t: DiffTarget) => void;
  onError: (msg: string) => void;
}

export function CommitPanel({ repo, hash, active, onOpen, onError }: CommitPanelProps) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [files, setFiles] = useState<CommitFile[]>([]);

  const targets = useMemo(() => files.map((f): DiffTarget => ({ path: f.path, hash })), [files, hash]);
  useFileNav(targets, active, onOpen);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setFiles([]);
    Promise.all([call<CommitDetail>('commitDetail', { repo, hash }), call<CommitFile[]>('commitFiles', { repo, hash })])
      .then(([d, f]) => {
        if (!live) return;
        setDetail(d);
        setFiles(f);
      })
      .catch((e: Error) => live && onError(e.message));
    return () => {
      live = false;
    };
  }, [repo, hash, onError]);

  if (!detail) return <div className="rp-empty">Loading…</div>;
  const [subject, ...rest] = detail.message.split('\n');
  const body = rest.join('\n').trim();

  return (
    <div className="rp">
      <div className="rp-scroll">
        <div className="cd-subject">{subject}</div>
        {body && <CommitBody text={body} />}
        <div className="cd-meta">
          <div className="avatar">{initials(detail.author)}</div>
          <div>
            <div className="cd-author">{detail.author}</div>
            <div className="cd-date">{fullDate(detail.date)}</div>
          </div>
        </div>
        <div className="cd-hashes">
          <span>commit</span>
          <code>{shortHash(detail.hash)}</code>
          {detail.parents.map((p) => (
            <span key={p}>
              <span className="dim">parent</span> <code>{shortHash(p)}</code>
            </span>
          ))}
        </div>
        <div className="rp-section">
          <span>{files.length} changed file{files.length === 1 ? '' : 's'}</span>
        </div>
        {files.map((f) => (
          <div
            key={f.path}
            className={'f-row' + (active && sameTarget(active, { path: f.path, hash }) ? ' active' : '')}
            onClick={() => onOpen({ path: f.path, hash })}
          >
            <Badge code={f.status} />
            <FileName path={f.path} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- working directory ---------- */

interface StagingProps {
  files: StatusFile[];
  branch: string | null;
  busy: boolean;
  active: DiffTarget | null;
  /** who commits will be made as, e.g. "Name <email>" */
  author?: string;
  /** files whose conflict was resolved during the current operation (they can be reopened) */
  resolved: string[];
  onReopen: (path: string) => void;
  onOpen: (t: DiffTarget) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscard: (f: StatusFile) => void;
  onCommit: (message: string, amend: boolean) => Promise<boolean>;
}

export function StagingPanel(p: StagingProps) {
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [amend, setAmend] = useState(false);

  const conflicts = useMemo(() => p.files.filter((f) => f.conflicted), [p.files]);
  const staged = useMemo(() => p.files.filter((f) => f.index !== '.' && f.index !== '?' && !f.conflicted), [p.files]);
  const unstaged = useMemo(() => p.files.filter((f) => f.worktree !== '.' && !f.conflicted), [p.files]);

  // arrow-key order matches what is on screen: conflicts, then unstaged files, then staged
  const targets = useMemo(
    () => [
      ...conflicts.map((f): DiffTarget => ({ path: f.path, conflict: true })),
      ...unstaged.map((f): DiffTarget => ({ path: f.path, untracked: f.untracked })),
      ...staged.map((f): DiffTarget => ({ path: f.path, staged: true })),
    ],
    [conflicts, unstaged, staged],
  );
  useFileNav(targets, p.active, p.onOpen);
  const isActive = (t: DiffTarget) => !!p.active && sameTarget(p.active, t);

  const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
  const canCommit = !p.busy && conflicts.length === 0 && (staged.length > 0 || amend) && (summary.trim().length > 0 || amend);

  const commit = async () => {
    if (await p.onCommit(message, amend)) {
      setSummary('');
      setDescription('');
      setAmend(false);
    }
  };

  return (
    <div className="rp">
      <div className="rp-scroll">
        {conflicts.length > 0 && (
          <>
            <div className="rp-section conflict">
              <span>Conflicts ({conflicts.length})</span>
            </div>
            {conflicts.map((f) => (
              <div
                key={'c' + f.path}
                className={'f-row' + (isActive({ path: f.path, conflict: true }) ? ' active' : '')}
                onClick={() => p.onOpen({ path: f.path, conflict: true })}
                title="Click to resolve"
              >
                <span className="badge conflict">!</span>
                <FileName path={f.path} />
                <span className="f-note">{CONFLICT_KIND[f.index + f.worktree] ?? 'conflict'}</span>
              </div>
            ))}
          </>
        )}
        <div className="rp-section">
          <span>Unstaged files ({unstaged.length})</span>
          {unstaged.length > 0 && (
            <button className="btn small" onClick={p.onStageAll} disabled={p.busy}>
              Stage all changes
            </button>
          )}
        </div>
        {unstaged.length === 0 && <div className="rp-none">Working tree clean</div>}
        {unstaged.map((f) => (
          <div
            key={'u' + f.path}
            className={'f-row' + (isActive({ path: f.path }) ? ' active' : '')}
            onClick={() => p.onOpen({ path: f.path, untracked: f.untracked })}
          >
            <Badge code={f.worktree} />
            <FileName path={f.path} />
            <span className="f-actions">
              <button className="icon-btn" title={f.untracked ? 'Delete file' : 'Discard changes'} onClick={(e) => { e.stopPropagation(); p.onDiscard(f); }}>
                <Icon name="undo" size={13} />
              </button>
              <button className="icon-btn" title="Stage file" onClick={(e) => { e.stopPropagation(); p.onStage([f.path]); }}>
                <Icon name="plus" size={14} />
              </button>
            </span>
          </div>
        ))}

        <div className="rp-section">
          <span>Staged files ({staged.length})</span>
          {staged.length > 0 && (
            <button className="btn small" onClick={p.onUnstageAll} disabled={p.busy}>
              Unstage all changes
            </button>
          )}
        </div>
        {staged.length === 0 && <div className="rp-none">Nothing staged</div>}
        {staged.map((f) => (
          <div
            key={'s' + f.path}
            className={'f-row' + (isActive({ path: f.path, staged: true }) ? ' active' : '')}
            onClick={() => p.onOpen({ path: f.path, staged: true })}
          >
            <Badge code={f.index} />
            <FileName path={f.path} />
            <span className="f-actions">
              {p.resolved.includes(f.path) && (
                <button className="icon-btn" title="Reopen the conflict" onClick={(e) => { e.stopPropagation(); p.onReopen(f.path); }}>
                  <Icon name="warn" size={13} />
                </button>
              )}
              <button className="icon-btn" title="Unstage file" onClick={(e) => { e.stopPropagation(); p.onUnstage([f.path]); }}>
                <Icon name="minus" size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="commit-box">
        <div className="field">
          <input
            placeholder="Commit summary"
            value={summary}
            maxLength={200}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit && commit()}
          />
          <span className={'counter' + (summary.length > 72 ? ' over' : '')}>{72 - summary.length}</span>
        </div>
        <textarea placeholder="Description" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
          Amend previous commit
        </label>
        <button className="btn commit" disabled={!canCommit} onClick={commit}>
          {amend ? 'Amend commit' : `Commit changes to ${staged.length} file${staged.length === 1 ? '' : 's'}`}
        </button>
        <div className="hint">
          {conflicts.length > 0
            ? 'Resolve the conflicts above before committing'
            : `${p.branch ? `on ${p.branch}` : 'detached HEAD'} · Ctrl+Enter to commit`}
        </div>
        {p.author && (
          <div className="hint author" title={`Commits will be made as ${p.author}`}>
            committing as {p.author}
          </div>
        )}
      </div>
    </div>
  );
}
