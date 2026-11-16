import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { Icon } from '../icons';
import type { DiffTarget } from '../types';

interface Line {
  type: 'ctx' | 'add' | 'del' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}
interface Hunk {
  header: string;
  raw: string[];
  lines: Line[];
}
interface ParsedDiff {
  head: string[];
  hunks: Hunk[];
}

function parseDiff(text: string): ParsedDiff {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const head: string[] = [];
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  for (const row of rows) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (m) {
      cur = { header: row, raw: [row], lines: [] };
      hunks.push(cur);
      o = Number(m[1]);
      n = Number(m[2]);
      continue;
    }
    if (!cur) {
      head.push(row);
      continue;
    }
    cur.raw.push(row);
    const ch = row[0];
    const body = row.slice(1).replace(/\r$/, '');
    if (ch === '+') cur.lines.push({ type: 'add', text: body, newNo: n++ });
    else if (ch === '-') cur.lines.push({ type: 'del', text: body, oldNo: o++ });
    else if (ch === '\\') cur.lines.push({ type: 'meta', text: row });
    else cur.lines.push({ type: 'ctx', text: body, oldNo: o++, newNo: n++ });
  }
  return { head, hunks };
}

interface Props {
  repo: string;
  target: DiffTarget;
  onClose: () => void;
  onChanged: () => void;
  onError: (msg: string) => void;
}

export function DiffView({ repo, target, onClose, onChanged, onError }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setText(await call<string>('diff', { repo, file: target.path, staged: target.staged, untracked: target.untracked, hash: target.hash }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repo, target]);

  useEffect(() => {
    setText(null);
    void load();
  }, [load]);

  const parsed = text ? parseDiff(text) : null;
  const canStageHunks = !target.hash && !target.untracked;

  const applyHunk = async (h: Hunk) => {
    if (!parsed) return;
    const patch = [...parsed.head, ...h.raw].join('\n') + '\n';
    try {
      await call('applyPatch', { repo, patch, reverse: !!target.staged });
      onChanged();
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const empty = text !== null && !error && (!parsed || parsed.hunks.length === 0);

  return (
    <div className="diff">
      <div className="diff-head">
        <button className="btn ghost" onClick={onClose}>
          <Icon name="back" size={14} /> Back to graph
        </button>
        <span className="diff-path">{target.path}</span>
        <span className="diff-tag">{target.hash ? 'Commit' : target.staged ? 'Staged' : target.untracked ? 'New file' : 'Unstaged'}</span>
      </div>
      <div className="diff-body">
        {error && <div className="diff-msg error">{error}</div>}
        {!error && text === null && <div className="diff-msg">Loading…</div>}
        {empty && <div className="diff-msg">{text && text.trim() && !text.startsWith('diff') ? text : 'No textual changes to show.'}</div>}        {parsed?.hunks.map((h, hi) => (
          <div className="hunk" key={hi}>
            <div className="hunk-head">
              <span>{h.header}</span>
              {canStageHunks && (
                <button className="btn small" onClick={() => applyHunk(h)}>
                  {target.staged ? 'Unstage hunk' : 'Stage hunk'}
                </button>
              )}
            </div>
            {h.lines.map((l, li) => (
              <div className={'dl ' + l.type} key={li}>
                <span className="ln">{l.oldNo ?? ''}</span>
                <span className="ln">{l.newNo ?? ''}</span>
                <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ''}</span>
                <span className="code">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
