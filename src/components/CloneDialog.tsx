import { useEffect, useRef, useState } from 'react';
import { isElectron, onProgress, pickFolder, type Progress } from '../api';
import { cloneFolderName, cloneNameProblem, cloneUrlProblem } from '../clone';

export interface CloneSpec {
  /** where the previous clone went, offered again */
  parent: string;
  /** clones and opens the repository; throws with the reason when it fails */
  onClone: (url: string, parent: string, name: string) => Promise<void>;
}

export function CloneDialog({ spec, onClose }: { spec: CloneSpec; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState(spec.parent);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    urlInput.current?.focus();
  }, []);
  useEffect(() => onProgress('clone', setProgress), []);

  const problem = cloneUrlProblem(url) ?? (!parent.trim() ? 'Choose the folder to clone into' : cloneNameProblem(name));
  const target = parent.trim() && name.trim() ? `${parent.trim().replace(/[\\/]+$/, '')}\\${name.trim()}` : '';

  const changeUrl = (v: string) => {
    setUrl(v);
    if (!nameEdited) setName(cloneFolderName(v));
  };

  const browse = async () => {
    const p = await pickFolder('Folder to clone into');
    if (p) setParent(p);
  };

  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    setProgress(null);
    setError(null);
    try {
      await spec.onClone(url.trim(), parent.trim(), name.trim());
      onClose();
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg.startsWith('AUTH:') ? `${msg.slice(5).trim()}\n\nSign in to GitHub from the account menu, then try again.` : msg);
      setBusy(false);
    }
  };

  const close = () => !busy && onClose(); // a running clone cannot be cancelled from here

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Clone repository"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          // Enter in a text box clones; on a button it already clicks that button
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) void submit();
        }}
      >
        <h3>Clone repository</h3>
        <label>Repository address</label>
        <input
          ref={urlInput}
          value={url}
          disabled={busy}
          placeholder="https://github.com/owner/repo.git"
          onChange={(e) => changeUrl(e.target.value)}
        />
        <label className="clone-label">Clone into</label>
        <div className="clone-row">
          <input value={parent} disabled={busy} placeholder="F:\projects" onChange={(e) => setParent(e.target.value)} />
          {isElectron && (
            <button className="btn" disabled={busy} onClick={() => void browse()}>
              Browse…
            </button>
          )}
        </div>
        <label className="clone-label">Folder name</label>
        <input
          value={name}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
        />
        {target && <code className="modal-detail">{target}</code>}
        {busy && (
          <div className="clone-progress" role="status">
            <div className="clone-progress-text">
              <span>{progress ? progress.step : 'Connecting…'}</span>
              <span>{progress ? `${progress.percent}%` : ''}</span>
            </div>
            <div
              className={'progress-track' + (progress ? '' : ' indeterminate')}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress?.percent}
            >
              <div className="progress-fill" style={progress ? { width: `${progress.percent}%` } : undefined} />
            </div>
            {progress?.detail && <div className="clone-progress-detail">{progress.detail}</div>}
          </div>
        )}
        {error && <p className="notice error clone-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!problem || busy} title={problem ?? undefined} onClick={() => void submit()}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </div>
      </div>
    </div>
  );
}
