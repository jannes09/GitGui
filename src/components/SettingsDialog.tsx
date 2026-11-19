import { useEffect, useRef } from 'react';
import { DEFAULT_MAIN_BRANCHES, DEFAULT_SETTINGS, type Settings } from '../settings';
import { Icon } from '../icons';

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
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
export function SettingsDialog({ settings, onChange, onClose }: Props) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  const t = { settings, onChange };

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
          <h3>Settings</h3>
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
