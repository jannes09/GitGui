import { useState } from 'react';
import { Icon } from '../icons';
import { basename, dirname, samePath } from '../util';

export interface RepoTab {
  root: string;
  /** the repository's folder name */
  name: string;
  /** a name the user gave the tab; shown instead of the folder name */
  alias?: string;
}
/** What a tab shows about its repository; unknown until the repository has been read. */
export interface TabInfo {
  branch: string | null;
  changes: number;
  conflicts: number;
  /** the folder could not be read (moved, deleted or on a drive that is not connected) */
  missing?: boolean;
}

interface Props {
  tabs: RepoTab[];
  active: string | null;
  info: Record<string, TabInfo | undefined>;
  onSelect: (root: string) => void;
  onClose: (root: string) => void;
  onRename: (root: string) => void;
  onAdd: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onMove: (from: number, to: number) => void;
  onContext: (e: React.MouseEvent, root: string) => void;
}

/**
 * Tab labels: the alias if there is one, otherwise the folder name, plus its parent folder
 * when two tabs would otherwise look the same.
 */
function labels(tabs: RepoTab[]): string[] {
  return tabs.map((t) => {
    if (t.alias) return t.alias;
    const twin = tabs.some((o) => o !== t && !o.alias && o.name.toLowerCase() === t.name.toLowerCase());
    if (!twin) return t.name;
    const parent = basename(dirname(t.root).replace(/[\\/]+$/, ''));
    return parent ? `${t.name} (${parent})` : t.name;
  });
}

export function RepoTabs({ tabs, active, info, onSelect, onClose, onRename, onAdd, onMove, onContext }: Props) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const text = labels(tabs);

  return (
    <div className="rt-bar" role="tablist" aria-label="Open repositories">
      {tabs.map((t, i) => {
        const on = !!active && samePath(t.root, active);
        const d = info[t.root];
        const tip = [t.alias ? `${t.alias} (${t.name})` : '', t.root, d?.missing ? 'Folder not found' : d?.branch ? `on ${d.branch}` : d ? 'detached HEAD' : ''].filter(Boolean).join('\n');
        return (
          <div
            key={t.root}
            role="tab"
            aria-selected={on}
            tabIndex={0}
            title={tip}
            className={'rt-tab' + (on ? ' active' : '') + (d?.missing ? ' missing' : '') + (dragging === i ? ' dragging' : '') + (over === i && dragging !== null && dragging !== i ? ' drop' : '')}
            draggable
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', t.root);
            }}
            onDragOver={(e) => {
              if (dragging === null) return;
              e.preventDefault();
              setOver(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging !== null && dragging !== i) onMove(dragging, i);
              setDragging(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onClick={() => onSelect(t.root)}
            onDoubleClick={() => onRename(t.root)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()} // no autoscroll cursor on middle click
            onAuxClick={(e) => {
              if (e.button === 1) onClose(t.root);
            }}
            onContextMenu={(e) => onContext(e, t.root)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(t.root);
              } else if (e.key === 'F2') {
                e.preventDefault();
                onRename(t.root);
              }
            }}
          >
            <Icon name="folder" size={13} />
            <span className="rt-name">{text[i]}</span>
            {!!d?.conflicts && (
              <span className="rt-flag conflict" title={`${d.conflicts} conflicted file${d.conflicts === 1 ? '' : 's'}`}>
                <Icon name="warn" size={12} />
              </span>
            )}
            {!d?.conflicts && !!d?.changes && (
              <span className="rt-flag changes" title={`${d.changes} uncommitted change${d.changes === 1 ? '' : 's'}`}>
                {d.changes > 99 ? '99+' : d.changes}
              </span>
            )}
            <button
              className="rt-close"
              title="Close tab"
              aria-label={`Close ${t.alias ?? t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.root);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
      <button className="rt-add" onClick={onAdd} title="Open or clone a repository" aria-label="Open or clone a repository">
        <Icon name="plus" size={15} />
      </button>
    </div>
  );
}
