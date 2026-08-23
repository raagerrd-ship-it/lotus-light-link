import type { ReactNode } from "react";

/** Sektionskort med eyebrow-rubrik — grunden i hela UI:t. */
export function Panel({
  title, icon, action, children, className = "",
}: {
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-card/70 px-4 py-[18px] ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="label-eyebrow flex items-center gap-1.5">
            {icon}
            {title}
          </h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Underrad i ett kort (grupperar reglage/värden med tunna avdelare). */
export function Row({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex items-center justify-between gap-3 ${className}`}>{children}</div>;
}

/** Nyckeltal: liten etikett + monospace-värde. */
export function Stat({ label, value, tone = "default" }: { label: string; value: ReactNode; tone?: "default" | "accent" }) {
  return (
    <Row className="text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono font-semibold tabular-nums ${tone === "accent" ? "text-primary" : "text-foreground"}`}>
        {value}
      </span>
    </Row>
  );
}

/** Reglage med etikett, värde och hjälptext. */
export function Slider({
  label, value, display, min, max, step = 1, onChange, hint, disabled,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div className={disabled ? "opacity-50" : undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-foreground/90">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-primary">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="lotus-range -my-3"
        style={{ ["--fill" as string]: fill }}
      />
      {hint && <p className="text-[10px] leading-snug text-muted-foreground/80">{hint}</p>}
    </div>
  );
}

/** Segmenterad väljare (2–3 lägen). */
export function Segmented<T extends string>({
  options, value, onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="grid gap-1 p-1 rounded-full bg-foreground/[0.04] ring-1 ring-inset ring-border"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`min-h-[40px] rounded-full text-[11px] font-semibold tracking-wide transition-colors ${
              active
                ? "bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
                : "text-muted-foreground hover:text-foreground/80"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Primär/sekundär knapp. */
export function Button({
  children, onClick, variant = "secondary", disabled, className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  const styles = {
    primary: "bg-primary text-primary-foreground shadow-[0_0_20px_hsl(var(--primary)/0.3)]",
    secondary: "bg-foreground/[0.05] text-foreground/90 ring-1 ring-inset ring-border hover:bg-foreground/[0.09]",
    ghost: "text-muted-foreground hover:text-foreground",
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl text-[12px] font-semibold transition-all active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/** På/av-switch. */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${
        checked ? "bg-primary" : "bg-foreground/[0.08] ring-1 ring-inset ring-border"
      }`}
    >
      <span
        className={`absolute top-1 w-5 h-5 rounded-full bg-foreground shadow transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

/** Statuslampa med text. */
export function StatusDot({
  label, state,
}: {
  label: string;
  state: "ok" | "warn" | "error" | "idle";
}) {
  const dot = {
    ok: "bg-ok shadow-[0_0_8px_hsl(var(--ok)/0.8)]",
    warn: "bg-warn",
    error: "bg-destructive",
    idle: "bg-muted-foreground animate-pulse",
  }[state];
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="text-[10px] tracking-wide text-muted-foreground">{label}</span>
    </span>
  );
}
