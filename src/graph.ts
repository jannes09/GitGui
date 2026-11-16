import type { Commit } from './types';

export const LANE_COLORS = ['#2dd4bf', '#a78bfa', '#fb923c', '#f472b6', '#60a5fa', '#a3e635', '#facc15', '#f87171'];
export const ROW_H = 34;
export const LANE_W = 18;
export const GRAPH_PAD = 18;
export const DEFAULT_REFS_W = 230;

export interface Seg {
  x1: number; // lane index
  y1: number; // 0 = top of row, 0.5 = node centre, 1 = bottom
  x2: number;
  y2: number;
  color: number;
}
export interface GraphRow {
  commit: Commit;
  col: number;
  color: number;
  segs: Seg[];
  merge: boolean;
  wip?: boolean;
  stash?: boolean;
}
export interface GraphData {
  rows: GraphRow[];
  maxLanes: number;
}

export const WIP_HASH = 'WIP';

/**
 * Assigns every commit a lane and the line segments to draw in its row.
 * Input must be in topological (children before parents) order, which
 * `git log --date-order` guarantees.
 */
export function computeGraph(commits: Commit[]): GraphData {
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  let maxLanes = 1;
  const rows: GraphRow[] = [];

  const newColor = () => nextColor++ % LANE_COLORS.length;
  const firstFree = () => {
    let i = 0;
    while (i < lanes.length && lanes[i] !== null) i++;
    while (lanes.length <= i) lanes.push(null);
    return i;
  };

  for (const c of commits) {
    const before = lanes.slice();
    const waiting: number[] = [];
    before.forEach((h, i) => {
      if (h === c.hash) waiting.push(i);
    });

    let col: number;
    if (waiting.length === 0) {
      col = firstFree();
      laneColor[col] = newColor();
    } else {
      col = waiting[0];
    }
    const color = laneColor[col];
    const segs: Seg[] = [];

    before.forEach((h, i) => {
      if (h === null) return;
      if (h === c.hash) segs.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: laneColor[i] });
      else segs.push({ x1: i, y1: 0, x2: i, y2: 1, color: laneColor[i] });
    });
    for (const i of waiting) lanes[i] = null;

    c.parents.forEach((p, k) => {
      const existing = lanes.indexOf(p);
      if (existing >= 0) {
        segs.push({ x1: col, y1: 0.5, x2: existing, y2: 1, color: laneColor[existing] });
      } else if (k === 0) {
        lanes[col] = p;
        segs.push({ x1: col, y1: 0.5, x2: col, y2: 1, color });
      } else {
        const j = firstFree();
        lanes[j] = p;
        laneColor[j] = newColor();
        segs.push({ x1: col, y1: 0.5, x2: j, y2: 1, color: laneColor[j] });
      }
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
    rows.push({ commit: c, col, color, segs, merge: c.parents.length > 1, wip: c.hash === WIP_HASH, stash: c.stashRef !== undefined });
  }
  return { rows, maxLanes };
}

export interface RefLabel {
  name: string;
  kind: 'branch' | 'remote' | 'tag' | 'head';
  current?: boolean;
  local?: boolean;
  remote?: boolean;
}

/** Turns git's `%D` decoration string into de-duplicated labels. */
export function parseRefs(raw: string, remotes: string[]): RefLabel[] {
  if (!raw) return [];
  const labels: RefLabel[] = [];
  const locals = new Map<string, RefLabel>();
  const remoteNames: string[] = [];
  const tags: string[] = [];

  for (const part of raw.split(', ')) {
    if (part === 'HEAD') {
      labels.push({ name: 'HEAD', kind: 'head', current: true });
    } else if (part.startsWith('HEAD -> ')) {
      const name = part.slice(8);
      const l: RefLabel = { name, kind: 'branch', current: true, local: true };
      locals.set(name, l);
      labels.push(l);
    } else if (part.startsWith('tag: ')) {
      tags.push(part.slice(5));
    } else if (remotes.some((r) => part.startsWith(r + '/'))) {
      if (!part.endsWith('/HEAD')) remoteNames.push(part);
    } else {
      const l: RefLabel = { name: part, kind: 'branch', local: true };
      locals.set(part, l);
      labels.push(l);
    }
  }
  for (const rn of remoteNames) {
    const short = rn.slice(rn.indexOf('/') + 1);
    const l = locals.get(short);
    if (l) l.remote = true;
    else labels.push({ name: rn, kind: 'remote', remote: true });
  }
  for (const t of tags) labels.push({ name: t, kind: 'tag' });
  return labels;
}
