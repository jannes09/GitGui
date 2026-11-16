import { Icon, type IconName } from '../icons';

interface Props {
  repoName: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  busy: string | null;
  query: string;
  matchInfo: string;
  onQuery: (q: string) => void;
  onSearchKey: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onOpen: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onBranch: () => void;
  onStash: () => void;
  onPop: () => void;
}

function Action({
  icon,
  label,
  onClick,
  disabled,
  badge,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  badge?: number;
  title?: string;
}) {
  return (
    <button className="tb-action" onClick={onClick} disabled={disabled} title={title ?? label}>
      <span className="tb-icon">
        <Icon name={icon} size={18} />
        {!!badge && <span className="tb-badge">{badge}</span>}
      </span>
      <span className="tb-label">{label}</span>
    </button>
  );
}

export function Toolbar(p: Props) {
  const has = p.repoName !== null;
  const off = !has || p.busy !== null;
  return (
    <header className="toolbar">
      <div className="tb-left">
        <button className="tb-repo" onClick={p.onOpen} title="Open repository">
          <Icon name="folder" size={16} />
          <span className="tb-repo-text">
            <small>repository</small>
            <strong>{p.repoName ?? 'Open…'}</strong>
          </span>
          <Icon name="down" size={13} />
        </button>
        {has && (
          <div className="tb-repo static">
            <Icon name="branch" size={16} />
            <span className="tb-repo-text">
              <small>branch</small>
              <strong>{p.branch ?? 'detached HEAD'}</strong>
            </span>
          </div>
        )}
      </div>

      <div className="tb-center">
        <Action
          icon="undo"
          label="Undo"
          title={p.undoLabel ? `Undo: ${p.undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
          onClick={p.onUndo}
          disabled={off || !p.undoLabel}
        />
        <Action
          icon="redo"
          label="Redo"
          title={p.redoLabel ? `Redo: ${p.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
          onClick={p.onRedo}
          disabled={off || !p.redoLabel}
        />
        <span className="tb-sep" />
        <Action icon="fetch" label="Fetch" onClick={p.onFetch} disabled={off} />
        <Action icon="pull" label="Pull" onClick={p.onPull} disabled={off} badge={p.behind} />
        <Action icon="push" label="Push" onClick={p.onPush} disabled={off} badge={p.ahead} />
        <span className="tb-sep" />
        <Action icon="branch" label="Branch" onClick={p.onBranch} disabled={off} />
        <Action icon="stash" label="Stash" onClick={p.onStash} disabled={off} />
        <Action icon="pop" label="Pop" onClick={p.onPop} disabled={off} />
      </div>

      <div className="tb-right">
        {p.busy && <span className="tb-busy">{p.busy}…</span>}
        <div className="tb-search">
          <Icon name="search" size={14} />
          <input
            placeholder="Search commits"
            value={p.query}
            disabled={!has}
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={p.onSearchKey}
          />
          {p.query && <span className="tb-match">{p.matchInfo}</span>}
        </div>
      </div>
    </header>
  );
}
