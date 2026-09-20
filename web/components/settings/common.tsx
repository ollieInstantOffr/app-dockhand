"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errMsg, invalidate, patch, useApi } from "@/lib/api";
import type { Settings, SettingsPatch } from "@/lib/types";
import { useShell } from "@/components/shell/context";
import { Toggle } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";

/** GET /api/settings plus an optimistic, rollback-on-error PATCH. */
export function useSettings() {
  const shell = useShell();
  const { data, mutate, isLoading } = useApi<Settings>("/api/settings");
  const save = async (p: SettingsPatch) => {
    const prev = data;
    if (!prev) return false;
    const next = mergeSettings(prev, p);
    mutate(next, { revalidate: false });
    try {
      const s = await patch<Settings>("/api/settings", p);
      mutate(s, { revalidate: false });
      if (p.updates) invalidate("/api/system"); // the automatic update schedule depends on these
      return true;
    } catch (e) {
      mutate(prev, { revalidate: false });
      shell.toast({ kind: "error", title: "Couldn't save setting", text: errMsg(e) });
      return false;
    }
  };
  return { settings: data, save, loading: isLoading && !data };
}

function mergeSettings(s: Settings, p: SettingsPatch): Settings {
  const out = { ...s } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    out[k] = { ...(s as unknown as Record<string, object>)[k], ...(v as object) };
  }
  return out as unknown as Settings;
}

// ─── Small layout pieces shared by the settings tabs ───────────────────────

export const cardStyle = (gap = 14, padding: number | string = 24): CSSProperties => ({ padding, display: "flex", flexDirection: "column", gap });

/** List row (`fill-1`, borderless). The first arg is kept for call-site compatibility; v2 has one row tone. */
export const rowStyle = (_alt = false, extra?: CSSProperties): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 14px",
  borderRadius: 14,
  background: "var(--fill-1)",
  border: "1px solid transparent",
  ...extra,
});

