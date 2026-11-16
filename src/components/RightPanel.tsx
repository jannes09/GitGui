import { useEffect, useMemo, useState } from 'react';
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

/* ---------- selected commit ---------- */

interface CommitPanelProps {
  repo: string;
  hash: string;
  onOpen: (t: DiffTarget) => void;
  onError: (msg: string) => void;
}

export function CommitPanel({ repo, hash, onOpen, onError }: CommitPanelProps) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [files, setFiles] = useState<CommitFile[]>([]);

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
        {body && <pre className="cd-body">{body}</pre>}
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
          <div key={f.path} className="f-row" onClick={() => onOpen({ path: f.path, hash })}>
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

  const staged = useMemo(() => p.files.filter((f) => f.index !== '.' && f.index !== '?' && !f.conflicted), [p.files]);
  const unstaged = useMemo(() => p.files.filter((f) => f.worktree !== '.' || f.conflicted), [p.files]);

  const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
  const canCommit = !p.busy && (staged.length > 0 || amend) && (summary.trim().length > 0 || amend);

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
            className="f-row"
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
          <div key={'s' + f.path} className="f-row" onClick={() => p.onOpen({ path: f.path, staged: true })}>
            <Badge code={f.index} />
            <FileName path={f.path} />
            <span className="f-actions">
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
        <textarea placeholder="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
          Amend previous commit
        </label>
        <button className="btn commit" disabled={!canCommit} onClick={commit}>
          {amend ? 'Amend commit' : `Commit changes to ${staged.length} file${staged.length === 1 ? '' : 's'}`}
        </button>
        <div className="hint">{p.branch ? `on ${p.branch}` : 'detached HEAD'} · Ctrl+Enter to commit</div>
      </div>
    </div>
  );
}
