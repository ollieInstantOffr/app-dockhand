"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { avatarBg, initial } from "@/lib/format";
import { RingGauge } from "./charts/RingGauge";
import { SparkBars } from "./charts/SparkBars";
export { UptimeBars } from "./charts/UptimeBars";
import type { Host, JobLogLine, JobStep } from "@/lib/types";

// ─── Surfaces ──────────────────────────────────────────────────────────────

export function Card({ children, style, className = "", inset, lift, onClick }: { children: ReactNode; style?: CSSProperties; className?: string; inset?: boolean; lift?: boolean; onClick?: () => void }) {
  return (
    <div className={`glass-card ${inset ? "inset" : ""} ${lift ? "lift" : ""} ${className}`} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

export function PageHeader({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
      <div>
        <h1 className="page-title">{title}</h1>
        {sub != null && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>{children}</div>}
    </div>
  );
}

// ─── Controls ──────────────────────────────────────────────────────────────

export function Toggle({ on, onChange, small, disabled, title }: { on: boolean; onChange: (v: boolean) => void; small?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      aria-pressed={on}
      className={`toggle ${on ? "on" : ""} ${small ? "sm" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      <span />
    </button>
  );
}

export function ToggleRow({ label, sub, on, onChange, mono }: { label: ReactNode; sub?: ReactNode; on: boolean; onChange: (v: boolean) => void; mono?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</span>
        {sub != null && <span className={mono ? "mono" : ""} style={{ fontSize: mono ? 11 : 12, color: "var(--ink-3)" }}>{sub}</span>}
      </span>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Segmented control (pill buttons on a fill-1 track). */
export function Seg<T extends string>({ options, value, onChange, size, fit, mono, style }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; size?: "sm" | "lg"; fit?: boolean; mono?: boolean; style?: CSSProperties }) {
  return (
    <div className={`seg ${size ?? ""} ${fit ? "fit" : ""}`} style={style}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)} style={mono ? { fontFamily: "var(--mono)" } : undefined}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Glass tab bar (host tabs, settings tabs, deploy modes). */
export function Tabs<T extends string>({ items, value, onChange }: { items: { value: T; label: ReactNode; icon?: IconName; count?: number | string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs">
      {items.map((t) => (
        <button key={t.value} type="button" className={t.value === value ? "on" : ""} onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} size={15} />}
          {t.label}
          {t.count != null && t.count !== 0 && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Custom dropdown matching the design (`select-btn` + glass menu). */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  icon,
  placeholder = "Select…",
  dark,
  minWidth,
}: {
  value: T | "";
  options: { value: T; label: ReactNode; sub?: ReactNode; dot?: string }[];
  onChange: (v: T) => void;
  icon?: ReactNode;
  placeholder?: string;
  dark?: boolean;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const cur = options.find((o) => o.value === value);
  if (dark) {
    return (
      <span ref={ref} style={{ position: "relative", display: "flex" }}>
        <button type="button" onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 12px", borderRadius: 10, border: 0, background: "rgba(255,255,255,.08)", color: "#e6e9f0", fontSize: 12.5, cursor: "pointer" }}>
          {cur?.dot && <span className="dot" style={{ width: 7, height: 7, background: cur.dot }} />}
          <span className="mono">{cur?.label ?? placeholder}</span>
          <span style={{ display: "flex", opacity: 0.6 }}><Icon name="chevron" size={14} /></span>
        </button>
        {open && (
          <div style={{ position: "absolute", left: 0, top: 38, minWidth: minWidth ?? 250, maxHeight: 320, overflow: "auto", zIndex: 30, padding: 6, borderRadius: 14, background: "rgba(24,28,38,.97)", border: "1px solid rgba(255,255,255,.1)", boxShadow: "0 18px 50px rgba(0,0,0,.4)", display: "flex", flexDirection: "column", gap: 2, animation: "pop .18s ease both" }}>
            {options.map((o) => (
              <button key={o.value} type="button" onClick={() => { onChange(o.value); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, height: 34, padding: "0 10px", border: 0, borderRadius: 9, background: o.value === value ? "rgba(255,255,255,.08)" : "transparent", color: "#e6e9f0", fontSize: 12.5, fontFamily: "var(--mono)", cursor: "pointer", textAlign: "left", width: "100%", flex: "none" }}>
                {o.dot && <span className="dot" style={{ width: 7, height: 7, background: o.dot }} />}
                <span className="ellipsis" style={{ flex: 1 }}>{o.label}</span>
                {o.value === value && <Icon name="check" size={14} color="#3ccf7a" />}
              </button>
            ))}
          </div>
        )}
      </span>
    );
  }
  return (
    <span ref={ref} style={{ position: "relative", display: "block" }}>
      <button type="button" className="select-btn" onClick={() => setOpen(!open)}>
        {icon}
        <span className="ellipsis" style={{ flex: 1, color: cur ? "var(--ink)" : "var(--ink-3)" }}>{cur?.label ?? placeholder}</span>
        <span style={{ display: "flex", color: "var(--ink-3)" }}><Icon name="chevron" size={14} /></span>
      </button>
      {open && (
        <div className="menu" style={{ left: 0, right: 0, top: 44, maxHeight: 300, overflow: "auto", minWidth }}>
          {options.length === 0 && <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--ink-3)" }}>Nothing to choose</div>}
          {options.map((o) => (
            <button key={o.value} type="button" className={`menu-item mono ${o.value === value ? "active" : ""}`} onClick={() => { onChange(o.value); setOpen(false); }} style={{ flex: "none" }}>
              {o.dot && <span className="dot" style={{ width: 7, height: 7, background: o.dot }} />}
              <span className="ellipsis" style={{ flex: 1 }}>{o.label}</span>
              {o.sub && <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font)" }}>{o.sub}</span>}
              {o.value === value && <span style={{ display: "flex", color: "var(--blue)" }}><Icon name="check" size={14} /></span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onClick: () => void;
}

/** "…" button with a popover menu. */
export function DotsMenu({ items, up, dark }: { items: MenuItem[]; up?: boolean; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <span ref={ref} style={{ position: "relative", display: "flex" }}>
      <button type="button" className="btn-fill" style={{ width: 30, color: dark ? "var(--ink-3)" : "var(--ink)" }} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} aria-label="More actions">
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="menu" style={{ right: 0, ...(up ? { bottom: 36 } : { top: 34 }), minWidth: 200 }}>
          {items.map((m) => (
            <button key={m.label} type="button" className="menu-item" style={{ color: m.danger ? "var(--crit-ink)" : "var(--ink)" }} onClick={(e) => { e.stopPropagation(); setOpen(false); m.onClick(); }}>
              {m.icon && <span style={{ display: "flex", color: m.danger ? "var(--crit-ink)" : "var(--ink-3)" }}><Icon name={m.icon} size={15} /></span>}
              {m.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function useOutside(ref: React.RefObject<HTMLElement | null>, cb: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    // Design `closeMenus`: a click anywhere else (or Esc) closes the open menu.
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only swallow Esc when it closed a menu, so the sidecar / dialog underneath stays open.
      e.stopImmediatePropagation();
      e.preventDefault();
      cb();
    };
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k, true);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k, true);
    };
  }, [ref, cb, active]);
}

// ─── Display ───────────────────────────────────────────────────────────────

export function Avatar({ name, color, size = 28, radius, fontSize }: { name: string; color: string; size?: number; radius?: number; fontSize?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, borderRadius: radius ?? Math.round(size / 3.2), background: avatarBg(color), fontSize: fontSize ?? Math.round(size * 0.4) }}>
      {initial(name)}
    </span>
  );
}

export function Pill({ kind, children, small }: { kind: "ok" | "warn" | "crit" | "muted" | "blue"; children: ReactNode; small?: boolean }) {
  return <span className={`pill ${kind} ${small ? "sm" : ""}`}>{children}</span>;
}

export function Dot({ color, size = 8, halo }: { color: string; size?: number; halo?: string }) {
  return <span className="dot" style={{ width: size, height: size, background: color, boxShadow: halo ? `0 0 0 ${size >= 10 ? 4 : 3}px ${halo}` : undefined }} />;
}

/** Ring gauge (Graphite `RingGauge`) with its label, as on host cards and the host header. */
export function Ring({ value, color, label, detail, size = 44 }: { value: number; color: string; label: string; detail?: string; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <RingGauge label={label} value={value} color={color} size={size} />
      {detail != null ? (
        <span style={{ display: "flex", flexDirection: "column", fontSize: 11.5, color: "var(--ink-3)", fontWeight: 600 }}>
          <span>{label}</span>
          <span className="mono" style={{ fontWeight: 400, fontSize: 10.5 }}>{detail}</span>
        </span>
      ) : (
        <span style={{ fontSize: 11.5, color: "var(--ink-3)", fontWeight: 600 }}>{label}</span>
      )}
    </div>
  );
}

/** Bar sparkline (Graphite `SparkBars`). Values 0–100 unless `max` given. */
export function Spark({ values, height = 28, color = "#2f6fed", max, gap = 3, radius = 2, count, unit, formatValue }: { values: number[]; height?: number; color?: string | ((v: number) => string); max?: number; gap?: number; radius?: number; count?: number; unit?: string; formatValue?: (v: number) => string }) {
  return <SparkBars data={values} count={count ?? values.length} color={color} max={max} height={height} gap={gap} radius={radius} unit={unit} formatValue={formatValue} />;
}

export function EmptyState({ icon, title, text, children }: { icon: IconName; title: string; text: ReactNode; children?: ReactNode }) {
  return (
    <div className="glass-card" style={{ padding: "44px 28px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 14, animation: "rise .35s ease both" }}>
      <span style={{ width: 64, height: 64, borderRadius: 20, background: "var(--fill-1)", display: "grid", placeItems: "center", color: "var(--ink-3)" }}>
        <Icon name={icon} size={28} />
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 380 }}>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>{title}</span>
        <span style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>{text}</span>
      </div>
      {children && <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>{children}</div>}
    </div>
  );
}

export function Skel({ w = "100%", h = 12, r = 8, style }: { w?: number | string; h?: number | string; r?: number | string; style?: CSSProperties }) {
  return <span className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {steps.map((s, i) => (
        <span key={s} style={{ display: "contents" }}>
          <div className={`step ${i === current ? "on" : i < current ? "done" : ""}`}>
            <b>{i < current ? "✓" : i + 1}</b>
            {s}
          </div>
          {i < steps.length - 1 && <span className="step-line" />}
        </span>
      ))}
    </div>
  );
}

/** Vertical progress list for jobs and connection tests. */
export function ProgressList({ steps }: { steps: JobStep[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {steps.map((p, i) => (
        <div key={i} className={`prog ${p.status}`}>
          <span className="prog-icon">
            {p.status === "done" ? <Icon name="check" size={12} strokeWidth={3} /> : p.status === "failed" ? <Icon name="x" size={11} strokeWidth={3} /> : p.status === "running" ? <span className="spinner" style={{ width: 11, height: 11 }} /> : p.status === "skipped" ? "–" : i + 1}
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="prog-label">{p.label}</span>
            {p.sub && <span className="prog-sub mono" style={{ fontSize: 11 }}>{p.sub}</span>}
          </span>
          {p.t && <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{p.t}</span>}
        </div>
      ))}
    </div>
  );
}

const LOG_COLORS: Record<JobLogLine["level"], string> = {
  info: "#d5d8de",
  ok: "#9fd18b",
  warn: "#f2c05c",
  error: "#ff8a85",
  cmd: "#7dc4ff",
  muted: "#6b7280",
};

/** Dark terminal-style log block that sticks to the bottom as lines arrive. */
export function LogBlock({ lines, running, style, minHeight }: { lines: JobLogLine[]; running?: boolean; style?: CSSProperties; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div ref={ref} className="term-block" style={{ minHeight, overflow: "auto", ...style }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: LOG_COLORS[l.level] ?? LOG_COLORS.info }}>{l.text}</div>
      ))}
      {running && <span className="cursor" />}
    </div>
  );
}

// ─── Host pickers ──────────────────────────────────────────────────────────

/** Multi/single host chip selector (pull dialog, monitors, MCP, key wizard). */
export function HostChips({ hosts, selected, onToggle }: { hosts: Pick<Host, "id" | "name" | "color">[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {hosts.map((h) => (
        <button key={h.id} type="button" className={`host-chip ${selected.includes(h.id) ? "on" : ""}`} onClick={() => onToggle(h.id)}>
          <Avatar name={h.name} color={h.color} size={22} radius={7} fontSize={10} />
          {h.name}
        </button>
      ))}
    </div>
  );
}

/** Big "Deploy to" host cards used by the deploy flows. */
export function HostTargets({ hosts, value, onChange }: { hosts: Host[]; value: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 8 }}>
      {hosts.map((h) => {
        const on = h.id === value;
        return (
          <button key={h.id} type="button" onClick={() => onChange(h.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 14, border: `1.5px solid ${on ? "var(--blue)" : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", cursor: "pointer", textAlign: "left", transition: "all .15s", opacity: h.status === "offline" ? 0.55 : 1 }}>
            <Avatar name={h.name} color={h.color} size={26} radius={8} fontSize={11} />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }} className="ellipsis">{h.name}</span>
              <span className="mono" style={{ fontSize: 10.5, fontWeight: 400, color: "var(--ink-3)" }}>{Math.round(h.mem)}% mem · {Math.round(h.disk)}% disk</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Dialog shell ──────────────────────────────────────────────────────────

export function Dialog({ onClose, width = 460, children, top }: { onClose: () => void; width?: number; children: ReactNode; top?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={top ? { placeItems: "start center", paddingTop: "10vh" } : undefined}>
      <div className="dialog" style={{ width: `min(${width}px, 100%)` }} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ icon, title, sub, onClose, monoSub, iconBg, iconColor }: { icon: IconName; title: ReactNode; sub?: ReactNode; onClose: () => void; monoSub?: boolean; iconBg?: string; iconColor?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "-26px -26px 4px", padding: "18px 26px", borderRadius: "24px 24px 0 0", background: "var(--btn)", color: "var(--btn-ink)" }}>
      <span style={{ width: 44, height: 44, borderRadius: 13, background: iconBg ?? "rgba(127,127,127,.22)", color: iconColor ?? "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
        <Icon name={icon} size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 className="dialog-title">{title}</h2>
        {sub != null && (
          <p className={monoSub ? "mono ellipsis" : ""} style={{ margin: "4px 0 0", fontSize: monoSub ? 12.5 : 13, opacity: 0.7 }}>
            {sub}
          </p>
        )}
      </div>
      <button type="button" onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 9, border: 0, background: "rgba(127,127,127,.25)", color: "var(--btn-ink)", opacity: 0.7, cursor: "pointer", display: "grid", placeItems: "center", flex: "none" }}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/** The blue "Dockhand's SSH key" callout with copy. */
export function KeyCallout({ title, value, onCopy, full }: { title: string; value: string; onCopy: () => void; full?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, border: "1px solid rgba(47,111,237,.35)", background: "rgba(47,111,237,.06)" }}>
      <span style={{ width: 34, height: 34, flex: "none", borderRadius: 10, background: "var(--blue)", color: "#fff", display: "grid", placeItems: "center" }}>
        <Icon name="key" size={17} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        {!full && <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{title}</span>}
        <span className="mono ellipsis" style={{ fontSize: 11, fontWeight: 400, color: full ? "var(--ink-4)" : "var(--ink-2)" }}>{value || "generating…"}</span>
      </span>
      <button type="button" className="btn2 sm" onClick={onCopy} style={{ flex: "none" }}>
        <Icon name="copy" size={13} />
        Copy
      </button>
    </div>
  );
}

/** Abbreviate an ssh public key for display: "ssh-ed25519 AAAAC3Nz…kX4q dockhand". */
export function shortKey(k: string): string {
  const [type, body, ...rest] = k.split(" ");
  if (!body) return k;
  return `${type} ${body.slice(0, 8)}…${body.slice(-4)} ${rest.join(" ")}`.trim();
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
