// Reads the conflict markers git writes into a file and puts a file back together from the
// choices the user makes. Pure functions, covered by test/conflicts.test.mjs.

export interface TextSegment {
  kind: 'text';
  lines: string[];
}
export interface ConflictSegment {
  kind: 'conflict';
  ours: string[];
  theirs: string[];
  /** the common ancestor's lines; only present when git wrote them (merge.conflictStyle=diff3) */
  base: string[] | null;
  oursLabel: string;
  theirsLabel: string;
}
export type Segment = TextSegment | ConflictSegment;

export interface ParsedFile {
  segments: Segment[];
  /** whether the file ended with a line break, so it can be written back the same way */
  finalNewline: boolean;
}

/** Which sides of a conflict go into the result. Neither means it is still unresolved. */
export interface Pick {
  ours: boolean;
  theirs: boolean;
}

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const MID = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

/** Returns null when the markers are not well formed (stray, nested or unterminated). */
export function parseConflicts(text: string): ParsedFile | null {
  const finalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (finalNewline) lines.pop();

  const segments: Segment[] = [];
  let plain: string[] = [];
  let cur: ConflictSegment | null = null;
  let part: 'ours' | 'base' | 'theirs' = 'ours';

  for (const line of lines) {
    const bare = line.replace(/\r$/, ''); // files with Windows line endings still carry the \r
    if (!cur) {
      const m = START.exec(bare);
      if (!m) {
        plain.push(line);
        continue;
      }
      if (plain.length) segments.push({ kind: 'text', lines: plain });
      plain = [];
      cur = { kind: 'conflict', ours: [], theirs: [], base: null, oursLabel: m[1] ?? '', theirsLabel: '' };
      part = 'ours';
      continue;
    }
    if (START.test(bare)) return null; // a conflict inside a conflict
    let m: RegExpExecArray | null;
    if (part === 'ours' && (m = BASE.exec(bare))) {
      cur.base = [];
      part = 'base';
    } else if (part !== 'theirs' && MID.test(bare)) {
      part = 'theirs';
    } else if (part === 'theirs' && (m = END.exec(bare))) {
      cur.theirsLabel = m[1] ?? '';
      segments.push(cur);
      cur = null;
    } else if (BASE.test(bare) || MID.test(bare) || END.test(bare)) {
      return null; // markers out of order
    } else {
      (part === 'ours' ? cur.ours : part === 'base' ? (cur.base as string[]) : cur.theirs).push(line);
    }
  }
  if (cur) return null; // ran off the end of the file inside a conflict
  if (plain.length) segments.push({ kind: 'text', lines: plain });
  return { segments, finalNewline };
}

export function conflictCount(parsed: ParsedFile): number {
  return parsed.segments.filter((s) => s.kind === 'conflict').length;
}

/** The lines a conflict contributes for a choice. Both sides keep "ours" first. */
export function chosenLines(c: ConflictSegment, pick: Pick): string[] {
  if (pick.ours && pick.theirs) return [...c.ours, ...c.theirs];
  if (pick.ours) return c.ours;
  if (pick.theirs) return c.theirs;
  return [
    `<<<<<<< ${c.oursLabel}`.trimEnd(),
    ...c.ours,
    ...(c.base ? [`||||||| base`, ...c.base] : []),
    '=======',
    ...c.theirs,
    `>>>>>>> ${c.theirsLabel}`.trimEnd(),
  ];
}

/** `picks[i]` belongs to the i-th conflict in the file. */
export function compose(parsed: ParsedFile, picks: Pick[]): string {
  const out: string[] = [];
  let i = 0;
  for (const s of parsed.segments) {
    if (s.kind === 'text') out.push(...s.lines);
    else out.push(...chosenLines(s, picks[i++] ?? { ours: false, theirs: false }));
  }
  if (out.length === 0) return '';
  return out.join('\n') + (parsed.finalNewline ? '\n' : '');
}

/**
 * True when the text still has "<<<<<<<" or ">>>>>>>" marker lines. A lone "=======" is not
 * counted: Markdown headings use it legitimately.
 */
export function hasMarkers(text: string): boolean {
  return text.split('\n').some((l) => {
    const bare = l.replace(/\r$/, '');
    return START.test(bare) || END.test(bare);
  });
}
