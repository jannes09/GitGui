import { useState } from 'react';
import { Icon } from '../icons';
import type { AccountProfile, AccountsData, ActiveAccount } from '../types';
import { Avatar } from './Avatar';

interface Props {
  data: AccountsData;
  active: ActiveAccount | null;
  /** set while a browser sign-in (or similar slow step) is in progress */
  busy: string | null;
  /** resolves to an error message, or null when saved */
  onSave: (p: AccountProfile) => Promise<string | null>;
  onRemove: (username: string) => void;
  onUse: (username: string, scope: 'local' | 'global') => void;
  onSignIn: (username: string) => void;
  onSignOut: (username: string) => void;
  onClose: () => void;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function AccountsDialog({ data, active, busy, onSave, onRemove, onUse, onSignIn, onSignOut, onClose }: Props) {
  const empty = data.profiles.length === 0;
  const [form, setForm] = useState<AccountProfile>({
    username: '',
    name: empty ? data.suggestion.name : '',
    email: empty ? data.suggestion.email : '',
  });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof AccountProfile) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
    setError(null);
  };

  const save = async () => {
    const err = await onSave({ username: form.username.trim(), name: form.name.trim(), email: form.email.trim() });
    setError(err);
    if (!err) {
      setForm({ username: '', name: '', email: '' });
      setEditing(false);
    }
  };

  const signedIn = (u: string) => data.gcm.accounts.some((a) => same(a, u));

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="GitHub accounts"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <div className="modal-head">
          <h3>GitHub accounts</h3>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="modal-text small">
          Each account sets who your commits are made as and which GitHub sign-in this repository uses. Passwords and tokens are
          kept by Git Credential Manager, never by this app.
        </p>
        {!data.gcm.available && (
          <p className="notice warn">
            Git Credential Manager was not found. Switching still changes the commit identity, but sign-ins must be done with git
            in a terminal.
          </p>
        )}
        {busy && <p className="notice">{busy}</p>}

        <div className="acct-list">
          {data.profiles.length === 0 && <div className="rp-none">No accounts yet. Add one below.</div>}
          {data.profiles.map((p) => {
            const isActive = !!active?.username && same(active.username, p.username);
            const isIn = signedIn(p.username);
            return (
              <div key={p.username} className={'acct-row' + (isActive ? ' active' : '')}>
                <Avatar username={p.username} size={32} signedIn={data.gcm.available ? isIn : undefined} />
                <div className="acct-info">
                  <div className="acct-name">
                    {p.username}
                    {isActive && <span className="tag good">{active?.scope === 'global' ? 'default' : 'this repository'}</span>}
                    {data.gcm.available && <span className={'tag ' + (isIn ? 'good' : 'warn')}>{isIn ? 'signed in' : 'not signed in'}</span>}
                  </div>
                  <div className="acct-sub">
                    {p.name} &lt;{p.email}&gt;
                  </div>
                </div>
                <div className="acct-actions">
                  <button className="btn small" disabled={!!busy || isActive} onClick={() => onUse(p.username, 'local')}>
                    Use here
                  </button>
                  <button className="btn small" disabled={!!busy} onClick={() => onUse(p.username, 'global')} title="Use for every repository that has no account of its own">
                    Make default
                  </button>
                  {data.gcm.available &&
                    (isIn ? (
                      <button className="btn small" disabled={!!busy} onClick={() => onSignOut(p.username)}>
                        Sign out
                      </button>
                    ) : (
                      <button className="btn small primary" disabled={!!busy} onClick={() => onSignIn(p.username)}>
                        Sign in
                      </button>
                    ))}
                  <button
                    className="btn small"
                    disabled={!!busy}
                    onClick={() => {
                      setForm(p);
                      setEditing(true);
                      setError(null);
                    }}
                  >
                    Edit
                  </button>
                  <button className="btn small danger" disabled={!!busy} onClick={() => onRemove(p.username)}>
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="acct-form" onKeyDown={(e) => e.key === 'Enter' && !busy && void save()}>
          <h4>{editing ? 'Edit account' : 'Add an account'}</h4>
          <div className="form-grid">
            <label>
              GitHub username
              <input value={form.username} onChange={set('username')} readOnly={editing} placeholder="octocat" autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Name on commits
              <input value={form.name} onChange={set('name')} placeholder="The Octocat" autoComplete="off" />
            </label>
            <label>
              Email on commits
              <input value={form.email} onChange={set('email')} placeholder="octocat@example.com" autoComplete="off" spellCheck={false} />
            </label>
          </div>
          {error && <p className="notice error">{error}</p>}
          <div className="modal-actions">
            {editing && (
              <button
                className="btn"
                onClick={() => {
                  setEditing(false);
                  setForm({ username: '', name: '', email: '' });
                  setError(null);
                }}
              >
                Cancel edit
              </button>
            )}
            <button className="btn primary" disabled={!!busy || !form.username.trim()} onClick={() => void save()}>
              {editing ? 'Save changes' : 'Add account'}
            </button>
          </div>
          <p className="modal-text small">
            Tip: to keep your real address private on GitHub, use your <code>…@users.noreply.github.com</code> address from GitHub
            settings → Emails.
          </p>
        </div>
      </div>
    </div>
  );
}
