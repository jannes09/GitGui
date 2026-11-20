import { useEffect, useRef } from 'react';
import { isElectron, pickFolder } from '../api';
import { DEFAULT_MAIN_BRANCHES, DEFAULT_SETTINGS, type Settings } from '../settings';
import type { UpdateInfo } from '../types';
import { APP_VERSION } from '../version';
import { Icon } from '../icons';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  /** the latest look in the update folder, if there was one */
  update: UpdateInfo | null;
  checkingUpdate: boolean;
  onCheckUpdate: () => void;
}

type FlagKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function Toggle({ settings, onChange, name, label, hint }: { settings: Settings; onChange: Props['onChange']; name: FlagKey; label: string; hint?: string }) {
  return (
    <label className="set-row">
      <input type="checkbox" checked={settings[name]} onChange={(e) => onChange({ [name]: e.target.checked })} />
      <span className="set-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

/** All the switches in one place. Changes apply straight away, so the graph behind the dialog shows the effect. */
export function SettingsDialog({ settings, onChange, onClose, update, checkingUpdate, onCheckUpdate }: Props) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus({ preventScroll: true }), []); // the dialog opens at its top, not scrolled down to Done
  const t = { settings, onChange };

  const browse = async () => {
    const dir = await pickFolder('Folder with the newer GitGui installer');
    if (dir) onChange({ updateFolder: dir });
  };
  let status: { text: string; tone: '' | 'ok' | 'bad' } | null = null;
  if (checkingUpdate) status = { text: 'Looking…', tone: '' };
  else if (update?.error) status = { text: update.error, tone: 'bad' };
  else if (update?.available) status = { text: `Version ${update.latest} is available (you have ${update.current}).`, tone: 'ok' };
  else if (update) status = { text: `You have the newest version, ${update.current}. The folder holds ${update.latest}.`, tone: '' };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal wide settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="modal-head">
          <h3>
            Settings <span className="set-version">GitGui {APP_VERSION}</span>
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <Icon name="close" size={14} />
          </button>
        </div>

        <h4 className="set-title">Graph: main lanes</h4>
        <p className="modal-text small">
          Make the lanes of your main branches (dev, main, master, release…) easy to follow. Each part works on its own, so try them one by one.
        </p>

        <div className="set-group">
          <div className="set-name">1 · Bold main lanes</div>
          <Toggle {...t} name="laneBold" label="Draw main lanes thicker, with bigger commit dots" />
        </div>
        <div className="set-group">
          <div className="set-name">2 · Pin to the left</div>
          <Toggle {...t} name="lanePin" label="Keep the main branch in the first lane" hint="It stays one straight column on the far left; feature branches never push it aside." />
        </div>
        <div className="set-group">
          <div className="set-name">3 · Band and bold text</div>
          <Toggle {...t} name="laneBand" label="Tint a soft band behind the main lanes" />
          <Toggle {...t} name="boldMessages" label="Show commit messages on the main line in bold" />
        </div>
        <div className="set-group">
          <div className="set-name">4 · Colour and labels</div>
          <Toggle {...t} name="fixedColors" label="Give main branches a fixed colour" hint="dev is always teal, main / master gold, other main branches purple. Feature branches use the remaining colours." />
          <Toggle {...t} name="laneChips" label="Pin a branch name chip to the top of each main lane" />
        </div>

        <div className="set-group">
          <div className="set-name">Which branches count as main branches</div>
          <input
            className="set-input"
            value={settings.mainBranches}
            spellCheck={false}
            placeholder={DEFAULT_MAIN_BRANCHES}
            onChange={(e) => onChange({ mainBranches: e.target.value })}
            aria-label="Main branch names"
          />
          <small className="set-hint">
            Names separated by commas, <code>*</code> matches anything (<code>release/*</code>). Whole names only and capitals do not matter, so{' '}
            <code>dev</code> does not match <code>devops</code>. This also decides which branch pills come first.
          </small>
          <button className="btn small" disabled={settings.mainBranches === DEFAULT_MAIN_BRANCHES} onClick={() => onChange({ mainBranches: DEFAULT_MAIN_BRANCHES })}>
            Reset the list
          </button>
        </div>

        <h4 className="set-title">Pull requests</h4>
        <div className="set-group">
          <Toggle
            {...t}
            name="prLookups"
            label="Look up open pull requests on GitHub and Azure DevOps"
            hint="Read only. Uses the login Git Credential Manager already holds for that host, and only talks to the host's own API. Turn off to stop all lookups; badges and the PR button then disappear."
          />
        </div>

        <h4 className="set-title">Profile pictures</h4>
        <div className="set-group">
          <Toggle
            {...t}
            name="profilePictures"
            label="Show GitHub profile pictures on commits"
            hint="For authors who commit with a GitHub no-reply address (…@users.noreply.github.com) and for your saved accounts. Only the public username is sent, to github.com. Everyone else keeps their initials."
          />
          <Toggle
            {...t}
            name="gravatarLookups"
            label="Also look authors up on Gravatar"
            hint="Finds a picture for any author who has set one up, but sends a hash of each author's email address to gravatar.com, which can tell which addresses appear in your history. Off unless you switch it on."
          />
        </div>

        <h4 className="set-title">Updates</h4>
        <div className="set-group">
          <Toggle
            {...t}
            name="updateCheck"
            label="Look for a newer version when GitGui starts, and ask whether to install it"
            hint="Nothing is downloaded. It only looks at a folder on this computer, by default the release folder this version was built in."
          />
          <div className="set-name">Update folder</div>
          <div className="set-folder">
            <input
              className="set-input"
              value={settings.updateFolder}
              spellCheck={false}
              placeholder="Default: the release folder this version was built in"
              onChange={(e) => onChange({ updateFolder: e.target.value })}
              aria-label="Update folder"
            />
            {isElectron && (
              <button className="btn" onClick={() => void browse()}>
                Browse…
              </button>
            )}
          </div>
          <small className="set-hint">
            It needs the <code>latest.yml</code> and <code>GitGui-Setup-&lt;version&gt;.exe</code> that <code>npm run dist:installer</code> writes. A build counts as newer when its version number is higher than this one's, so raise{' '}
            <code>version</code> in <code>package.json</code> before building.
          </small>
          <button className="btn" disabled={checkingUpdate} onClick={onCheckUpdate}>
            Check now
          </button>
          {status && (
            <p className={'set-status' + (status.tone ? ` ${status.tone}` : '')} role="status">
              {status.text}
            </p>
          )}
          {settings.skippedUpdate && (
            <small className="set-hint">
              Version {settings.skippedUpdate} is skipped at start-up.{' '}
              <button className="link-btn" onClick={() => onChange({ skippedUpdate: '' })}>
                Ask about it again
              </button>
            </small>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
            Reset everything to defaults
          </button>
          <button ref={close} className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
