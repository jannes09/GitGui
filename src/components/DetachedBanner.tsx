import { Icon } from '../icons';
import { shortHash } from '../util';

interface Props {
  hash: string;
  /** local branches that point at the commit HEAD is on */
  atHead: string[];
  hasBranches: boolean;
  busy: boolean;
  onCheckout: (branch: string) => void;
  onSwitch: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onCreate: () => void;
}

/** Shown whenever HEAD is not on a branch, with the ways out of that state. */
export function DetachedBanner({ hash, atHead, hasBranches, busy, onCheckout, onSwitch, onCreate }: Props) {
  return (
    <div className="banner" role="status">
      <Icon name="branch" size={15} />
      <span className="banner-text">
        <strong>Detached HEAD</strong> at <code>{shortHash(hash)}</code>. Commits made here don&apos;t belong to any branch.
      </span>
      <span className="banner-actions">
        {atHead.slice(0, 2).map((name) => (
          <button key={name} className="btn small primary" disabled={busy} onClick={() => onCheckout(name)}>
            Checkout {name}
          </button>
        ))}
        {hasBranches && (
          <button className="btn small" disabled={busy} onClick={onSwitch}>
            Switch branch…
          </button>
        )}
        <button className="btn small" disabled={busy} onClick={onCreate}>
          Create branch here
        </button>
      </span>
    </div>
  );
}
