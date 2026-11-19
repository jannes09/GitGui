// Decides how many branch / tag pills fit in the graph's BRANCH / TAG column and how to shorten
// them so they stay readable. Pure functions, covered by test/reflabels.test.mjs.

/** Rough width of one character of the pill font (12px, semi-bold). Only used to plan; CSS still clips. */
export const CHAR_W = 6.9;
/** Padding, border and gap of a pill, without its text or icons. */
export const PILL_CHROME = 18;
export const PILL_GAP = 4;
/** Width reserved for the "+N" pill that stands in for hidden labels. */
export const OVERFLOW_W = 34;

/**
 * Turns a list like "main, dev, release/*" (commas, spaces or new lines between names; `*` matches
 * anything) into a test for a branch name without its remote prefix. Names are matched whole and
 * ignoring case, so `dev` does not match `devops` or `feature/dev`.
 */
export function branchMatcher(list: string): (shortName: string) => boolean {
  const patterns = list
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
  if (patterns.length === 0) return () => false;
  return (name) => patterns.some((re) => re.test(name));
}

/** Which signature colour a main branch gets: 0 = dev branches, 1 = main / master, 2 = anything else. */
export function branchGroup(shortName: string): 0 | 1 | 2 {
  const n = shortName.toLowerCase();
  if (n === 'dev' || n === 'develop' || n === 'development') return 0;
  if (n === 'main' || n === 'master' || n === 'trunk') return 1;
  return 2;
}

/**
 * Sort key for the pills on a commit, lowest first: the checked-out branch, then the main
 * branches (local before remote), then other local branches, then remote-only ones, then tags.
 * `shortName` is the branch name without its remote prefix.
 */
export function labelRank(kind: 'branch' | 'remote' | 'tag' | 'head', current: boolean, shortName: string, isMain: (name: string) => boolean): number {
  if (current || kind === 'head') return 0;
  if (kind === 'tag') return 4;
  if (isMain(shortName)) return kind === 'remote' ? 1.5 : 1;
  return kind === 'remote' ? 3 : 2;
}

export interface FitItem {
  /** the text to show when there is room for all of it */
  text: string;
  /** width of the icons and badges inside the pill, besides its text */
  extra: number;
}
export interface Fitted<T extends FitItem> {
  item: T;
  /** the text to display: the full text, or a shortened form when space is tight */
  text: string;
  shortened: boolean;
}
export interface FitResult<T extends FitItem> {
  shown: Fitted<T>[];
  hidden: T[];
}

/**
 * Keeps the start and the end of a branch name, because the end is usually what tells branches apart:
 * `feature/WF/Scheduler-rewrite` becomes `feature/…/Scheduler-rewrite`, and if that is still too long
 * the middle of it is cut: `feature/…/Schedu…ewrite`.
 */
export function shortenRef(name: string, max: number): string {
  const limit = Math.max(4, Math.floor(max));
  if (name.length <= limit) return name;
  const parts = name.split('/');
  if (parts.length > 2) {
    const compact = `${parts[0]}/…/${parts[parts.length - 1]}`;
    if (compact.length <= limit) return compact;
    const leaf = parts[parts.length - 1];
    // the whole last part is worth more than the folder hint in front of it
    if (leaf.length + 2 <= limit) return `…/${leaf}`;
    const head = `${parts[0]}/…/`;
    // keep the folder hint if there is room for a useful part of the leaf as well
    if (head.length + 8 <= limit) return head + middle(leaf, limit - head.length);
  }
  return middle(name, limit);
}

/** `abcdefghij` -> `abc…hij`: cuts the middle so both ends stay visible. */
function middle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(2, max - 1);
  const tail = Math.floor(keep * 0.55);
  const head = keep - tail;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

export function pillWidth(item: FitItem, text = item.text): number {
  return PILL_CHROME + item.extra + text.length * CHAR_W;
}

/**
 * Chooses which pills to show, in the order given (most important first). Pills are shown in full while
 * they fit; the ones that do not fit are replaced by a single "+N" pill. If even the first pill is too
 * wide on its own it is shortened rather than dropped, so a row always shows something.
 */
export function fitLabels<T extends FitItem>(items: T[], available: number): FitResult<T> {
  const shown: Fitted<T>[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const gap = shown.length ? PILL_GAP : 0;
    const reserve = i < items.length - 1 ? OVERFLOW_W + PILL_GAP : 0; // room for "+N" if more follow
    if (used + gap + pillWidth(item) <= available - reserve) {
      shown.push({ item, text: item.text, shortened: false });
      used += gap + pillWidth(item);
    } else break;
  }
  if (shown.length === 0 && items.length > 0) {
    const first = items[0];
    const reserve = items.length > 1 ? OVERFLOW_W + PILL_GAP : 0;
    const chars = Math.floor((available - reserve - PILL_CHROME - first.extra) / CHAR_W);
    shown.push({ item: first, text: shortenRef(first.text, chars), shortened: true });
  }
  return { shown, hidden: items.slice(shown.length) };
}
