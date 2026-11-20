import type { Commit } from './types';

/**
 * Lane colours. The first three are the main branches' signature colours (dev teal, other main
 * branches purple, main / master gold, see MAIN_COLOR_BY_GROUP); the rest are for everything else.
 */
export const LANE_COLORS = [
  '#2dd4bf', // 0 teal
  '#a78bfa', // 1 purple
  '#fb923c', // 2 orange
  '#f472b6', // 3 pink
  '#60a5fa', // 4 blue
  '#a3e635', // 5 lime
  '#facc15', // 6 gold
  '#f87171', // 7 red
  '#4ade80', // 8 green
  '#e879f9', // 9 fuchsia
  '#38bdf8', // 10 sky
  '#94a3b8', // 11 slate
  '#818cf8', // 12 periwinkle
];

/**
 * How different two lane colours look ("redmean" distance in RGB; 0 = identical, about 100 = clearly
 * different). Used so a new lane gets a colour that stands out from the lanes beside it.
 */
export function colorDistance(a: number, b: number): number {
  const rgb = (i: number) => [1, 3, 5].map((k) => parseInt(LANE_COLORS[i].slice(k, k + 2), 16));
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}
const MIN_APART = 90;
/** Signature colours of main branches, as indexes into LANE_COLORS: dev = teal, main / master = gold, other = purple. */
export const MAIN_COLOR_BY_GROUP = [0, 6, 1] as const;
export const ROW_H = 34;
export const LANE_W = 18;
export const GRAPH_PAD = 18;
export const DEFAULT_REFS_W = 260;

export interface Seg {
  x1: number; // lane index
  y1: number; // 0 = top of row, 0.5 = node centre, 1 = bottom
  x2: number;
  y2: number;
  color: number;
  /** the segment belongs to a main line (the first-parent history of a main branch) */
  main?: boolean;
  /** the branch this lane belongs to, when it can be told */
  name?: string;
}
/** A main lane as it enters the top of a row; used for the branch name chips above the graph. */
export interface MainLane {
  lane: number;
  name: string;
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
  /** the commit is on a main line */
  main?: boolean;
  /** the main branch whose line the commit is on */
  mainName?: string;
  /** the branch the commit's lane belongs to, when it can be told */
  branch?: string;
  /** main lanes entering the top of this row */
  mainLanes?: MainLane[];
}
export interface GraphData {
  rows: GraphRow[];
  maxLanes: number;
  /** at least one commit is on a main line */
  hasMain: boolean;
}

export const WIP_HASH = 'WIP';

export interface GraphOptions {
  /** commit hash -> name of the main branch whose first-parent line it is on */
  main?: Map<string, string>;
  /** commits of the primary main line; they get lane 0 and nothing else may use it */
  pin?: Set<string>;
  /** main lines use their branch group's signature colour; the rotating palette skips those colours */
  fixedColors?: (name: string) => number;
  /** remote names, so `origin/feature` in a commit's decorations is understood as the branch `feature` */
  remotes?: string[];
}

const NO_LANES: MainLane[] = [];

/**
 * Follows the first-parent history of every main branch tip, newest tip first, and returns which
 * commits are on a main line (with the branch's name) plus the line of the topmost tip, which is
 * the "primary" one that can be pinned to the first lane. `tips` are branch names with their commit.
 */
export function findMainLines(commits: Commit[], tips: { name: string; hash: string }[]): { main: Map<string, string>; primary: Set<string> } {
  const byHash = new Map<string, Commit>();
  const index = new Map<string, number>();
  commits.forEach((c, i) => {
    byHash.set(c.hash, c);
    index.set(c.hash, i);
  });
  const ordered = tips.filter((t) => index.has(t.hash)).sort((a, b) => index.get(a.hash)! - index.get(b.hash)!);
  const main = new Map<string, string>();
  let primary = new Set<string>();
  ordered.forEach((tip, n) => {
    const line = new Set<string>();
    let h: string | undefined = tip.hash;
    while (h && byHash.has(h) && !main.has(h)) {
      main.set(h, tip.name);
      line.add(h);
      h = byHash.get(h)!.parents[0];
    }
    if (n === 0) primary = line;
  });
  return { main, primary };
}

