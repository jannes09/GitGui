import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_REFS_W, GRAPH_PAD, LANE_COLORS, LANE_W, ROW_H, parseRefs, type GraphData, type GraphRow, type Seg } from '../graph';
import { Icon } from '../icons';
import { initials, relativeDate } from '../util';
import { Splitter } from './Splitter';

interface Props {
  data: GraphData;
  remotes: string[];
  selected: string | null;
  matches: Set<string>;
  focus: { hash: string; nonce: number } | null;
  hasMore: boolean;
  refsW: number;
  onRefsW: (w: number) => void;
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

interface RowProps {
  row: GraphRow;
  top: number;
  graphW: number;
  remotes: string[];
  selected: boolean;
  match: boolean;
  onSelect: (hash: string) => void;
  onContext: (e: React.MouseEvent, hash: string) => void;
  onActivate: (e: React.MouseEvent, hash: string) => void;
}

const Row = memo(function Row({ row, top, graphW, remotes, selected, match, onSelect, onContext, onActivate }: RowProps) {
  const c = row.commit;
  const color = LANE_COLORS[row.color];
  const labels = useMemo(() => parseRefs(c.refsRaw, remotes), [c.refsRaw, remotes]);
  const cx = x(row.col);
  const cy = ROW_H / 2;

  return (
    <div
      className={'g-row' + (selected ? ' selected' : '') + (match ? ' match' : '') + (row.wip ? ' wip' : '')}
      style={{ top, height: ROW_H }}
      onClick={() => onSelect(c.hash)}
      onDoubleClick={(e) => onActivate(e, c.hash)}
      onContextMenu={(e) => onContext(e, c.hash)}
    >
      <div className="c-refs">
        {row.wip && (
          <span className="pill wip-pill" style={{ borderColor: color, color }}>
            WIP
          </span>
        )}
        {labels.slice(0, 3).map((l) => (
          <span
            key={l.kind + l.name}
            className={'pill' + (l.current ? ' current' : '')}
            style={
              l.current
                ? { background: color, borderColor: color }
                : { background: color + '26', borderColor: color + '88' }
            }
            title={l.name}
          >
            {l.kind === 'tag' && <Icon name="tag" size={11} />}
            <span className="pill-text">{l.name}</span>
            {l.kind === 'branch' && l.local && <Icon name="monitor" size={11} />}
            {(l.kind === 'remote' || l.remote) && <Icon name="cloud" size={11} />}
          </span>
        ))}
        {labels.length > 3 && <span className="pill more">+{labels.length - 3}</span>}
      </div>
      <div className="c-graph" style={{ width: graphW }}>
        <svg width={graphW} height={ROW_H} style={{ overflow: 'visible' }}>
          {row.segs.map((s, i) => (
            <path key={i} d={segPath(s)} stroke={LANE_COLORS[s.color]} strokeWidth={2} fill="none" strokeDasharray={row.wip ? '3 3' : undefined} />
          ))}
          {row.wip ? (
            <circle cx={cx} cy={cy} r={9} fill="var(--bg)" stroke={color} strokeWidth={2} strokeDasharray="3 3" />
          ) : row.merge ? (
            <circle cx={cx} cy={cy} r={5} fill={color} stroke="var(--bg)" strokeWidth={2} />
          ) : (
            <>
              <circle cx={cx} cy={cy} r={11} fill="var(--bg-raised)" stroke={color} strokeWidth={2.5} />
              <text x={cx} y={cy + 3.5} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="var(--text)">
                {initials(c.author)}
              </text>
            </>
          )}
        </svg>
      </div>
      <div className="c-msg" title={c.subject}>
        {row.wip ? <span className="wip-text">// WIP</span> : c.subject}
      </div>
      <div className="c-author">{row.wip ? '' : c.author}</div>
      <div className="c-date">{row.wip ? '' : relativeDate(c.date)}</div>
    </div>
  );
});

export function GraphView({ data, remotes, selected, matches, focus, hasMore, refsW, onRefsW, onSelect, onContext, onActivate, onNearEnd }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const graphW = GRAPH_PAD * 2 + Math.max(0, Math.min(data.maxLanes, 24) - 1) * LANE_W;

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

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 40) onNearEnd();
  };

  const cols = `${refsW}px ${graphW}px minmax(160px, 1fr) 150px 120px`;

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
      <div className="g-scroll" ref={scroller} onScroll={onScroll}>
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {data.rows.slice(start, end).map((row, i) => (
            <Row
              key={row.commit.hash}
              row={row}
              top={(start + i) * ROW_H}
              graphW={graphW}
              remotes={remotes}
              selected={row.commit.hash === selected}
              match={matches.has(row.commit.hash)}
              onSelect={onSelect}
              onContext={onContext}
              onActivate={onActivate}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