export const twoCol = (min = 380): CSSProperties => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit,minmax(min(100%,${min}px),1fr))`, gap: 20, alignItems: "start" });

export const colStack: CSSProperties = { display: "flex", flexDirection: "column", gap: 20, minWidth: 0 };

export function CardHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
      {sub != null && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{sub}</span>}
      {children && <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>{children}</div>}
    </div>
  );
}

/**
 * Dark header band that bleeds to the card's edges (v2 design). `pad` must match
 * the card's horizontal/top padding. With `icon` it renders the large variant
 * (icon tile + title + one-line description).
 */
export function InkHead({ title, sub, icon, pad = 24, wrap, children }: { title: ReactNode; sub?: ReactNode; icon?: IconName; pad?: number; wrap?: boolean; children?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: icon ? 12 : 10,
        flexWrap: wrap ? "wrap" : undefined,
        margin: `-${pad}px -${pad}px 8px`,
        padding: `16px ${pad}px`,
        borderRadius: "24px 24px 0 0",
        background: "var(--btn)",
        color: "var(--btn-ink)",
      }}
    >
      {icon ? (
        <>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
            <Icon name={icon} size={19} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
            <span style={{ fontSize: 17, fontWeight: 700 }}>{title}</span>
            {sub != null && <span style={{ fontSize: 12.5, opacity: 0.75 }}>{sub}</span>}
          </div>
        </>
      ) : (
        <>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
          {sub != null && <span style={{ fontSize: 12.5, opacity: 0.65 }}>{sub}</span>}
        </>
      )}
      {children != null && <div className="set-ink-actions" style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flex: "none" }}>{children}</div>}
    </div>
  );
}

/** Small translucent button for use on an InkHead band. */
export function InkButton({ children, onClick, disabled, title }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="set-ink-btn" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** Segmented control styled for an InkHead band. */
export function InkSeg<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="set-ink-seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Status pill colours that read on the dark (light, in dark mode) InkHead band. */
export const INK_PILL = {
  ok: { bg: "rgba(34,160,107,.22)", color: "var(--ok)" },
  warn: { bg: "rgba(224,160,32,.22)", color: "var(--warn)" },
  crit: { bg: "rgba(226,80,76,.22)", color: "var(--crit)" },
  blue: { bg: "rgba(47,111,237,.22)", color: "var(--blue)" },
  muted: { bg: "rgba(127,127,127,.25)", color: "var(--btn-ink)" },
};

/** Settings-scoped CSS (nav, ink-band controls, responsive layout). Rendered once by the settings page. */
export function SettingsStyles() {
  return (
    <style>{`
      .set-layout { display: grid; grid-template-columns: minmax(180px, 220px) minmax(0, 1fr); gap: 24px; align-items: start; }
      .set-content { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
      .set-nav { position: sticky; top: 92px; border-radius: 24px; background: var(--btn); color: var(--btn-ink); box-shadow: 0 14px 44px rgba(20,24,40,.14); padding: 10px; display: flex; flex-direction: column; gap: 4px; }
      .set-nav-items { display: flex; flex-direction: column; gap: 4px; }
      .set-nav-item { display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px; border: 0; border-radius: 14px; background: transparent; color: var(--btn-ink); font-size: 13.5px; font-weight: 600; cursor: pointer; text-align: left; width: 100%; transition: background .2s; text-decoration: none; white-space: nowrap; }
      .set-nav-group { padding: 12px 12px 2px; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--btn-ink); opacity: .45; }
      .set-nav-items > div:first-child .set-nav-group { padding-top: 2px; }
      .set-nav-item:hover { background: rgba(127,127,127,.22); }
      .set-nav-item.on { background: rgba(127,127,127,.3); }
      .set-nav-item .set-nav-ic { display: flex; opacity: .6; }
      .set-nav-item.on .set-nav-ic { opacity: 1; }
      .set-nav-item .set-nav-label { flex: 1; opacity: .8; }
      .set-nav-item.on .set-nav-label { opacity: 1; }
      .set-nav-badge { font-family: var(--mono); font-size: 10.5px; padding: 2px 7px; border-radius: 7px; background: rgba(127,127,127,.25); }
      .set-nav-badge.warn { background: var(--warn); color: #171a21; }
      .set-nav-div { height: 1px; background: rgba(127,127,127,.3); margin: 6px 8px; }
      .set-nav-foot { padding: 8px 12px 6px; display: flex; flex-direction: column; gap: 2px; color: var(--btn-ink); text-decoration: none; border-radius: 12px; }
      .set-ink-btn { height: 28px; padding: 0 10px; border-radius: 9px; border: 0; background: rgba(127,127,127,.25); color: var(--btn-ink); font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; transition: background .15s; }
      .set-ink-btn:hover:not(:disabled) { background: rgba(127,127,127,.4); }
      .set-ink-btn:disabled { opacity: .45; cursor: default; }
      .set-ink-btn.solid { height: 32px; padding: 0 12px; font-size: 12.5px; background: var(--btn-ink); color: var(--btn); }
      .set-ink-btn.solid:hover:not(:disabled) { background: var(--btn-ink); opacity: .9; }
      .set-ink-actions .toggle:not(.on) { background: rgba(127,127,127,.45); }
      .btn2.set-outline { background: transparent; border: 1px solid var(--line-2); }
      .btn2.set-outline:hover:not(:disabled) { background: var(--fill-2); }
      .set-ink-seg { display: flex; padding: 3px; border-radius: 12px; background: rgba(127,127,127,.22); gap: 2px; flex-wrap: wrap; }
      .set-ink-seg > button { height: 28px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--btn-ink); opacity: .75; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all .2s; }
      .set-ink-seg > button:hover { opacity: 1; }
      .set-ink-seg > button.on { background: var(--btn-ink); color: var(--btn); opacity: 1; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
      @media (max-width: 860px) {
        .set-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
        .set-nav { position: static; flex-direction: row; align-items: center; padding: 6px; border-radius: 18px; overflow-x: auto; scrollbar-width: none; }
        .set-nav::-webkit-scrollbar { display: none; }
        .set-nav-items { flex-direction: row; }
        .set-nav-item { width: auto; flex: none; height: 38px; gap: 8px; border-radius: 12px; }
        .set-nav-div, .set-nav-foot, .set-nav-group { display: none; }
      }
    `}</style>
  );
}

/** Label + sub on the left, toggle on the right (design's settings rows). */
export function SetToggle({ label, sub, on, onChange, disabled }: { label: ReactNode; sub?: ReactNode; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</span>
        {sub != null && <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</span>}
      </span>
      <Toggle on={on} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function Field({ label, children, hint, style }: { label: ReactNode; children: ReactNode; hint?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="field" style={style}>
      {label}
      {children}
      {hint != null && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function StatusPill({ bg, color, children }: { bg: string; color: string; children: ReactNode }) {
  return (
    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, background: bg, color, fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
      {children}
    </span>
  );
}

export const PILL = {
  ok: { bg: "rgba(34,160,107,.12)", color: "var(--ok-ink)" },
  warn: { bg: "rgba(224,160,32,.15)", color: "var(--warn-ink)" },
  crit: { bg: "rgba(226,80,76,.12)", color: "var(--crit-ink)" },
  blue: { bg: "rgba(47,111,237,.1)", color: "var(--blue)" },
  muted: { bg: "var(--fill-1)", color: "var(--ink-3)" },
};

export function SkelCard({ rows = 3, h = 44 }: { rows?: number; h?: number }) {
  return (
    <div className="glass-card" style={cardStyle(12)}>
      <span className="skel" style={{ width: "40%", height: 16 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} className="skel" style={{ width: "100%", height: h, borderRadius: 14 }} />
      ))}
    </div>
  );
}

/** Mask a secret, keeping the last 4 characters. */
export function mask(v: string): string {
  if (!v) return "";
  if (v.includes("•") || v.includes("…") || v.includes("*")) return v;
  return v.length <= 8 ? "••••••••" : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** Render into <body> so position:fixed dialogs escape any transformed / filtered ancestor. */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}