/** A stable number for a string, used to give the same branch the same colour every time. */
function hashName(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The branches named in a commit's decorations, local ones first, without any remote prefix. */
export function branchNamesOf(refsRaw: string, remotes: string[]): string[] {
  if (!refsRaw) return [];
  const names: string[] = [];
  for (const l of parseRefs(refsRaw, remotes)) {
    if (l.kind === 'tag' || l.kind === 'head') continue;
    const name = l.kind === 'remote' ? l.name.slice(l.name.indexOf('/') + 1) : l.name;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The branch a merge commit brought in, read from its message ("Merge branch 'x'", "Merge pull request #1 from user/x"). */
export function mergeSourceName(subject: string, remotes: string[]): string | undefined {
  let m = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  if (m) {
    const name = m[1];
    const remote = remotes.find((r) => name.startsWith(r + '/'));
    return remote ? name.slice(remote.length + 1) : name;
  }
  m = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
  return m ? m[1] : undefined;
}

/**
 * One stretch of one lane: from where it appears to where it joins another lane (or the history ends).
 * Colours are handed out once the whole graph is laid out, because an ordinary lane is coloured by the
 * lowest (oldest) branch on it, and that is only known after its last commit has been seen.
 */
interface Run {
  /** palette index; known at once for main lines, filled in afterwards for ordinary lanes */
  color: number;
  /** a main line, which has its branch group's signature colour */
  fixed: boolean;
  /** the row where it appears, and the row where it ends (Infinity while it is still open) */
  start: number;
  end: number;
  /** the branch named on the lowest commit of the run that has a name */
  low?: string;
  /** the branch a merge message names, for a lane none of whose commits carries a branch name */
  fallback?: string;
}

/**
 * Assigns every commit a lane and the line segments to draw in its row.
 * Input must be in topological (children before parents) order, which
 * `git log --date-order` guarantees.
 *
 * Colours: a main line has its branch group's signature colour. Any other lane is coloured from the name
 * of the lowest (oldest) branch on it, so stacking a new branch on top of one leaves its colour alone.
 * Starting from that name's colour, the first one that is clearly different from the lanes running beside
 * it is taken, and a lane with no branch name at all just takes the next colour in turn.
 */
export function computeGraph(commits: Commit[], opts: GraphOptions = {}): GraphData {
  const { main, pin, fixedColors } = opts;
  const remotes = opts.remotes ?? [];
  const lanes: (string | null)[] = [];
  const laneRun: (Run | undefined)[] = [];
  const laneMain: boolean[] = [];
  const laneName: (string | undefined)[] = [];
  const runs: Run[] = []; // in the order they appear
  const pending: { target: { color: number }; run: Run }[] = []; // colours to fill in once every run has one
  let maxLanes = 1;
  let hasMain = false;
  const rows: GraphRow[] = [];
  const byHash = new Map<string, Commit>();
  for (const c of commits) byHash.set(c.hash, c);

  // colours left for ordinary lanes: all of them, or all but the main branches' signature colours
  const reserved = new Set<number>(fixedColors ? MAIN_COLOR_BY_GROUP : []);
  const others = LANE_COLORS.map((_, i) => i).filter((i) => !reserved.has(i));

  const isMain = (h: string) => !!main && main.has(h);
  const newRun = (h: string, start: number, fallback?: string): Run => {
    const fixed = !!(fixedColors && main && main.has(h));
    const run: Run = { color: fixed ? fixedColors!(main!.get(h)!) : -1, fixed, start, end: Infinity, fallback };
    runs.push(run);
    return run;
  };
  /** whatever carries a lane's colour gets it filled in at the end if the lane's colour was not known yet */
  const colored = <T extends { color: number }>(target: T, run: Run): T => {
    if (!run.fixed) pending.push({ target, run });
    return target;
  };
  const nameHint = (c: Commit | undefined) => (c ? branchNamesOf(c.refsRaw, remotes)[0] : undefined);
  // with a pinned line, lane 0 is reserved for it
  const firstFree = (from: number) => {
    let i = from;
    while (i < lanes.length && lanes[i] !== null) i++;
    while (lanes.length <= i) lanes.push(null);
    return i;
  };
  const startFor = (h: string) => (pin && !pin.has(h) ? 1 : 0);

  for (const c of commits) {
    const r = rows.length;
    const before = lanes.slice();
    const waiting: number[] = [];
    before.forEach((h, i) => {
      if (h === c.hash) waiting.push(i);
    });

    // the main lanes entering this row, for the chips above the graph
    let mainLanes = NO_LANES;
    if (main) {
      before.forEach((h, i) => {
        if (h !== null && laneMain[i] && main.has(h)) {
          if (mainLanes === NO_LANES) mainLanes = [];
          const run = laneRun[i]!;
          mainLanes.push(colored({ lane: i, name: main.get(h)!, color: run.color }, run));
        }
      });
    }

    // what the lanes looked like above this row, so the segments entering it keep their old colour and name
    const beforeMain = laneMain.slice();
    const beforeRun = laneRun.slice();
    const beforeName = laneName.slice();

    const own = nameHint(c);
    let col: number;
    // The pinned line always sits in lane 0, even when another lane was waiting for its commit
    // (a feature branch cut from the main tip, a stash): those lanes then curve into lane 0.
    if (pin && pin.has(c.hash) && (waiting.includes(0) || lanes[0] === null || lanes[0] === undefined)) {
      col = 0;
      while (lanes.length === 0) lanes.push(null);
      if (!waiting.includes(0)) {
        laneRun[0] = newRun(c.hash, r);
        laneName[0] = undefined;
      }
    } else if (waiting.length === 0) {
      col = firstFree(startFor(c.hash));
      laneRun[col] = newRun(c.hash, r);
      laneName[col] = undefined;
    } else {
      col = waiting[0];
      // a main commit that lands on an ordinary lane (a feature branch was cut from it) turns it into the main line
      if (isMain(c.hash) && fixedColors) {
        const now = laneRun[col]!;
        if (!now.fixed || now.color !== fixedColors(main!.get(c.hash)!)) {
          now.end = r;
          laneRun[col] = newRun(c.hash, r);
        }
      }
    }
    const run = laneRun[col]!;
    const onMain = isMain(c.hash);
    if (onMain) hasMain = true;
    laneMain[col] = onMain;
    laneName[col] = onMain ? main!.get(c.hash) : (laneName[col] ?? own);
    // the further down the lane, the lower the branch: the last name seen on it is the lowest
    if (!run.fixed) {
      const label = (onMain && main!.get(c.hash)) || own;
      if (label) run.low = label;
    }
    const segs: Seg[] = [];

    before.forEach((h, i) => {
      if (h === null) return;
      const from = beforeRun[i]!;
      if (h === c.hash) segs.push(colored({ x1: i, y1: 0, x2: col, y2: 0.5, color: from.color, main: beforeMain[i], name: beforeName[i] }, from));
      else segs.push(colored({ x1: i, y1: 0, x2: i, y2: 1, color: from.color, main: beforeMain[i], name: beforeName[i] }, from));
    });
    for (const i of waiting) {
      lanes[i] = null;
      if (i !== col) laneRun[i]!.end = r; // joins this commit's lane
    }

    c.parents.forEach((p, k) => {
      const existing = lanes.indexOf(p);
      // A main line keeps going straight down its own lane even when another lane is already waiting for
      // the same parent (a feature branch cut from it). Both lanes then run to that parent and join there.
      const staysStraight = k === 0 && onMain && isMain(p);
      if (existing >= 0 && !staysStraight) {
        const to = laneRun[existing]!;
        segs.push(colored({ x1: col, y1: 0.5, x2: existing, y2: 1, color: to.color, main: onMain && isMain(p), name: laneName[existing] }, to));
      } else if (k === 0) {
        lanes[col] = p;
        segs.push(colored({ x1: col, y1: 0.5, x2: col, y2: 1, color: run.color, main: onMain, name: laneName[col] }, run));
      } else {
        const j = firstFree(startFor(p));
        const parent = byHash.get(p);
        const fallback = mergeSourceName(c.subject, remotes);
        const made = newRun(p, r, fallback);
        laneRun[j] = made;
        lanes[j] = p;
        laneMain[j] = onMain && isMain(p);
        laneName[j] = isMain(p) ? main!.get(p) : (nameHint(parent) ?? fallback);
        segs.push(colored({ x1: col, y1: 0.5, x2: j, y2: 1, color: made.color, main: laneMain[j], name: laneName[j] }, made));
      }
    });
    // this commit's lane ended here if it joined another lane, or the history stops, or another lane took its place
    if (laneRun[col] !== run || lanes[col] == null) run.end = Math.min(run.end, r);

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
    rows.push(
      colored(
        {
          commit: c,
          col,
          color: run.color,
          segs,
          merge: c.parents.length > 1,
          wip: c.hash === WIP_HASH,
          stash: c.stashRef !== undefined,
          main: onMain,
          mainName: main?.get(c.hash),
          branch: laneName[col],
          mainLanes,
        },
        run,
      ),
    );
  }

  // Colour the ordinary lanes, in the order they appeared. A lane takes a colour that stands out from the lanes
  // running beside it, so neighbours do not look alike until the palette runs out. Its start is the colour of
  // its branch's name (so the same branch gets the same colour every time); if none stands out, the closest.
  let nextColor = 0;
  let active: Run[] = [];
  for (const run of runs) {
    active = active.filter((o) => o.end > run.start); // lanes still running where this one begins
    if (!run.fixed) {
      const used = active.map((o) => o.color);
      const hint = run.low ?? run.fallback;
      const start = hint ? hashName(hint) % others.length : nextColor++ % others.length;
      let best = -1;
      let bestApart = -1;
      let chosen = -1;
      for (let k = 0; k < others.length && chosen < 0; k++) {
        const color = others[(start + k) % others.length];
        if (used.includes(color)) continue;
        const apart = used.length ? Math.min(...used.map((u) => colorDistance(color, u))) : Infinity;
        if (apart >= MIN_APART) chosen = color;
        else if (apart > bestApart) {
          bestApart = apart;
          best = color;
        }
      }
      run.color = chosen >= 0 ? chosen : best >= 0 ? best : others[start % others.length];
    }
    active.push(run);
  }
  for (const { target, run } of pending) target.color = run.color;
  return { rows, maxLanes, hasMain };
}

/**
 * Where the tinted band behind main lanes goes in a row: only along the straight stretches of a
 * main line, so it starts at the first commit of the line and stops at its last instead of
 * running past them. `from` / `to` are fractions of the row height.
 */
export function bandSpans(row: GraphRow): { lane: number; from: number; to: number; color: number }[] {
  const out: { lane: number; from: number; to: number; color: number }[] = [];
  for (const s of row.segs) {
    if (!s.main || s.x1 !== s.x2) continue;
    out.push({ lane: s.x1, from: s.y1, to: s.y2, color: s.color });
  }
  return out;
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
