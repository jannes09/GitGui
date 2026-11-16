// Intra-line ("word") diff used to highlight exactly what changed inside a
// modified line. Kept free of imports and enums so tests can load it directly.

export interface Seg {
  text: string;
  changed: boolean;
}

const TOKEN = /\w+|\s+|[^\w\s]/gu;
const MAX_TOKENS = 400;
const MIN_SIMILARITY = 0.4;

/**
 * Compares two lines token by token. Returns the segments of each line with
 * the changed parts flagged, or null when the lines are too different (or too
 * long) for word-level highlighting to be useful.
 */
export function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  const n = ta.length;
  const m = tb.length;
  if (n === 0 || m === 0 || n > MAX_TOKENS || m > MAX_TOKENS) return null;

  // longest common subsequence of tokens
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const outA: Seg[] = [];
  const outB: Seg[] = [];
  const push = (out: Seg[], text: string, changed: boolean) => {
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text;
    else out.push({ text, changed });
  };
  let sharedWords = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      if (ta[i].trim() !== '') sharedWords++;
      push(outA, ta[i++], false);
      push(outB, tb[j++], false);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(outA, ta[i++], true);
    } else {
      push(outB, tb[j++], true);
    }
  }
  while (i < n) push(outA, ta[i++], true);
  while (j < m) push(outB, tb[j++], true);

  // judge similarity on real tokens only: shared spaces must not make unrelated lines look alike
  const words = (t: string[]) => t.filter((x) => x.trim() !== '').length;
  if (sharedWords / Math.max(words(ta), words(tb), 1) < MIN_SIMILARITY) return null;

  return { a: trimEdges(bridge(outA)), b: trimEdges(bridge(outB)) };
}

/** Highlights should not start or end on a space; give those spaces back to the unchanged text. */
function trimEdges(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  const add = (text: string, changed: boolean) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text;
    else out.push({ text, changed });
  };
  for (const s of segs) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)!;
    if (!s.changed || m[2] === '') {
      add(s.text, s.changed); // unchanged text, or a change that is only whitespace, stays as is
    } else {
      add(m[1], false);
      add(m[2], true);
      add(m[3], false);
    }
  }
  return out;
}

/** A lone space between two changed runs reads better as part of the change. */
function bridge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  segs.forEach((s, idx) => {
    const between = !s.changed && s.text.trim() === '' && segs[idx - 1]?.changed && segs[idx + 1]?.changed;
    const seg = between ? { text: s.text, changed: true } : s;
    const last = out[out.length - 1];
    if (last && last.changed === seg.changed) last.text += seg.text;
    else out.push({ ...seg });
  });
  return out;
}
