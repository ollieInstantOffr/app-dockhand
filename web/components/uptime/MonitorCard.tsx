"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icons";
import { Dialog, DialogHeader, UptimeBars, useOutside, type MenuItem } from "@/components/ui";
import { toUptimeData } from "./bars";
import { useShell } from "@/components/shell/context";
import { del, errMsg, invalidate, patch, post } from "@/lib/api";
import { AVATAR_COLORS, C, ago, avatarBg, duration, initial, plural, since, upColor, uptimePct } from "@/lib/format";
import type { Host, MonitorView, UpStatus } from "@/lib/types";

/** Cards create stacking contexts (backdrop-filter); lift the hovered one so its "…" menu isn't covered by the next card. */
export const UP_CARD_CSS = ".up-card{position:relative}.up-card:hover,.up-card:focus-within{z-index:5}.ink-dots{width:30px;height:30px;border-radius:9px;border:0;background:transparent;cursor:pointer;color:var(--btn-ink);opacity:.7;display:grid;place-items:center}.ink-dots:hover{background:rgba(127,127,127,.22);opacity:1}";

export const WINDOW_LABEL: Record<string, string> = { "24h": "24h", "7d": "7 days", "30d": "30 days" };

const TYPE_STYLE: Record<MonitorView["type"], { icon: IconName; color: string }> = {
  host: { icon: "server", color: C.blue },
  docker: { icon: "box", color: C.blue },
  http: { icon: "globe", color: C.violet },
  tcp: { icon: "network", color: "#14b8c4" },
};

export function pctColor(p: number): string {
  if (p < 0) return "var(--ink-3)";
  return p >= 99.9 ? C.ok : p >= 99 ? C.warn : C.crit;
}

export function statusDot(s: UpStatus): string {
  return s === "paused" || s === "unknown" ? "#9aa1ad" : upColor(s);
}

export function checkedAgo(iso: string | null): string {
  if (!iso) return "not checked yet";
  const s = since(iso);
  if (s < 60) return `checked ${Math.max(0, Math.round(s))}s ago`;
  return `checked ${ago(iso)}`;
}

/** Header status label: "UP", "DOWN 3m", "DEGRADED 12m", "PAUSED". */
export function nowLabel(m: MonitorView, openSince?: string | null): string {
  if (!m.enabled || m.status === "paused") return "Paused";
  if (m.status === "unknown") return "Pending";
  if (m.status === "up") return "Up";
  const base = m.status === "down" ? "Down" : "Degraded";
  return openSince ? `${base} ${duration(since(openSince))}` : base;
}

