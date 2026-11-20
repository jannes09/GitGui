import { useEffect, useRef, useState } from 'react';
import type { UpdateInfo } from '../types';

export function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  return bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Shown at start-up (and after "Check now") when the update folder holds a newer build. */
export function UpdateDialog({
  info,
  onInstall,
  onLater,
  onSkip,
}: {
  info: UpdateInfo;
  onInstall: () => Promise<{ launched: boolean }>;
  onLater: () => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false); // the installer was only shown in its folder
  const [started, setStarted] = useState(false); // the installer is running and the app is about to close
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), []);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const { launched } = await onInstall();
      if (launched) {
        setStarted(true); // stays disabled: the app closes itself a moment later
        return;
      }
      setShown(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const built = info.releaseDate ? new Date(info.releaseDate).toLocaleString() : null;
  const details = [built && `built ${built}`, formatSize(info.size)].filter(Boolean).join(', ');

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onLater}>
      <div
        className="modal update"
        role="dialog"
        aria-modal="true"
        aria-label="Update available"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onLater()}
      >
        <h3>A newer version of GitGui is available</h3>
        <p className="update-versions">
          <span className="update-new">{info.latest}</span>
          <span className="update-arrow" aria-hidden="true">
            ←
          </span>
          <span className="update-old">{info.current}</span>
          <span className="update-label">you have</span>
        </p>
        <p className="modal-text small">
          Found in <code>{info.folder}</code>
          {details ? ` (${details})` : ''}.
        </p>
        {started ? (
          <p className="modal-text small">The installer is starting. GitGui closes now so it can be replaced.</p>
        ) : shown ? (
          <p className="modal-text small">The installer is shown in its folder. Close GitGui and run it to update.</p>
        ) : (
          <p className="modal-text small">
            Installing checks the installer, closes GitGui and starts it. Your repositories and settings are kept. Nothing is downloaded: it comes from that folder on this computer.
          </p>
        )}
        {error && (
          <p className="update-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {!shown && (
            <button className="btn ghost" onClick={onSkip} disabled={busy} title="Do not ask again at start-up for this version">
              Skip this version
            </button>
          )}
          <button className="btn" onClick={onLater} disabled={busy}>
            {shown ? 'Close' : 'Later'}
          </button>
          {!shown && (
            <button ref={primary} className="btn primary" onClick={install} disabled={busy}>
              {busy ? 'Checking…' : 'Install and restart'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
