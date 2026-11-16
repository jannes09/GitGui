import { useEffect, useRef } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onReset: () => void;
  label: string;
  /** true when the panel being resized sits to the right of the handle */
  invert?: boolean;
  className?: string;
}

/** A draggable, keyboard-accessible vertical divider. Double-click resets the width. */
export function Splitter({ value, min, max, onChange, onReset, label, invert, className }: Props) {
  const drag = useRef<{ x: number; v: number } | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));

  useEffect(() => () => document.body.classList.remove('resizing'), []);

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('resizing');
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className={'splitter ' + (className ?? '')}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, v: value };
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        onChange(clamp(d.v + (invert ? -dx : dx)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          onChange(clamp(value + dir * step * (invert ? -1 : 1)));
        } else if (e.key === 'Home') {
          e.preventDefault();
          onReset();
        }
      }}
    />
  );
}