export function MonitorCard({ m, host, windowLabel, openSince }: { m: MonitorView; host?: Host; windowLabel: string; openSince?: string | null }) {
  const shell = useShell();
  const [editing, setEditing] = useState(false);
  const isHost = m.type === "host";
  const dot = m.enabled ? statusDot(m.status) : "#9aa1ad";
  const ts = TYPE_STYLE[m.type];
  const hostColor = host?.color ?? AVATAR_COLORS[(m.name.charCodeAt(0) || 0) % AVATAR_COLORS.length];

  const refresh = () => invalidate("/api/uptime");

  const checkNow = async () => {
    try {
      const r = await post<MonitorView>(`/api/monitors/${m.id}/check`);
      shell.toast({ kind: r.status === "up" ? "ok" : r.status === "down" ? "error" : "warn", title: `${m.name} is ${r.status}`, text: r.latencyMs > 0 ? `Responded in ${Math.round(r.latencyMs)} ms` : undefined });
      refresh();
    } catch (e) {
      shell.toast({ kind: "error", title: "Check failed", text: errMsg(e) });
    }
  };

  const setEnabled = async (enabled: boolean) => {
    try {
      await patch(`/api/monitors/${m.id}`, { enabled });
      shell.toast({ kind: "ok", title: enabled ? `Resumed ${m.name}` : `Paused ${m.name}` });
      refresh();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't update monitor", text: errMsg(e) });
    }
  };

  const remove = async () => {
    const ok = await shell.confirm({ title: `Remove ${m.name}?`, text: "The monitor and its uptime history are deleted. Past incidents stay in the log.", confirmLabel: "Remove monitor", danger: true, icon: "trash" });
    if (!ok) return;
    try {
      await del(`/api/monitors/${m.id}`);
      shell.toast({ kind: "ok", title: `Removed ${m.name}` });
      refresh();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't remove monitor", text: errMsg(e) });
    }
  };

  const items: MenuItem[] = [
    { label: "Check now", icon: "restart", onClick: checkNow },
    m.enabled ? { label: "Pause", icon: "pause", onClick: () => setEnabled(false) } : { label: "Resume", icon: "play", onClick: () => setEnabled(true) },
    { label: "Edit name", icon: "edit", onClick: () => setEditing(true) },
  ];
  if (!isHost) items.push({ label: "Remove", icon: "trash", danger: true, onClick: remove });

  const sub = isHost ? `${m.target}${host?.os ? ` · ${host.os}` : ""}` : `${m.target}${m.hostName ? ` · ${m.hostName}` : ""}`;

  return (
    <div className="glass-card lift up-card" style={{ borderRadius: 26, display: "flex", flexDirection: "column", opacity: m.enabled ? 1 : 0.72 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 14px 14px 16px", background: "var(--btn)", color: "var(--btn-ink)", borderRadius: "26px 26px 0 0" }}>
        {isHost ? (
          <span style={{ width: 34, height: 34, borderRadius: 11, background: avatarBg(hostColor), color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)" }}>{initial(m.name)}</span>
        ) : (
          <span title={m.type} style={{ width: 34, height: 34, borderRadius: 11, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
            <Icon name={ts.icon} size={17} />
          </span>
        )}
        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <span className="ellipsis" style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.2 }}>{m.name}</span>
          <span className="mono ellipsis" style={{ fontSize: 11, opacity: 0.6 }}>{sub}</span>
        </span>
        <span className="ink-status" style={{ color: dot }}>
          <i />
          {nowLabel(m, openSince)}
        </span>
        <InkMenu items={items} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "flex-end", gap: 8, flex: 1, minWidth: 0 }}>
            <span className="mono" style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.05em", lineHeight: 1, color: pctColor(m.pct), whiteSpace: "nowrap" }}>{uptimePct(m.pct)}</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11.5, lineHeight: 1.2, color: "var(--ink-3)", minWidth: 0, paddingBottom: 2 }}>
              <span style={{ color: "var(--ink-2)", fontWeight: 600, whiteSpace: "nowrap" }}>uptime · {windowLabel}</span>
              <span className="ellipsis">{m.incidents ? plural(m.incidents, "incident") : "No incidents"}</span>
            </span>
          </span>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, fontSize: 11, color: "var(--ink-3)", flex: "none", paddingBottom: 2 }}>
            <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap" }}>{m.latencyMs > 0 ? `${Math.round(m.latencyMs)} ms` : "— ms"}</span>
            <LiveAgo iso={m.lastCheckAt} />
          </span>
        </div>
        <UptimeBars data={toUptimeData(m.bars)} height={30} gap={3} />
      </div>
      {editing && createPortal(<RenameDialog m={m} onClose={() => setEditing(false)} />, document.body)}
    </div>
  );
}

/** "…" menu styled for the dark header band. */
function InkMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <span ref={ref} style={{ position: "relative", display: "flex" }}>
      <button type="button" className="ink-dots" aria-label="More actions" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="menu" style={{ right: 0, top: 34, minWidth: 190 }}>
          {items.map((it) => (
            <button key={it.label} type="button" className="menu-item" style={{ color: it.danger ? "var(--crit-ink)" : "var(--ink)" }} onClick={(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}>
              {it.icon && <span style={{ display: "flex", color: it.danger ? "var(--crit-ink)" : "var(--ink-3)" }}><Icon name={it.icon} size={15} /></span>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** "checked 12s ago", re-rendered every few seconds. */
function LiveAgo({ iso }: { iso: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  return <span style={{ whiteSpace: "nowrap" }}>{checkedAgo(iso)}</span>;
}

function RenameDialog({ m, onClose }: { m: MonitorView; onClose: () => void }) {
  const shell = useShell();
  const [name, setName] = useState(m.name);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v || v === m.name) return onClose();
    setBusy(true);
    try {
      await patch(`/api/monitors/${m.id}`, { name: v });
      shell.toast({ kind: "ok", title: "Monitor renamed", text: v });
      invalidate("/api/uptime");
      onClose();
    } catch (err) {
      shell.toast({ kind: "error", title: "Couldn't rename monitor", text: errMsg(err) });
      setBusy(false);
    }
  };
  return (
    <Dialog onClose={onClose} width={420}>
      <DialogHeader icon="edit" title="Rename monitor" sub={m.target} monoSub onClose={onClose} />
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label className="field">
          Name
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nextcloud" />
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !name.trim()}>{busy ? <span className="spinner" /> : null}Save</button>
        </div>
      </form>
    </Dialog>
  );
}
