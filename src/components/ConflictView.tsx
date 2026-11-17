import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { compose, conflictCount, hasMarkers, parseConflicts, type ParsedFile, type Pick } from '../conflicts';
import { Icon } from '../icons';
import type { ConflictFileInfo } from '../types';

interface Props {
  repo: string;
  path: string;
  onClose: () => void;
  /** called after the file was resolved and staged */
  onResolved: (path: string) => void;
  onError: (message: string) => void;
}

const COLLAPSE_OVER = 8; // unchanged stretches longer than this are folded
const CONTEXT = 3;
const PREVIEW_LINES = 200;

const bare = (line: string) => line.replace(/\r$/, '');
const NONE: Pick = { ours: false, theirs: false };

function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <div className="cf-empty">(nothing on this side)</div>;
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className="cf-line">
          {bare(l) || ' '}
        </div>
      ))}
    </>
  );
}

/** A stretch of the file outside any conflict, folded when it is long. */
function Context({ lines, first, last, open, onOpen }: { lines: string[]; first: boolean; last: boolean; open: boolean; onOpen: () => void }) {
  if (open || lines.length <= COLLAPSE_OVER) {
    return (
      <div className="cf-text">
        <Lines lines={lines} />
      </div>
    );
  }
  const head = first ? [] : lines.slice(0, CONTEXT);
  const tail = last ? [] : lines.slice(-CONTEXT);
  const hidden = lines.length - head.length - tail.length;
  return (
    <div className="cf-text">
      <Lines lines={head} />
      <button className="cf-fold" onClick={onOpen}>
        <Icon name="down" size={12} /> Show {hidden} unchanged line{hidden === 1 ? '' : 's'}
      </button>
      <Lines lines={tail} />
    </div>
  );
}

function describe(info: ConflictFileInfo): string {
  if (info.hasBase && !info.hasOurs && info.hasTheirs) return 'This file was deleted on our side (HEAD), but the other side changed it.';
  if (info.hasBase && info.hasOurs && !info.hasTheirs) return 'This file was deleted on the other side, but we changed it.';
  if (!info.hasBase && info.hasOurs && !info.hasTheirs) return 'This file only exists on our side (HEAD).';
  if (!info.hasBase && !info.hasOurs && info.hasTheirs) return 'This file only exists on the other side.';
  if (!info.hasOurs && !info.hasTheirs) return 'This file was deleted on both sides.';
  if (info.binary) return 'This is a binary file, so it cannot be merged line by line. Choose which version to keep.';
  if (info.tooLarge) return 'This file is too large to merge here. Choose which version to keep, or resolve it in an editor.';
  if (info.lossy) return 'This file is not UTF-8 text, so editing it here could damage it. Choose which version to keep, or resolve it in an editor.';
  return 'Choose which version to keep.';
}

