"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, Seg, useOutside } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { ALERT_FILTERS, alertSummary, markAllRead, markRead, snooze, type AlertFilter } from "@/components/alerts/actions";
import { errMsg, useApi } from "@/lib/api";
import { ago, halo, severityColor } from "@/lib/format";
import type { Alert } from "@/lib/types";

export default function AlertsPage() {
  const shell = useShell();
  const router = useRouter();
  const [filter, setFilter] = useState<AlertFilter>("all");
  const { data: all } = useApi<Alert[]>("/api/alerts?filter=all", { refresh: 15000 });
  const { data: list, error } = useApi<Alert[]>(`/api/alerts?filter=${filter}`, { refresh: 15000 });
  const loading = !list && !error;

  const readAll = async () => {
    try {
      await markAllRead();
      shell.toast({ kind: "ok", title: "All alerts marked as read" });
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't mark alerts read", text: errMsg(e) });
    }
  };

  const open = async (a: Alert) => {
    if (!a.read) markRead(a.id).catch(() => {});
    if (a.href) router.push(a.href);
  };

  const doSnooze = async (a: Alert, minutes: number, label: string) => {
    try {
      await snooze(a.id, minutes);
      shell.toast({ kind: "ok", title: `Snoozed for ${label}`, text: a.title });
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't snooze alert", text: errMsg(e) });
    }
  };

  const unread = (all ?? []).some((a) => !a.read);

  return (
    <section style={{ animation: "rise .4s ease both", maxWidth: 820 }}>
      <style>{".alert-row:hover,.alert-row:focus-within{z-index:5}"}</style>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <div>
          <h1 className="page-title">Alerts</h1>
          <p className="page-sub">{alertSummary(all)}</p>
        </div>
        <button type="button" className="btn2" style={{ marginLeft: "auto" }} onClick={readAll} disabled={!unread}>
          Mark all read
        </button>
      </div>
      <Seg fit options={ALERT_FILTERS} value={filter} onChange={setFilter} style={{ marginBottom: 16 }} />

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="glass-card" style={{ borderRadius: 18, padding: "16px 18px", display: "flex", gap: 14 }}>
              <span className="skel" style={{ width: 10, height: 10, borderRadius: "50%", marginTop: 5, flex: "none" }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <span className="skel" style={{ width: "35%", height: 14 }} />
                <span className="skel" style={{ width: "90%", height: 11 }} />
                <span className="skel" style={{ width: "60%", height: 11 }} />
              </span>
            </div>
          ))}
        </div>
      ) : error && !list ? (
        <EmptyState icon="alert" title="Couldn't load alerts" text={error.message} />
      ) : !list?.length ? (
        <EmptyState
          icon="check"
          title={filter === "all" ? "All quiet" : filter === "unread" ? "Nothing unread" : "No critical alerts"}
          text="No alerts right now. Dockhand watches every host and container and will tell you the moment something needs attention."
        >
          <button type="button" className="btn" onClick={() => router.push("/settings/notifications")}>Notification rules</button>
        </EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {list.map((a) => {
            const c = severityColor(a.severity);
            return (
              <div key={a.id} className="glass-card alert-row" style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "16px 18px", borderRadius: 18, opacity: a.read ? 0.6 : 1, transition: "opacity .2s", position: "relative" }}>
                <span style={{ width: 10, height: 10, marginTop: 5, borderRadius: "50%", background: c, boxShadow: `0 0 0 4px ${halo(c)}`, flex: "none" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{a.title}</span>
                    {a.hostName && <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{a.hostName}</span>}
                    {a.resolved && <span className="tag ok" style={{ fontSize: 10, padding: "2px 6px" }}>resolved</span>}
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-3)" }} title={new Date(a.createdAt).toLocaleString()}>{ago(a.createdAt)}</span>
                  </div>
                  <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{a.text}</span>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    {a.href && (
                      <button type="button" onClick={() => open(a)} style={{ height: 28, padding: "0 12px", borderRadius: 9, border: 0, background: "var(--btn)", color: "var(--btn-ink)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                        {a.action || "Open"}
                      </button>
                    )}
                    {!a.read && !a.href && (
                      <button type="button" className="btn2 sm" onClick={() => markRead(a.id).catch((e) => shell.toast({ kind: "error", title: "Couldn't mark read", text: errMsg(e) }))}>
                        Mark read
                      </button>
                    )}
                    <SnoozeButton onPick={(m, l) => doSnooze(a, m, l)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const SNOOZE = [
  { minutes: 60, label: "1 hour" },
  { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "24 hours" },
];

function SnoozeButton({ onPick }: { onPick: (minutes: number, label: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <span ref={ref} style={{ position: "relative", display: "flex" }}>
      <button type="button" onClick={() => setOpen(!open)} style={{ height: 28, padding: "0 12px", borderRadius: 9, border: 0, background: open ? "var(--fill-2)" : "var(--fill-1)", color: "var(--ink)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
        Snooze
      </button>
      {open && (
        <div className="menu" style={{ left: 0, top: 34, minWidth: 150 }}>
          {SNOOZE.map((s) => (
            <button
              key={s.minutes}
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onPick(s.minutes, s.label);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
