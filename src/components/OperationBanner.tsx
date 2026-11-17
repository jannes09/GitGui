import { Icon } from '../icons';
import type { Operation } from '../types';

interface Props {
  operation: Operation;
  /** files that still have conflicts */
  remaining: number;
  busy: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}

const NAMES: Record<Operation['kind'], { title: string; verb: string }> = {
  merge: { title: 'Merge', verb: 'merge' },
  'cherry-pick': { title: 'Cherry-pick', verb: 'cherry-pick' },
  revert: { title: 'Revert', verb: 'revert' },
  rebase: { title: 'Rebase', verb: 'rebase' },
};

/** Shown while a merge, cherry-pick, revert or rebase is stopped and waiting for the user. */
export function OperationBanner({ operation, remaining, busy, onContinue, onSkip, onAbort }: Props) {
  const n = NAMES[operation.kind];
  const done = remaining === 0;
  const detail = operation.kind === 'merge' ? operation.detail.replace(/^Merge /, '') : operation.detail;
  return (
    <div className="banner conflict" role="status">
      <Icon name="warn" size={15} />
      <span className="banner-text">
        <strong>{n.title} in progress</strong>
        {detail && <span className="dim"> · {detail}</span>}
        {' — '}
        {done ? 'all conflicts are resolved. Continue to finish.' : `${remaining} file${remaining === 1 ? ' has' : 's have'} conflicts to resolve.`}
      </span>
      <span className="banner-actions">
        <button className="btn small primary" disabled={busy || !done} onClick={onContinue} title={done ? undefined : 'Resolve every conflicted file first'}>
          Continue {n.verb}
        </button>
        {operation.kind !== 'merge' && (
          <button className="btn small" disabled={busy} onClick={onSkip} title="Drop this commit and carry on">
            Skip commit
          </button>
        )}
        <button className="btn small danger" disabled={busy} onClick={onAbort}>
          Abort {n.verb}
        </button>
      </span>
    </div>
  );
}