export function ConflictView({ repo, path, onClose, onResolved, onError }: Props) {
  const [info, setInfo] = useState<ConflictFileInfo | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [manual, setManual] = useState<string | null>(null); // text typed by hand replaces the block choices
  const [mode, setMode] = useState<'blocks' | 'text'>('blocks');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [working, setWorking] = useState(false);
  const [cursor, setCursor] = useState(-1); // the conflict the arrows last jumped to

  useEffect(() => {
    let live = true;
    setInfo(null);
    setCursor(-1);
    setManual(null);
    setMode('blocks');
    setOpen(new Set());
    call<ConflictFileInfo>('conflictFile', { repo, file: path })
      .then((i) => live && setInfo(i))
      .catch((e: Error) => {
        if (!live) return;
        onError(e.message);
        onClose();
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, path]);

  const textual = !!info && info.hasOurs && info.hasTheirs && info.content !== null;
  const parsed: ParsedFile | null = useMemo(() => (textual && info?.content != null ? parseConflicts(info.content) : null), [textual, info]);
  const total = parsed ? conflictCount(parsed) : 0;

  useEffect(() => setPicks(Array.from({ length: total }, () => ({ ...NONE }))), [total, parsed]);

  const result = manual ?? (parsed ? compose(parsed, picks) : '');
  const resolvedCount = picks.filter((p) => p.ours || p.theirs).length;

  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await fn();
      onResolved(path);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const wholeFile = (action: 'ours' | 'theirs' | 'keep' | 'delete') => run(() => call('conflictResolve', { repo, file: path, action }));

  const markResolved = () => {
    if (hasMarkers(result) && !window.confirm('Some conflict markers (<<<<<<< or >>>>>>>) are still in the file. Mark it as resolved anyway?')) return;
    void run(() => call('conflictSave', { repo, file: path, content: result }));
  };

  const toggle = (i: number, side: keyof Pick) => setPicks((p) => p.map((x, j) => (j === i ? { ...x, [side]: !x[side] } : x)));
  const chooseAll = (side: 'ours' | 'theirs') => setPicks((p) => p.map(() => ({ ours: side === 'ours', theirs: side === 'theirs' })));

  const jump = (dir: 1 | -1) => {
    if (total === 0) return;
    const next = (cursor + dir + total) % total;
    setCursor(next);
    document.querySelectorAll<HTMLElement>('.cf-block')[next]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const backToBlocks = () => {
    if (manual !== null && !window.confirm('Go back to the block view? Text you typed by hand will be discarded.')) return;
    setManual(null);
    setMode('blocks');
  };

  const reset = () => {
    setManual(null);
    setPicks(Array.from({ length: total }, () => ({ ...NONE })));
  };

  const header = (
    <div className="diff-head">
      <span className="diff-path" title={path}>
        {path}
      </span>
      <span className="diff-tag cf-tag">Conflict</span>
      <button className="icon-btn" onClick={onClose} title="Back to the graph (Esc)" aria-label="Back to the graph">
        <Icon name="close" size={16} />
      </button>
    </div>
  );

  if (!info) {
    return (
      <div className="diff">
        {header}
        <div className="diff-msg">Loading…</div>
      </div>
    );
  }

  // Block-by-block merging needs real text with both sides present and well-formed markers.
  const mergeable = textual && parsed !== null && total > 0;
  const markersGone = textual && parsed !== null && total === 0;

  if (!textual || (!mergeable && !markersGone)) {
    const removable = !info.hasOurs || !info.hasTheirs;
    const preview = info.content !== null ? info.content.split('\n').slice(0, PREVIEW_LINES) : null;
    return (
      <div className="diff">
        {header}
        <div className="diff-body cf-body">
          <div className="notice warn">
            {describe(info)}
            {textual && parsed === null && ' The conflict markers in the file are damaged, so it cannot be shown block by block.'}
          </div>
          <div className="cf-actions">
            {info.hasOurs && info.hasTheirs && (
              <>
                <button className="btn" disabled={working} onClick={() => void wholeFile('ours')}>
                  Use our version
                </button>
                <button className="btn" disabled={working} onClick={() => void wholeFile('theirs')}>
                  Use their version
                </button>
              </>
            )}
            {removable && info.exists && (
              <button className="btn primary" disabled={working} onClick={() => void wholeFile('keep')}>
                Keep the file
              </button>
            )}
            {removable && (
              <button className="btn danger" disabled={working} onClick={() => void wholeFile('delete')}>
                Delete the file
              </button>
            )}
            {textual && parsed === null && (
              <button className="btn" disabled={working} onClick={() => void wholeFile('keep')} title="Stage the file exactly as it is on disk">
                Mark resolved as it is on disk
              </button>
            )}
          </div>
          {preview && (
            <>
              <div className="cf-label">{info.exists ? 'File on disk' : ''}</div>
              <pre className="cf-preview">{preview.join('\n')}</pre>
            </>
          )}
        </div>
      </div>
    );
  }

  const segs = parsed!.segments;
  let ci = -1;

  return (
    <div className="diff cf">
      {header}
      <div className="cf-bar">
        <span className="cf-progress">
          {total === 0 ? 'No conflict markers left' : `${resolvedCount} of ${total} conflict${total === 1 ? '' : 's'} resolved`}
        </span>
        {mode === 'blocks' && total > 0 && (
          <>
            <button className="btn small" onClick={() => jump(-1)} title="Previous conflict">
              ↑
            </button>
            <button className="btn small" onClick={() => jump(1)} title="Next conflict">
              ↓
            </button>
            <button className="btn small" onClick={() => chooseAll('ours')}>
              All ours
            </button>
            <button className="btn small" onClick={() => chooseAll('theirs')}>
              All theirs
            </button>
          </>
        )}
        <button className="btn small ghost" onClick={reset} disabled={manual === null && resolvedCount === 0}>
          Reset
        </button>
        <span className="cf-spacer" />
        {mode === 'blocks' ? (
          <button className="btn small" onClick={() => setMode('text')}>
            Edit result
          </button>
        ) : (
          <button className="btn small" onClick={backToBlocks}>
            Block view
          </button>
        )}
        <button className="btn small primary" disabled={working} onClick={markResolved} title="Save the result and stage the file">
          Mark resolved
        </button>
      </div>

      {mode === 'text' ? (
        <textarea
          className="cf-editor"
          spellCheck={false}
          value={result}
          onChange={(e) => setManual(e.target.value)}
          aria-label="Resolved file contents"
        />
      ) : (
        <div className="diff-body cf-body">
          {segs.map((s, si) => {
            if (s.kind === 'text') {
              return <Context key={si} lines={s.lines} first={si === 0} last={si === segs.length - 1} open={open.has(si)} onOpen={() => setOpen((o) => new Set(o).add(si))} />;
            }
            const i = ++ci;
            const p = picks[i] ?? NONE;
            const state = p.ours && p.theirs ? 'Both kept: ours first, then theirs' : p.ours ? 'Keeping ours' : p.theirs ? 'Keeping theirs' : 'Not resolved: pick a side';
            return (
              <div key={si} className={'cf-block' + (p.ours || p.theirs ? ' done' : '')}>
                <div className="cf-cols">
                  <div className={'cf-side ours' + (p.ours ? ' on' : '')}>
                    <label className="cf-check">
                      <input type="checkbox" checked={p.ours} onChange={() => toggle(i, 'ours')} />
                      <strong>Ours</strong>
                      <span className="dim" title={s.oursLabel}>
                        {s.oursLabel}
                      </span>
                    </label>
                    <div className="cf-code">
                      <Lines lines={s.ours} />
                    </div>
                  </div>
                  <div className={'cf-side theirs' + (p.theirs ? ' on' : '')}>
                    <label className="cf-check">
                      <input type="checkbox" checked={p.theirs} onChange={() => toggle(i, 'theirs')} />
                      <strong>Theirs</strong>
                      <span className="dim" title={s.theirsLabel}>
                        {s.theirsLabel}
                      </span>
                    </label>
                    <div className="cf-code">
                      <Lines lines={s.theirs} />
                    </div>
                  </div>
                </div>
                <div className="cf-foot">{state}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
