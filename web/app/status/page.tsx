"use client";

import { useEffect, useState } from "react";
import { Icon, Logo } from "@/components/icons";
import { LogoTile } from "@/components/auth/AuthCard";
import { UptimeBars } from "@/components/ui";
import { toUptimeData } from "@/components/uptime/bars";
import { ApiError, get } from "@/lib/api";
import { C, halo, uptimePct } from "@/lib/format";
import type { UpStatus, UptimeBar } from "@/lib/types";

// GET /api/public/status — not in lib/types.ts, so typed loosely here.
interface PublicStatus {
  title: string;
  overall: UpStatus | number | string;
  monitors: { name: string; status: UpStatus; pct: number; bars: UptimeBar[] }[];
}

const pctColor = (p: number) => (p < 0 ? "var(--ink-3)" : p >= 99.9 ? C.ok : p >= 99 ? C.warn : C.crit);
const dotColor = (s: UpStatus) => (s === "up" ? C.ok : s === "degraded" ? C.warn : s === "down" ? C.crit : "#9aa1ad");

function overallOf(d: PublicStatus): { label: string; cls: "ok" | "warn" | "crit" | "muted"; color: string } {
  const down = d.monitors.filter((m) => m.status === "down").length;
  const deg = d.monitors.filter((m) => m.status === "degraded").length;
  const o = typeof d.overall === "string" ? d.overall : "";
  if (o === "down" || down) return { label: down > 1 ? "Major outage" : "Partial outage", cls: "crit", color: C.crit };
  if (o === "degraded" || deg) return { label: "Degraded performance", cls: "warn", color: C.warn };
  if (!d.monitors.length) return { label: "No monitors", cls: "muted", color: "#9aa1ad" };
  return { label: "All systems operational", cls: "ok", color: C.ok };
}

export default function StatusPage() {
  const [data, setData] = useState<PublicStatus | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "disabled" | "error">("loading");
  const [error, setError] = useState("");
  const [at, setAt] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      get<PublicStatus>("/api/public/status")
        .then((d) => {
          if (!alive) return;
          setData(d);
          setState("ok");
          setAt(new Date());
          if (d.title) document.title = `${d.title} · Status`;
        })
        .catch((e) => {
          if (!alive) return;
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) setState("disabled");
          else if (!data) {
            setState("error");
            setError(e instanceof Error ? e.message : String(e));
          }
        });
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const o = data ? overallOf(data) : null;
  const avg = data?.monitors.length ? (typeof data.overall === "number" ? data.overall : data.monitors.filter((m) => m.pct >= 0).reduce((s, m, _, a) => s + m.pct / a.length, 0)) : -1;

  return (
    <main style={{ minHeight: "100vh", padding: "56px 20px 40px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ width: "min(760px,100%)", display: "flex", flexDirection: "column", gap: 20, animation: "rise .4s ease both" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "22px 26px", borderRadius: 26, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 1px 2px rgba(20,24,40,.05),0 14px 44px rgba(20,24,40,.12)" }}>
          <LogoTile size={48} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{data?.title || "Status"}</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, opacity: 0.65 }}>{at ? `Updated ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} · refreshes every minute` : "Service status"}</p>
          </div>
          {state === "ok" && o && (
            <span className="ink-status" style={{ color: o.color.startsWith("#") ? o.color : "#9aa1ad" }}>
              <i />
              {avg >= 0 ? uptimePct(avg) : o.label}
            </span>
          )}
        </header>

        {state === "loading" && (
          <div className="glass-card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <span className="skel" style={{ height: 22, width: "45%" }} />
            {[0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 60, borderRadius: 14 }} />)}
          </div>
        )}

        {(state === "disabled" || state === "error") && (
          <div className="glass-card" style={{ padding: "44px 28px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 14 }}>
            <span style={{ width: 64, height: 64, borderRadius: 20, background: "var(--fill-1)", display: "grid", placeItems: "center", color: "var(--ink-3)" }}>
              <Icon name={state === "disabled" ? "lock" : "alert"} size={28} />
            </span>
            <span style={{ fontSize: 17, fontWeight: 700 }}>{state === "disabled" ? "Status page is not enabled" : "Status unavailable"}</span>
            <span style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55, maxWidth: 380 }}>
              {state === "disabled" ? "The owner of this Dockhand hasn't made uptime public. It can be turned on under Uptime → Configure → Public status page." : error}
            </span>
          </div>
        )}

        {state === "ok" && data && o && (
          <>
            <div className="glass-card" style={{ padding: "18px 22px", borderRadius: 22, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: o.color, boxShadow: `0 0 0 5px ${halo(o.color.startsWith("#") ? o.color : "#9aa1ad")}`, flex: "none" }} />
              <span style={{ fontSize: 17, fontWeight: 700, flex: 1, minWidth: 180 }}>{o.label}</span>
              {avg >= 0 && (
                <span className={`pill ${o.cls}`}>
                  {uptimePct(avg)} uptime
                </span>
              )}
            </div>

            <div className="glass-card" style={{ padding: "8px 22px", borderRadius: 24 }}>
              {data.monitors.map((m, i) => (
                <div key={m.name + i} style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 0", borderTop: i ? "1px solid var(--line-1)" : undefined }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor(m.status), boxShadow: `0 0 0 3px ${halo(dotColor(m.status))}`, flex: "none" }} />
                    <span className="ellipsis" style={{ fontSize: 14.5, fontWeight: 700, flex: 1, minWidth: 0 }}>{m.name}</span>
                    <span style={{ fontSize: 12, color: "var(--ink-3)", textTransform: "capitalize" }}>{m.status === "up" ? "Operational" : m.status}</span>
                    <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: pctColor(m.pct), minWidth: 64, textAlign: "right" }}>{uptimePct(m.pct)}</span>
                  </div>
                  <UptimeBars data={toUptimeData(m.bars)} height={30} gap={3} />
                </div>
              ))}
              {!data.monitors.length && <div style={{ padding: "20px 0", fontSize: 13, color: "var(--ink-3)" }}>Nothing is being monitored yet.</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--ink-3)" }}>
              <span>30 buckets · oldest on the left</span>
            </div>
          </>
        )}

        <footer style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>
          <span style={{ width: 20, height: 20, borderRadius: 6, background: "linear-gradient(145deg,#2a3044,#14171f)", display: "grid", placeItems: "center" }}>
            <Logo size={12} />
          </span>
          Powered by <b style={{ color: "var(--ink-2)", fontWeight: 700 }}>Dockhand</b>
        </footer>
      </div>
    </main>
  );
}
