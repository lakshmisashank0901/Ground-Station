"use client";

import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { statusTone, TONE_COLORS, type Tone } from "@/lib/formatters";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- layout

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-line pb-2">
      <div>
        <h1 className="text-[15px] font-semibold tracking-wide text-ink uppercase">{title}</h1>
        {subtitle ? <div className="mt-0.5 text-xs text-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  tone,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  tone?: string;
}) {
  return (
    <section
      className={cx("flex min-w-0 flex-col rounded-[4px] border border-line bg-panel", className)}
      style={tone ? { borderTopColor: TONE_COLORS[statusTone(tone)], borderTopWidth: 2 } : undefined}
    >
      {title || actions ? (
        <header className="flex min-h-[30px] items-center justify-between gap-2 border-b border-line px-2.5 py-1">
          <h2 className="truncate text-[11px] font-semibold tracking-[0.08em] text-ink-2 uppercase">{title}</h2>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx("min-w-0 flex-1 p-2.5", bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------- status

export function toneOf(status: string | null | undefined): Tone {
  return statusTone(status);
}

export function StatusDot({ status, tone, pulse }: { status?: string | null; tone?: Tone; pulse?: boolean }) {
  const color = TONE_COLORS[tone ?? statusTone(status)];
  return (
    <span
      aria-hidden
      className={cx("inline-block h-2 w-2 shrink-0 rounded-full", pulse && "blink")}
      style={{ background: color, boxShadow: `0 0 6px ${color}88` }}
    />
  );
}

/** Coloured status pill – always dot + text so state is never colour alone. */
export function StatusBadge({ status, label, tone, className }: { status?: string | null; label?: ReactNode; tone?: Tone; className?: string }) {
  const t = tone ?? statusTone(status);
  const color = TONE_COLORS[t];
  return (
    <span
      className={cx("inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-[1px] text-[10px] font-semibold tracking-wider uppercase whitespace-nowrap", className)}
      style={{ color, borderColor: `${color}55`, background: `${color}14` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label ?? status ?? "UNKNOWN"}
    </span>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  color,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="label truncate">{label}</div>
      <div className="num mt-0.5 truncate text-lg leading-tight font-semibold" style={color ? { color } : undefined}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-muted">{unit}</span> : null}
      </div>
      {sub ? <div className="num truncate text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

/** Horizontal 0–1 bar with numeric label. */
export function ScoreBar({ value, color, label, width = "100%" }: { value: number | null | undefined; color?: string; label?: ReactNode; width?: string }) {
  const v = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  return (
    <div className="flex items-center gap-2" style={{ width }}>
      {label ? <span className="w-32 shrink-0 truncate text-[11px] text-ink-2">{label}</span> : null}
      <div className="relative h-2 flex-1 overflow-hidden rounded-[2px] bg-panel-3">
        {v !== null ? <div className="h-full rounded-[2px]" style={{ width: `${v * 100}%`, background: color ?? "var(--color-accent)" }} /> : null}
        {/* threshold ticks at 0.3 / 0.6 / 0.8 */}
        {[0.3, 0.6, 0.8].map((x) => (
          <span key={x} className="absolute top-0 h-full w-px bg-bg/80" style={{ left: `${x * 100}%` }} />
        ))}
      </div>
      <span className="num w-11 shrink-0 text-right text-[11px] text-ink">{v === null ? "n/a" : v.toFixed(3)}</span>
    </div>
  );
}

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex items-center justify-center px-3 py-6 text-center text-xs text-muted", className)}>{children}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-[3px] border border-critical/40 bg-critical/10 px-2 py-1 text-xs text-critical" role="alert">
      {children}
    </div>
  );
}

export function KV({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="label truncate">{k}</dt>
          <dd className="num truncate text-[12px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- controls

type BtnVariant = "default" | "primary" | "danger" | "ghost" | "warning";

export function Button({
  variant = "default",
  size = "sm",
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "xs" | "sm"; active?: boolean }) {
  const v: Record<BtnVariant, string> = {
    default: "border-line-2 bg-panel-2 text-ink hover:border-accent/60 hover:text-white",
    primary: "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25",
    danger: "border-critical/50 bg-critical/10 text-critical hover:bg-critical/20",
    warning: "border-warning/50 bg-warning/10 text-warning hover:bg-warning/20",
    ghost: "border-transparent bg-transparent text-ink-2 hover:text-ink hover:bg-panel-2",
  };
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1 rounded-[3px] border font-medium tracking-wide whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        size === "xs" ? "h-[22px] px-1.5 text-[11px]" : "h-[26px] px-2.5 text-xs",
        v[variant],
        active && "!border-accent !bg-accent/20 !text-accent",
        className,
      )}
    />
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-[3px] border border-line-2" role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "num h-[22px] border-r border-line-2 px-2 text-[11px] last:border-r-0 disabled:opacity-40",
            o.value === value ? "bg-accent/20 text-accent" : "bg-panel-2 text-ink-2 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex min-w-0 flex-col gap-1", className)}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[90vh] w-full overflow-auto rounded-[4px] border border-line-2 bg-panel shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h3 className="text-xs font-semibold tracking-wider text-ink uppercase">{title}</h3>
          <button type="button" className="text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-3">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-3 py-2">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Tiny inline sparkline (no axes) for tiles. */
export function Sparkline({ values, color = "#38bdf8", height = 26, min, max }: { values: number[]; color?: string; height?: number; min?: number; max?: number }) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <div style={{ height }} />;
  const lo = min ?? Math.min(...v);
  const hi = max ?? Math.max(...v);
  const span = hi - lo || 1;
  const w = 100;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(2)},${(height - 2 - ((x - lo) / span) * (height - 4)).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
