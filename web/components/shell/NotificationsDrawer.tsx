"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "../icons";
import { useShell } from "./context";
import { ALERT_FILTERS, alertSummary, isToday, markAllRead, markRead, type AlertFilter } from "../alerts/actions";
import { errMsg, useApi } from "@/lib/api";
import { ago, halo, severityColor } from "@/lib/format";
import type { Alert } from "@/lib/types";

const CSS = `.nd-item{background:transparent}.nd-item.unread{background:var(--fill-1)}.nd-item:hover{background:var(--fill-2)}
.nd-ink{border:0;border-radius:9px;background:rgba(127,127,127,.25);color:var(--btn-ink);font-weight:600;cursor:pointer;white-space:nowrap;display:grid;place-items:center;flex:none}
.nd-ink:hover:not(:disabled){background:rgba(127,127,127,.38);opacity:1 !important}
.nd-seg{flex:1;height:32px;padding:0 12px;border:0;border-radius:9px;background:transparent;color:var(--btn-ink);opacity:.7;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .2s}
.nd-seg:hover{opacity:1}
.nd-seg.on{background:var(--btn-ink);color:var(--btn);opacity:1;box-shadow:0 2px 8px rgba(0,0,0,.18)}`;

export function NotificationsDrawer({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const router = useRouter();
  const [filter, setFilter] = useState<AlertFilter>("all");
  const { data: all } = useApi<Alert[]>("/api/alerts?filter=all", { refresh: 15000 });
  const { data: list, error } = useApi<Alert[]>(`/api/alerts?filter=${filter}`, { refresh: 15000 });

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const open = (a: Alert) => {
    if (!a.read) markRead(a.id).catch((e) => shell.toast({ kind: "error", title: "Couldn't mark read", text: errMsg(e) }));
    // Alerts without a target just get marked read — keep the drawer open.
    if (!a.href) return;
    onClose();
    router.push(a.href);
  };

  const readAll = async () => {
    try {
      await markAllRead();
      shell.toast({ kind: "ok", title: "All caught up", text: "Every notification is marked as read." });
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't mark alerts read", text: errMsg(e) });
    }
  };

  const today = (list ?? []).filter((a) => isToday(a.createdAt));
  const earlier = (list ?? []).filter((a) => !isToday(a.createdAt));
  const groups = [
    { header: "Today", items: today },
    { header: "Earlier", items: earlier },
  ].filter((g) => g.items.length);

  return (
    <>
      <style>{CSS}</style>
      <div className="scrim" onClick={onClose} style={{ background: "rgba(8,10,16,.12)" }} />
      <aside className="drawer" role="dialog" aria-label="Notifications" style={{ width: "min(400px, calc(100vw - 120px))", background: "var(--surface)", border: 0, backdropFilter: "none", WebkitBackdropFilter: "none", boxShadow: "-20px 0 80px rgba(0,0,0,.22)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ background: "var(--btn)", color: "var(--btn-ink)", display: "flex", flexDirection: "column", flex: "none" }}>
          <div style={{ padding: "20px 20px 12px", display: "flex", alignItems: "center", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>Notifications</h2>
            <span className="ellipsis" style={{ fontSize: 12.5, opacity: 0.6, minWidth: 0 }}>{alertSummary(all)}</span>
            <button type="button" className="nd-ink" style={{ marginLeft: "auto", height: 28, padding: "0 10px", fontSize: 12 }} onClick={readAll} disabled={!(all ?? []).some((a) => !a.read)}>
              Mark all read
            </button>
            <button type="button" className="nd-ink" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28, padding: 0, opacity: 0.7 }}>
              <Icon name="x" size={13} />
            </button>
          </div>
          <div style={{ padding: "0 20px 16px" }}>
            <div style={{ display: "flex", padding: 3, borderRadius: 12, background: "rgba(127,127,127,.22)", gap: 2, flexWrap: "wrap" }}>
              {ALERT_FILTERS.map((f) => (
                <button key={f.value} type="button" className={`nd-seg ${filter === f.value ? "on" : ""}`} onClick={() => setFilter(f.value)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "6px 12px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
          {!list && !error &&
            [0, 1, 2, 3].map((i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "12px 10px" }}>
                <span className="skel" style={{ width: 8, height: 8, borderRadius: "50%", marginTop: 6, flex: "none" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
                  <span className="skel" style={{ width: "55%", height: 13 }} />
                  <span className="skel" style={{ width: "90%", height: 10 }} />
                  <span className="skel" style={{ width: "30%", height: 10 }} />
                </span>
              </div>
            ))}
          {error && !list && <div style={{ padding: "32px 12px", textAlign: "center", fontSize: 12.5, color: "var(--crit-ink)" }}>Couldn&apos;t load notifications — {error.message}</div>}
          {groups.map((g) => (
            <Fragment key={g.header}>
              <div className="section-label" style={{ padding: "12px 10px 4px" }}>{g.header}</div>
              {g.items.map((a) => {
                const c = severityColor(a.severity);
                return (
                  <button key={a.id} type="button" className={`nd-item ${a.read ? "" : "unread"}`} onClick={() => open(a)} style={{ display: "flex", gap: 12, padding: "12px 10px", borderRadius: 14, border: 0, cursor: "pointer", textAlign: "left", color: "var(--ink)", opacity: a.read ? 0.6 : 1, width: "100%", flex: "none" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: c, marginTop: 6, flex: "none", boxShadow: `0 0 0 3px ${halo(c)}` }} />
                    <span style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 0 }}>{a.title}</span>
                        <span style={{ fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{ago(a.createdAt)}</span>
                      </span>
                      <span style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{a.text}</span>
                      {a.hostName && <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{a.hostName}</span>}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))}
          {list && !list.length && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 20px", textAlign: "center" }}>
              <span style={{ width: 48, height: 48, borderRadius: 16, background: "rgba(34,160,107,.12)", color: "#22a06b", display: "grid", placeItems: "center" }}>
                <Icon name="check" size={22} strokeWidth={2.2} />
              </span>
              <span style={{ fontSize: 14, fontWeight: 700 }}>All quiet</span>
              <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Nothing needs you right now.</span>
            </div>
          )}
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line-1)", display: "flex", gap: 8 }}>
          <button type="button" className="btn2" style={{ flex: 1 }} onClick={() => go("/alerts")}>All alerts</button>
          <button type="button" className="btn2" style={{ flex: 1 }} onClick={() => go("/settings/notifications")}>Notification settings</button>
        </div>
      </aside>
    </>
  );
}
