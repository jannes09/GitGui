import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_REFS_W, GRAPH_PAD, LANE_COLORS, LANE_W, ROW_H, bandSpans, parseRefs, type GraphData, type GraphRow, type MainLane, type RefLabel, type Seg } from '../graph';
import { Icon } from '../icons';
import { CHAR_W, fitLabels, labelRank, type FitItem } from '../refLabels';
import type { PullRequest } from '../types';
import { initials, relativeDate } from '../util';
import { Splitter } from './Splitter';

/** How the graph emphasises its main lanes; each part can be switched off in the settings. */
export interface GraphLook {
  bold: boolean;
  band: boolean;
  boldMessages: boolean;
  chips: boolean;
}

interface Props {
  data: GraphData;
  look: GraphLook;
  /** whether a branch name (without its remote) is one of the main branches */
  isMain: (name: string) => boolean;
  remotes: string[];
  selected: string | null;
  matches: Set<string>;
  focus: { hash: string; nonce: number } | null;
  hasMore: boolean;
  refsW: number;
  onRefsW: (w: number) => void;
  tracks: Record<string, { ahead: number; behind: number }>;
  /** open pull requests by the label they belong to (a local branch name, or `origin/name`) */
  prs: Record<string, PullRequest>;
  onOpenPr: (pr: PullRequest) => void;
  onSelect: (hash: string) => void;
  onContext: (e: React.MouseEvent, hash: string) => void;
  onActivate: (e: React.MouseEvent, hash: string) => void;
  onNearEnd: () => void;
}

const OVERSCAN = 8;

function x(lane: number) {
  return GRAPH_PAD + lane * LANE_W;
}

