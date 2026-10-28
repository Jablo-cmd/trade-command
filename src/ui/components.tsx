import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'sim';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

export function NumberInput({ id, value, onChange, step = 'any', min, placeholder, required }: { id: string; value: number | undefined; onChange: (v: number | undefined) => void; step?: string; min?: number; placeholder?: string; required?: boolean }) {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      placeholder={placeholder}
      required={required}
      value={value === undefined || Number.isNaN(value) ? '' : value}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function List({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="reasons">
      {items.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

/** Accessible modal confirmation using <dialog>. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => (e.preventDefault(), onCancel())} aria-labelledby="dlg-title">
      <h2 id="dlg-title">{title}</h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ title: string; body: ReactNode; label?: string; danger?: boolean; run: () => void } | null>(null);
  const dialog = (
    <ConfirmDialog
      open={!!state}
      title={state?.title ?? ''}
      confirmLabel={state?.label}
      danger={state?.danger}
      onCancel={() => setState(null)}
      onConfirm={() => {
        const run = state?.run;
        setState(null);
        run?.();
      }}
    >
      {state?.body}
    </ConfirmDialog>
  );
  return { dialog, ask: (title: string, body: ReactNode, run: () => void, opts: { label?: string; danger?: boolean } = {}) => setState({ title, body, run, ...opts }) };
}

/** Profit in blue, loss in red — the MT5 convention. Undefined means "cannot be valued". */
export function Pnl({ value, currency, title }: { value: number | undefined; currency?: string; title?: string }) {
  if (value === undefined) {
    return (
      <span className="muted" title={title ?? 'Needs a price, the broker specification and a currency rate.'}>
        —
      </span>
    );
  }
  const kind = value > 0 ? 'pos' : value < 0 ? 'neg' : 'zero';
  const sign = value > 0 ? '+' : value < 0 ? '\u2212' : '';
  const text = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <span className={`pnl pnl-${kind}`} title={title}>
      {sign}
      {text}
      {currency ? ` ${currency}` : ''}
      <span className="sr-only">{value > 0 ? ' profit' : value < 0 ? ' loss' : ' break-even'}</span>
    </span>
  );
}

export function fmtTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
