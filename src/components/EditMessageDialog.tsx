import { useEffect, useRef, useState } from 'react';
import type { CommitEditInfo } from '../types';

export interface EditMessageSpec extends CommitEditInfo {
  hash: string;
}

/** Edit the summary and description of an unpushed commit. */
export function EditMessageDialog({
  spec,
  onSave,
  onClose,
}: {
  spec: EditMessageSpec;
  onSave: (summary: string, description: string) => void;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState(spec.summary);
  const [description, setDescription] = useState(spec.description);
  const summaryInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    summaryInput.current?.focus();
    summaryInput.current?.select();
  }, []);

  const changed = summary.trim() !== spec.summary.trim() || description.trim() !== spec.description.trim();
  const canSave = summary.trim().length > 0 && changed;
  const save = () => {
    if (!canSave) return;
    onClose();
    onSave(summary, description);
  };

  const n = spec.later;
  const effect =
    n === 0
      ? 'This commit gets a new id. Its files stay as they are.'
      : `This commit and the ${n} later commit${n === 1 ? '' : 's'} on ${spec.branch ?? 'this branch'} get new ids. Their files and messages stay as they are.`;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal edit-msg"
        role="dialog"
        aria-modal="true"
        aria-label="Edit commit message"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      >
        <h3>
          Edit commit message <code className="edit-msg-hash">{spec.hash.slice(0, 7)}</code>
        </h3>
        <label htmlFor="edit-msg-summary">Summary</label>
        <div className="field">
          <input
            id="edit-msg-summary"
            ref={summaryInput}
            value={summary}
            placeholder="Commit summary"
            onChange={(e) => setSummary(e.target.value.replace(/[\r\n]+/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                descriptionInput.current?.focus();
              }
            }}
          />
          <span className={'counter' + (summary.length > 72 ? ' over' : '')}>{72 - summary.length}</span>
        </div>
        <label htmlFor="edit-msg-description">Description</label>
        <textarea
          id="edit-msg-description"
          ref={descriptionInput}
          rows={9}
          value={description}
          placeholder="Description"
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="modal-text small">{effect} You can undo it with Ctrl+Z.</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSave} onClick={save} title="Ctrl+Enter">
            Save message
          </button>
        </div>
      </div>
    </div>
  );
}