function segPath(s: Seg): string {
  const x1 = x(s.x1);
  const x2 = x(s.x2);
  let y1 = s.y1 * ROW_H;
  let y2 = s.y2 * ROW_H;
  if (x1 === x2) {
    // overlap by half a pixel so adjacent rows never show a seam
    if (s.y1 === 0) y1 -= 0.5;
    if (s.y2 === 1) y2 += 0.5;
    return `M${x1} ${y1}L${x2} ${y2}`;
  }
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

/** One label above a main lane: its branch name, at the lane's position. */
interface Chip {
  name: string;
  lane: number;
  color: number;
}
const CHIP_CHAR_W = 6.6;
function chipsFor(row: GraphRow | undefined): { chip: Chip; left: number; width: number }[] {
  // the lanes entering the row, plus the lane of the row's own commit (the very top of a main line has no lane above it)
  const lanes: MainLane[] = [...(row?.mainLanes ?? [])];
  if (row?.main && row.mainName && !lanes.some((l) => l.lane === row.col)) lanes.push({ lane: row.col, name: row.mainName, color: row.color });
  const seen = new Set<string>();
  const out: { chip: Chip; left: number; width: number }[] = [];
  let right = -Infinity;
  for (const l of lanes.sort((a, b) => a.lane - b.lane)) {
    if (seen.has(l.name)) continue; // the same branch can have a local and a remote lane
    seen.add(l.name);
    const text = l.name.length > 14 ? l.name.slice(0, 13) + '…' : l.name;
    const width = text.length * CHIP_CHAR_W + 14;
    // centred on its lane, but never overlapping the chip before it
    const left = Math.max(x(l.lane) - width / 2, right + 4, 2);
    out.push({ chip: { name: l.name, lane: l.lane, color: l.color }, left, width });
    right = left + width;
  }
  return out;
}

/** One branch / tag as the pill planner sees it. */
interface LabelItem extends FitItem {
  label: RefLabel;
  ahead: number;
  behind: number;
  pr: PullRequest | null;
}
/** What the hover card shows for one label. */
interface LabelDetail {
  name: string;
  kind: RefLabel['kind'];
  current: boolean;
  local: boolean;
  remote: boolean;
  ahead: number;
  behind: number;
  pr: PullRequest | null;
}

// A remote-only label is `origin/name`; its rank is about `name`.
const rankOf = (l: RefLabel, isMain: (name: string) => boolean) =>
  labelRank(l.kind, !!l.current, l.kind === 'remote' ? l.name.slice(l.name.indexOf('/') + 1) : l.name, isMain);
const ICON_W = 15; // a small icon plus its gap, inside a pill
const PR_W = 44; // the pull request badge, e.g. "#128"
const FIXED_PILL_W: { wip: number; stash: number } = { wip: 50, stash: 72 };

function describe(item: LabelItem): string {
  return (
    item.label.name +
    (item.ahead ? `\n${item.ahead} commit${item.ahead === 1 ? '' : 's'} not pushed` : '') +
    (item.behind ? `\n${item.behind} commit${item.behind === 1 ? '' : 's'} to pull` : '') +
    (item.pr ? `\nPull request #${item.pr.number}${item.pr.draft ? ' (draft)' : ''}: ${item.pr.title}` : '')
  );
}

/** The branch under the mouse in a row's graph cell: a lane line or the commit itself. */
export interface LaneTip {
  x: number;
  y: number;
  name: string;
  color: number;
  main: boolean;
}
function laneUnder(row: GraphRow, e: React.MouseEvent<HTMLDivElement>, cx: number, cy: number): LaneTip | null {
  const box = e.currentTarget.getBoundingClientRect();
  const mx = e.clientX - box.left;
  const my = e.clientY - box.top;
  let best: { name: string; color: number; main: boolean; d: number } | null = null;
  const consider = (lane: number, name: string | undefined, color: number, main: boolean, reach: number) => {
    if (!name) return;
    const d = Math.abs(mx - x(lane));
    if (d <= reach && (!best || d < best.d)) best = { name, color, main, d };
  };
  // the commit itself first, then the lines: the upper half of the row shows lines arriving, the lower half lines leaving
  if (Math.hypot(mx - cx, my - cy) <= 14) consider(row.col, row.branch, row.color, !!row.main, 14);
  for (const s of row.segs) {
    if (my < ROW_H / 2 ? s.y1 === 0 : s.y2 === 1) consider(my < ROW_H / 2 ? s.x1 : s.x2, s.name, s.color, !!s.main, 8);
  }
  const hit = best as { name: string; color: number; main: boolean } | null;
  return hit ? { x: e.clientX, y: e.clientY, name: hit.name, color: hit.color, main: hit.main } : null;
}

interface RowProps {
  row: GraphRow;
  look: GraphLook;
  isMain: (name: string) => boolean;
  onLaneHover: (tip: LaneTip | null) => void;
  top: number;
  graphW: number;
  refsW: number;
  remotes: string[];
  selected: boolean;
  match: boolean;
  tracks: Record<string, { ahead: number; behind: number }>;
  prs: Record<string, PullRequest>;
  onOpenPr: (pr: PullRequest) => void;
  onSelect: (hash: string) => void;
  onContext: (e: React.MouseEvent, hash: string) => void;
  onActivate: (e: React.MouseEvent, hash: string) => void;
  onRefsEnter: (rect: DOMRect, details: LabelDetail[]) => void;
  onRefsLeave: () => void;
}

const Row = memo(function Row({ row, look, isMain, onLaneHover, top, graphW, refsW, remotes, selected, match, tracks, prs, onOpenPr, onSelect, onContext, onActivate, onRefsEnter, onRefsLeave }: RowProps) {
  const c = row.commit;
  const color = LANE_COLORS[row.color];
  const labels = useMemo(() => parseRefs(c.refsRaw, remotes), [c.refsRaw, remotes]);
  const cx = x(row.col);
  const cy = ROW_H / 2;

  // Most important first: the checked-out branch, then local branches, remote-only branches, tags.
  // With a single remote its name is left off (the cloud icon says "remote"), which saves a lot of room.
  const items = useMemo<LabelItem[]>(
    () =>
      [...labels]
        .sort((a, b) => rankOf(a, isMain) - rankOf(b, isMain))
        .map((l) => {
          const t = l.kind === 'branch' && l.local ? tracks[l.name] : undefined;
          const ahead = t?.ahead ?? 0;
          const behind = t?.behind ?? 0;
          const text = l.kind === 'remote' && remotes.length === 1 ? l.name.slice(l.name.indexOf('/') + 1) : l.name;
          const extra =
            (l.kind === 'tag' ? ICON_W : 0) +
            (l.kind === 'branch' && l.local ? ICON_W : 0) +
            (l.kind === 'remote' || l.remote ? ICON_W : 0) +
            (behind ? (String(behind).length + 1) * CHAR_W + 4 : 0) +
            (ahead ? (String(ahead).length + 1) * CHAR_W + 4 : 0);
          const pr = l.kind === 'tag' ? null : prs[l.name] ?? null;
          return { text, extra: extra + (pr ? PR_W : 0), label: l, ahead, behind, pr };
        }),
    [labels, tracks, prs, remotes.length, isMain],
  );
  const reserved = (row.wip ? FIXED_PILL_W.wip + 4 : 0) + (c.stashRef ? FIXED_PILL_W.stash + 4 : 0);
  const fit = useMemo(() => fitLabels(items, refsW - 20 - reserved), [items, refsW, reserved]);
  const truncated = fit.hidden.length > 0 || fit.shown.some((s) => s.shortened);
  const details = useMemo<LabelDetail[]>(
    () =>
      items.map(({ label: l, ahead, behind, pr }) => ({
        name: l.name,
        kind: l.kind,
        current: !!l.current,
        local: !!(l.kind === 'branch' && l.local),
        remote: l.kind === 'remote' || !!l.remote,
        ahead,
        behind,
        pr,
      })),
    [items],
  );

  return (
    <div
      className={'g-row' + (selected ? ' selected' : '') + (match ? ' match' : '') + (row.wip ? ' wip' : '') + (row.stash ? ' stash' : '')}
      style={{ top, height: ROW_H }}
      onClick={() => onSelect(c.hash)}
      onDoubleClick={(e) => onActivate(e, c.hash)}
      onContextMenu={(e) => onContext(e, c.hash)}
    >
      <div
        className="c-refs"
        onMouseEnter={(e) => truncated && onRefsEnter(e.currentTarget.getBoundingClientRect(), details)}
        onMouseLeave={onRefsLeave}
      >
        {row.wip && (
          <span className="pill wip-pill" style={{ borderColor: color, color }}>
            WIP
          </span>
        )}
        {c.stashRef && (
          <span className="pill stash-pill" style={{ borderColor: color, color }} title={c.stashRef}>
            <Icon name="stash" size={11} />
            <span className="pill-text">stash</span>
          </span>
        )}
        {fit.shown.map(({ item, text }) => {
          const l = item.label;
          return (
            <span
              key={l.kind + l.name}
              className={'pill' + (l.current ? ' current' : '')}
              style={
                l.current
                  ? { background: color, borderColor: color }
                  : { background: color + '26', borderColor: color + '88' }
              }
              title={truncated ? undefined : describe(item)} // the hover card already says it, so no second tooltip
            >
              {l.kind === 'tag' && <Icon name="tag" size={11} />}
              <span className="pill-text">{text}</span>
              {item.behind > 0 && <span className="pill-ab">↓{item.behind}</span>}
              {item.ahead > 0 && <span className="pill-ab">↑{item.ahead}</span>}
              {item.pr && (
                <span
                  className={'pill-pr' + (item.pr.draft ? ' draft' : '')}
                  role="link"
                  title={truncated ? undefined : `Open pull request #${item.pr.number}${item.pr.draft ? ' (draft)' : ''}: ${item.pr.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPr(item.pr!);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <Icon name="pr" size={11} />#{item.pr.number}
                </span>
              )}
              {l.kind === 'branch' && l.local && <Icon name="monitor" size={11} />}
              {(l.kind === 'remote' || l.remote) && <Icon name="cloud" size={11} />}
            </span>
          );
        })}
        {fit.hidden.length > 0 && (
          <span className="pill more">
            +{fit.hidden.length}
          </span>
        )}
      </div>
      <div className="c-graph" style={{ width: graphW }} onMouseMove={(e) => onLaneHover(laneUnder(row, e, cx, cy))} onMouseLeave={() => onLaneHover(null)}>
        <svg width={graphW} height={ROW_H} style={{ overflow: 'visible' }}>
          {look.band &&
            bandSpans(row).map((b, i) => {
              // overlap neighbouring rows by half a pixel so the band has no seams
              const top = b.from * ROW_H - (b.from === 0 ? 0.5 : 0);
              const bottom = b.to * ROW_H + (b.to === 1 ? 0.5 : 0);
              return <rect key={'band' + i} x={x(b.lane) - LANE_W / 2 + 2} y={top} width={LANE_W - 4} height={bottom - top} fill={LANE_COLORS[b.color]} opacity={0.13} />;
            })}
          {row.segs.map((s, i) => (
            <path
              key={i}
              d={segPath(s)}
              stroke={LANE_COLORS[s.color]}
              strokeWidth={look.bold && s.main ? 4 : 2}
              fill="none"
              // only the line leaving a WIP/stash node is dashed, never the other lanes passing through its row
              strokeDasharray={(row.wip || row.stash) && s.y1 === 0.5 ? '3 3' : undefined}
            />
          ))}
          {row.wip ? (
            <circle cx={cx} cy={cy} r={9} fill="var(--bg)" stroke={color} strokeWidth={2} strokeDasharray="3 3" />
          ) : row.stash ? (
            <>
              <rect x={cx - 9} y={cy - 9} width={18} height={18} rx={4} fill="var(--bg-raised)" stroke={color} strokeWidth={2} strokeDasharray="4 2" />
              <path d={`M${cx - 4} ${cy - 2}h8M${cx - 4} ${cy + 2}h8`} stroke={color} strokeWidth={1.6} strokeLinecap="round" />
            </>
          ) : row.merge ? (
            <circle cx={cx} cy={cy} r={look.bold && row.main ? 7 : 5} fill={color} stroke="var(--bg)" strokeWidth={2} />
          ) : (
            <g>
              <circle cx={cx} cy={cy} r={look.bold && row.main ? 13 : 11} fill="var(--bg-raised)" stroke={color} strokeWidth={look.bold && row.main ? 3.5 : 2.5} />
              <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={look.bold && row.main ? 10.5 : 9.5} fontWeight={700} fill="var(--text)">
                {initials(c.author)}
              </text>
            </g>
          )}
        </svg>
      </div>
      <div className={'c-msg' + (look.boldMessages && row.main ? ' main-line' : '')} title={c.subject}>
        {row.wip ? <span className="wip-text">// WIP</span> : c.subject}
      </div>
      <div className="c-author">{row.wip ? '' : c.stashRef ?? c.author}</div>
      <div className="c-date">{row.wip ? '' : relativeDate(c.date)}</div>
    </div>
  );
});

export function GraphView({ data, look, isMain, remotes, selected, matches, focus, hasMore, refsW, onRefsW, tracks, prs, onOpenPr, onSelect, onContext, onActivate, onNearEnd }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  // never narrower than the "GRAPH" column title, even for a single straight line of history
  const graphW = Math.max(56, GRAPH_PAD * 2 + Math.max(0, Math.min(data.maxLanes, 24) - 1) * LANE_W);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!focus || !scroller.current) return;
    const idx = data.rows.findIndex((r) => r.commit.hash === focus.hash);
    if (idx < 0) return;
    const el = scroller.current;
    const top = idx * ROW_H;
    if (top < el.scrollTop + ROW_H || top > el.scrollTop + el.clientHeight - ROW_H * 2) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const total = data.rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);

  // Up / Down (and PageUp / PageDown / Home / End) move the selection, but only while the graph has focus.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || total === 0) return;
    const page = Math.max(1, Math.floor(height / ROW_H) - 1);
    const jump: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (!(e.key in jump) && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const at = data.rows.findIndex((r) => r.commit.hash === selected);
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? total - 1 : at < 0 ? 0 : Math.min(total - 1, Math.max(0, at + jump[e.key]));
    if (to === at) return;
    onSelect(data.rows[to].commit.hash);
    const el = e.currentTarget;
    const top = to * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };

  // Hover card with every label of a row, shown only when the pills had to be shortened or hidden.
  const [pop, setPop] = useState<{ rect: DOMRect; details: LabelDetail[] } | null>(null);
  const popTimer = useRef<number | undefined>(undefined);
  const onRefsEnter = useCallback((rect: DOMRect, details: LabelDetail[]) => {
    window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => setPop({ rect, details }), 220);
  }, []);
  const onRefsLeave = useCallback(() => {
    window.clearTimeout(popTimer.current);
    setPop(null);
  }, []);
  useEffect(() => () => window.clearTimeout(popTimer.current), []);

  // the branch name under the mouse when it is over a lane or a commit; only re-rendered when it changes
  const [laneTip, setLaneTip] = useState<LaneTip | null>(null);
  const onLaneHover = useCallback((tip: LaneTip | null) => {
    setLaneTip((cur) => {
      if (!tip) return cur ? null : cur;
      if (cur && cur.name === tip.name && Math.abs(cur.x - tip.x) < 4 && Math.abs(cur.y - tip.y) < 4) return cur;
      return tip;
    });
  }, []);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    onRefsLeave();
    setLaneTip(null);
    setScrollTop(el.scrollTop);
    if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 40) onNearEnd();
  };

  const cols = `${refsW}px ${graphW}px minmax(160px, 1fr) 150px 120px`;

  // Branch name chips for the main lanes, taken from the row at the top of the view so they follow the scrolling.
  const showChips = look.chips && data.hasMain;
  const topRow = Math.min(Math.max(0, total - 1), Math.floor(scrollTop / ROW_H));
  const chips = showChips ? chipsFor(data.rows[topRow]) : [];

  return (
    <div className="graph" style={{ ['--cols' as string]: cols }}>
      <div className="g-head" style={{ gridTemplateColumns: cols }}>
        <div className="hc-first">
          BRANCH / TAG
          <Splitter className="col-handle" label="Resize branch and tag column" value={refsW} min={120} max={420} onChange={onRefsW} onReset={() => onRefsW(DEFAULT_REFS_W)} />
        </div>
        <div>GRAPH</div>
        <div>COMMIT MESSAGE</div>
        <div>AUTHOR</div>
        <div>DATE</div>
      </div>
      {showChips && (
        <div className="g-lanes" style={{ gridTemplateColumns: cols }} aria-hidden="true">
          <div />
          <div className="gl-cell">
            {chips.map(({ chip, left, width }) => (
              <span key={chip.name} className="lane-chip" style={{ left, minWidth: width, background: LANE_COLORS[chip.color] }} title={chip.name}>
                {chip.name.length > 14 ? chip.name.slice(0, 13) + '…' : chip.name}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="g-scroll" ref={scroller} onScroll={onScroll} onKeyDown={onKeyDown} tabIndex={0} aria-label="Commit history">
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {data.rows.slice(start, end).map((row, i) => (
            <Row
              key={row.commit.hash}
              row={row}
              look={look}
              isMain={isMain}
              onLaneHover={onLaneHover}
              top={(start + i) * ROW_H}
              graphW={graphW}
              refsW={refsW}
              remotes={remotes}
              selected={row.commit.hash === selected}
              match={matches.has(row.commit.hash)}
              tracks={tracks}
              prs={prs}
              onOpenPr={onOpenPr}
              onSelect={onSelect}
              onContext={onContext}
              onActivate={onActivate}
              onRefsEnter={onRefsEnter}
              onRefsLeave={onRefsLeave}
            />
          ))}
        </div>
      </div>
      {pop && <RefsCard rect={pop.rect} details={pop.details} />}
      {laneTip && (
        <div className="lane-tip" style={{ left: laneTip.x + 14, top: laneTip.y + 16 }} role="tooltip">
          <span className="lt-dot" style={{ background: LANE_COLORS[laneTip.color] }} />
          {laneTip.name}
          {laneTip.main && <span className="rc-chip on">main line</span>}
        </div>
      )}
    </div>
  );
}

/** Every branch and tag on a commit, written out in full, for rows where the pills are shortened. */
function RefsCard({ rect, details }: { rect: DOMRect; details: LabelDetail[] }) {
  const height = details.length * 27 + 16;
  const below = rect.bottom + 4 + height <= window.innerHeight;
  const top = below ? rect.bottom + 2 : Math.max(4, rect.top - height - 2);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 440));
  return (
    <div className="refs-card" style={{ top, left }} role="tooltip">
      {details.map((d) => (
        <div key={d.kind + d.name} className="rc-row">
          <span className="rc-icon">
            <Icon name={d.kind === 'tag' ? 'tag' : d.kind === 'remote' ? 'cloud' : 'branch'} size={13} />
          </span>
          <span className={'rc-name' + (d.current ? ' current' : '')}>{d.name}</span>
          <span className="rc-chips">
            {d.current && <span className="rc-chip on">checked out</span>}
            {d.local && <span className="rc-chip">local</span>}
            {d.remote && <span className="rc-chip">remote</span>}
            {d.ahead > 0 && <span className="rc-chip">↑{d.ahead} not pushed</span>}
            {d.behind > 0 && <span className="rc-chip">↓{d.behind} to pull</span>}
            {d.pr && (
              <span className="rc-chip on">
                PR #{d.pr.number}
                {d.pr.draft ? ' draft' : ''}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
