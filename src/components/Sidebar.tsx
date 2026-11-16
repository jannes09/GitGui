import { useMemo, useState } from 'react';
import { Icon, type IconName } from '../icons';
import type { RefsData } from '../types';
import { parseTrack } from '../util';

export type SidebarItem =
  | { kind: 'branch'; name: string; hash: string }
  | { kind: 'remote'; name: string; hash: string }
  | { kind: 'tag'; name: string; hash: string }
  | { kind: 'stash'; ref: string; hash: string };

interface Props {
  refs: RefsData | null;
  onFocus: (item: SidebarItem) => void;
  onActivate: (item: SidebarItem) => void;
  onContext: (e: React.MouseEvent, item: SidebarItem) => void;
}

function Section({
  title,
  icon,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: IconName;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sb-section">
      <button className="sb-title" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'right'} size={13} />
        <Icon name={icon} size={14} />
        <span>{title}</span>
        <span className="sb-count">{count}</span>
      </button>
      {open && <div className="sb-items">{children}</div>}
    </div>
  );
}

export function Sidebar({ refs, onFocus, onActivate, onContext }: Props) {
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);

  const remoteGroups = useMemo(() => {
    const groups = new Map<string, { name: string; hash: string }[]>();
    for (const r of refs?.remoteBranches ?? []) {
      if (!match(r.name)) continue;
      const list = groups.get(r.remote) ?? [];
      list.push({ name: r.name, hash: r.hash });
      groups.set(r.remote, list);
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, f]);

  if (!refs) return <aside className="sidebar" />;

  const branches = refs.branches.filter((b) => match(b.name));
  const tags = refs.tags.filter((t) => match(t.name));
  const stashes = refs.stashes.filter((s) => match(s.message));
  const remoteCount = [...remoteGroups.values()].reduce((n, l) => n + l.length, 0);

  return (
    <aside className="sidebar">
      <div className="sb-filter">
        <Icon name="search" size={13} />
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="sb-scroll">
        <Section title="LOCAL" icon="monitor" count={branches.length}>
          {branches.map((b) => {
            const { ahead, behind } = parseTrack(b.track);
            const item: SidebarItem = { kind: 'branch', name: b.name, hash: b.hash };
            return (
              <div
                key={b.name}
                className={'sb-item' + (b.current ? ' current' : '')}
                onClick={() => onFocus(item)}
                onDoubleClick={() => onActivate(item)}
                onContextMenu={(e) => onContext(e, item)}
                title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
              >
                {b.current ? <Icon name="check" size={13} /> : <span className="sb-gap" />}
                <span className="sb-name">{b.name}</span>
                {behind > 0 && <span className="sb-ab">↓{behind}</span>}
                {ahead > 0 && <span className="sb-ab">↑{ahead}</span>}
              </div>
            );
          })}
        </Section>

        <Section title="REMOTE" icon="cloud" count={remoteCount}>
          {[...remoteGroups.entries()].map(([remote, list]) => (
            <div key={remote}>
              <div className="sb-group">{remote}</div>
              {list.map((r) => {
                const item: SidebarItem = { kind: 'remote', name: r.name, hash: r.hash };
                return (
                  <div
                    key={r.name}
                    className="sb-item nested"
                    onClick={() => onFocus(item)}
                    onDoubleClick={() => onActivate(item)}
                    onContextMenu={(e) => onContext(e, item)}
                  >
                    <span className="sb-name">{r.name.slice(remote.length + 1)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </Section>

        <Section title="STASHES" icon="stash" count={stashes.length} defaultOpen={stashes.length > 0}>
          {stashes.map((s) => {
            const item: SidebarItem = { kind: 'stash', ref: s.ref, hash: s.hash };
            return (
              <div key={s.ref} className="sb-item" onClick={() => onFocus(item)} onContextMenu={(e) => onContext(e, item)}>
                <span className="sb-gap" />
                <span className="sb-name">{s.message}</span>
              </div>
            );
          })}
        </Section>

        <Section title="TAGS" icon="tag" count={tags.length} defaultOpen={false}>
          {tags.map((t) => {
            const item: SidebarItem = { kind: 'tag', name: t.name, hash: t.hash };
            return (
              <div key={t.name} className="sb-item" onClick={() => onFocus(item)} onContextMenu={(e) => onContext(e, item)}>
                <span className="sb-gap" />
                <span className="sb-name">{t.name}</span>
              </div>
            );
          })}
        </Section>
      </div>
    </aside>
  );
}
