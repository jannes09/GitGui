import { useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      setPos({
        left: Math.min(x, window.innerWidth - el.offsetWidth - 8),
        top: Math.min(y, window.innerHeight - el.offsetHeight - 8),
      });
    }
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', key);
    };
  }, [x, y, onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={'ctx-item' + (it.danger ? ' danger' : '')}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  message: string;
  confirm: string;
  onConfirm: () => void;
  /** something that cannot be undone: red button, and Cancel is what Enter presses */
  danger?: boolean;
  /** e.g. a file path, shown in full (wrapped) in a box of its own */
  detail?: string;
}

export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => (spec.danger ? cancelBtn : confirmBtn).current?.focus(), [spec.danger]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={spec.title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h3>{spec.title}</h3>
        <p className="modal-text">{spec.message}</p>
        {spec.detail && <code className="modal-detail">{spec.detail}</code>}
        <div className="modal-actions">
          <button ref={cancelBtn} className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={confirmBtn}
            className={'btn ' + (spec.danger ? 'destructive' : 'primary')}
            onClick={() => {
              onClose();
              spec.onConfirm();
            }}
          >
            {spec.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface PromptSpec {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  submit: string;
  onSubmit: (value: string) => void;
}

export function PromptDialog({ spec, onClose }: { spec: PromptSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.value ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select(); // renaming: typing replaces the old text
  }, []);

  const submit = () => {
    if (!value.trim()) return;
    onClose();
    spec.onSubmit(value.trim());
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter') submit();
        }}
      >
        <h3>{spec.title}</h3>
        <label>{spec.label}</label>
        <input ref={input} value={value} placeholder={spec.placeholder} onChange={(e) => setValue(e.target.value)} />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={submit}>
            {spec.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
