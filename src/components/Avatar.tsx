import { useEffect, useState } from 'react';
import { initials } from '../util';

interface Props {
  username: string | null;
  /** size in CSS pixels */
  size: number;
  /** shows a small green (signed in) or hollow (not signed in) dot; omit for no dot */
  signedIn?: boolean;
  className?: string;
}

// Only well-formed GitHub usernames are ever put in a URL.
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * A GitHub profile picture. GitHub serves it publicly at github.com/<username>.png, so the only
 * thing sent is the public username. If it cannot be loaded (offline, unknown user) the
 * account's initials are shown instead.
 */
export function Avatar({ username, size, signedIn, className }: Props) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [username]);

  const canLoad = !!username && USERNAME_RE.test(username) && !failed;
  return (
    <span className={'gh-avatar ' + (className ?? '')} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
      {canLoad ? (
        <img
          src={`https://github.com/${username}.png?size=${size * 2}`}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        // "demo-alice" reads as DA, not DE: treat hyphens as word breaks
        <span className="gh-initials">{username ? initials(username.replace(/-+/g, ' ')) : '?'}</span>
      )}
      {signedIn !== undefined && <span className={'gh-dot ' + (signedIn ? 'on' : 'off')} title={signedIn ? 'Signed in' : 'Not signed in'} />}
    </span>
  );
}
