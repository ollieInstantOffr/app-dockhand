"use client";

import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";
import { EmptyState, PageHeader, Seg } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { MonitorCard, UP_CARD_CSS, WINDOW_LABEL, pctColor } from "@/components/uptime/MonitorCard";
import { ConfigurePanel } from "@/components/uptime/ConfigurePanel";
import { useApi } from "@/lib/api";
import { C, dateTime, duration, halo, plural, uptimePct } from "@/lib/format";
import type { Host, IncidentView, Settings, UpWindow, UptimeOverview } from "@/lib/types";

const WINDOWS: { value: UpWindow; label: string; long: string }[] = [
  { value: "24h", label: "24 hours", long: "the last 24 hours" },
  { value: "7d", label: "7 days", long: "the last 7 days" },
  { value: "30d", label: "30 days", long: "the last 30 days" },
];

type Filter = "all" | "issues" | "net";

export default function UptimePage() {
  return (
    <Suspense fallback={null}>
      <Uptime />
    </Suspense>
  );
}

function Uptime() {
  const shell = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const w = (WINDOWS.some((x) => x.value === params.get("window")) ? params.get("window") : "24h") as UpWindow;
  const [configOpen, setConfigOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const { data, error } = useApi<UptimeOverview>(`/api/uptime?window=${w}`, { refresh: 15000 });
  const { data: hosts } = useApi<Host[]>("/api/hosts");
  const { data: settings } = useApi<Settings>("/api/settings");

  const setWindow = (v: UpWindow) => {
    const q = new URLSearchParams(params.toString());
    if (v === "24h") q.delete("window");
    else q.set("window", v);
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const hostById = useMemo(() => new Map((hosts ?? []).map((h) => [h.id, h])), [hosts]);
  const winLabel = WINDOW_LABEL[w];
  const winLong = WINDOWS.find((x) => x.value === w)!.long;

  // monitorId → start of its open incident (for "DOWN 3m" header labels)
  const openSince = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data?.incidents ?? []) if (!i.endedAt && !m.has(i.monitorId)) m.set(i.monitorId, i.startedAt);
    return m;
  }, [data]);

  const all = useMemo(() => [...(data?.hosts ?? []), ...(data?.monitors ?? [])], [data]);
  const summary = useMemo(() => {
    if (!data) return "Checking every host and service…";
    const active = all.filter((m) => m.enabled);
    if (!active.length) return "No monitors yet — add a host or a service to start tracking uptime.";
    const down = active.filter((m) => m.status === "down").length;
    const deg = active.filter((m) => m.status === "degraded").length;
    const tail = `${uptimePct(data.stats.overall)} over ${winLong}`;
    if (!down && !deg) return `All ${plural(active.length, "monitor")} up · ${tail}`;
    const parts = [down && `${down} down`, deg && `${deg} degraded`].filter(Boolean).join(", ");
    return `${parts} of ${active.length} · ${tail}`;
  }, [data, all, winLong]);

  const monitors = useMemo(() => {
    const list = data?.monitors ?? [];
    if (filter === "issues") return list.filter((m) => m.status === "down" || m.status === "degraded" || !m.enabled || m.status === "paused");
    if (filter === "net") return list.filter((m) => m.type === "http" || m.type === "tcp");
    return list;
  }, [data, filter]);

  const intervalLabel = settings ? ({ 30: "30s", 60: "minute", 300: "5 minutes" } as Record<number, string>)[settings.uptime.intervalSec] ?? `${settings.uptime.intervalSec}s` : "…";

  return (
    <section style={{ animation: "rise .4s ease both", display: "flex", flexDirection: "column", gap: 24, maxWidth: 1360 }}>
      <style>{UP_CARD_CSS}</style>
      <PageHeader title="Uptime" sub={summary}>
        <Seg fit options={WINDOWS} value={w} onChange={setWindow} />
        <button
          type="button"
          onClick={() => setConfigOpen((v) => !v)}
          aria-pressed={configOpen}
          style={{ height: 40, padding: "0 14px", borderRadius: 12, border: `1px solid ${configOpen ? "var(--line-3)" : "transparent"}`, background: configOpen ? "var(--surface)" : "var(--fill-1)", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", color: "var(--ink)", display: "flex", alignItems: "center", gap: 8, boxShadow: configOpen ? "0 2px 8px rgba(30,40,70,.12)" : undefined }}
        >
          <Icon name="sliders" size={16} />
          Configure
        </button>
        <button type="button" className="btn" onClick={() => shell.openDialog({ type: "monitor" })}>
          <Icon name="plus" size={16} />
          Add monitor
        </button>
      </PageHeader>

      {error && !data ? (
        <EmptyState icon="alert" title="Couldn't load uptime" text={error.message} />
      ) : (
        <>
          <StatsStrip data={data} winLong={winLong} />
          {configOpen && <ConfigurePanel hosts={hosts ?? []} />}

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Hosts</span>
              <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>SSH reachability every {intervalLabel}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 14, fontSize: 11.5, color: "var(--ink-3)" }}>
                {[["up", C.ok], ["degraded", C.warn], ["down", C.crit]].map(([l, c]) => (
                  <span key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: c }} />
                    {l}
                  </span>
                ))}
              </span>
            </div>
            <CardGrid loading={!data} count={3}>
              {data?.hosts.map((m) => <MonitorCard key={m.id} m={m} host={m.hostId ? hostById.get(m.hostId) : undefined} windowLabel={winLabel} openSince={openSince.get(m.id)} />)}
            </CardGrid>
            {data && !data.hosts.length && <Hint text="No hosts are monitored. Add a host, or pick hosts under Configure." />}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>Containers &amp; services</span>
              <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{data ? plural(data.monitors.length, "monitor") : ""}</span>
              <div style={{ marginLeft: "auto" }}>
                <Seg<Filter> fit options={[{ value: "all", label: "All" }, { value: "issues", label: "Issues" }, { value: "net", label: "HTTP & TCP" }]} value={filter} onChange={setFilter} />
              </div>
            </div>
            <CardGrid loading={!data} count={4}>
              {monitors.map((m) => <MonitorCard key={m.id} m={m} host={m.hostId ? hostById.get(m.hostId) : undefined} windowLabel={winLabel} openSince={openSince.get(m.id)} />)}
            </CardGrid>
            {data && !monitors.length && (
              <Hint
                text={
                  filter === "issues" ? "Nothing is down, degraded or paused." : filter === "net" ? "No HTTP or TCP monitors yet." : "No container or service monitors yet. Turn on auto-monitoring under Configure, or add one."
                }
                action={filter === "all" ? { label: "Add monitor", go: () => shell.openDialog({ type: "monitor" }) } : undefined}
              />
            )}
          </div>

          <Incidents list={data?.incidents} loading={!data} />
        </>
      )}
    </section>
  );
}

function StatsStrip({ data, winLong }: { data?: UptimeOverview; winLong: string }) {
  const s = data?.stats;
  const stats: { k: string; v: string; sub: string; icon: IconName; tint: string; color?: string }[] | null = s
    ? [
        { k: "Overall uptime", v: uptimePct(s.overall), sub: winLong.replace(/^the /, ""), icon: "checkCircle", tint: s.overall < 0 ? C.blue : pctColor(s.overall), color: s.overall < 0 ? undefined : pctColor(s.overall) },
        { k: "Monitors up", v: `${s.monitorsUp}/${s.monitorsTotal}`, sub: s.monitorsUp === s.monitorsTotal ? "all healthy" : `${s.monitorsTotal - s.monitorsUp} need attention`, icon: "pulse", tint: s.monitorsUp === s.monitorsTotal ? C.ok : C.crit },
        { k: "Avg latency", v: s.avgLatencyMs > 0 ? `${Math.round(s.avgLatencyMs)} ms` : "—", sub: "across all checks", icon: "globe", tint: C.blue },
        { k: "Incidents", v: String(s.incidents), sub: s.openIncidents ? `${s.openIncidents} still open` : "none open", icon: "alert", tint: s.openIncidents ? C.crit : s.incidents ? C.warn : C.ok, color: s.openIncidents ? C.crit : undefined },
      ]
    : null;
  return (
    <div style={{ borderRadius: 26, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 1px 2px rgba(20,24,40,.05),0 14px 44px rgba(20,24,40,.12)", padding: "22px 26px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,170px),1fr))", gap: 26, alignItems: "center" }}>
      {stats
        ? stats.map((st) => (
            <div key={st.k} style={{ display: "flex", alignItems: "center", gap: 16, minWidth: 0 }}>
              <span style={{ width: 44, height: 44, borderRadius: 14, background: halo(st.tint, 0.2), color: st.tint, display: "grid", placeItems: "center", flex: "none" }}>
                <Icon name={st.icon} size={20} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1, color: st.color ?? "var(--btn-ink)", whiteSpace: "nowrap" }}>{st.v}</span>
                <span className="ellipsis" style={{ fontSize: 11.5, opacity: 0.65 }}>{st.k} · {st.sub}</span>
              </span>
            </div>
          ))
        : [0, 1, 2, 3].map((i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <span style={{ width: 44, height: 44, borderRadius: 14, background: "rgba(127,127,127,.22)", flex: "none" }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <span style={{ width: "55%", height: 22, borderRadius: 8, background: "rgba(127,127,127,.22)" }} />
                <span style={{ width: "80%", height: 10, borderRadius: 8, background: "rgba(127,127,127,.16)" }} />
              </span>
            </div>
          ))}
    </div>
  );
}

function CardGrid({ loading, count, children }: { loading: boolean; count: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,340px),1fr))", gap: 14 }}>
      {loading
        ? Array.from({ length: count }).map((_, i) => (
            <div key={i} className="glass-card" style={{ borderRadius: 26, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "14px 16px", background: "var(--btn)" }}>
                <span style={{ width: 34, height: 34, borderRadius: 11, background: "rgba(127,127,127,.22)", flex: "none" }} />
                <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ width: "50%", height: 13, borderRadius: 8, background: "rgba(127,127,127,.22)" }} />
                  <span style={{ width: "70%", height: 10, borderRadius: 8, background: "rgba(127,127,127,.16)" }} />
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px" }}>
                <span className="skel" style={{ width: "45%", height: 30 }} />
                <span className="skel" style={{ height: 30, borderRadius: 6 }} />
              </div>
            </div>
          ))
        : children}
    </div>
  );
}

function Hint({ text, action }: { text: string; action?: { label: string; go: () => void } }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderRadius: 16, border: "1px dashed var(--line-3)", fontSize: 13, color: "var(--ink-3)", flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 200 }}>{text}</span>
      {action && (
        <button type="button" className="btn2 sm" onClick={action.go}>
          <Icon name="plus" size={13} />
          {action.label}
        </button>
      )}
    </div>
  );
}

function Incidents({ list, loading }: { list?: IncidentView[]; loading: boolean }) {
  return (
    <div className="glass-card" style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>Incidents</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>last 30 days</span>
      </div>
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,300px),1fr))", gap: 10 }}>
          {[0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 82, borderRadius: 16 }} />)}
        </div>
      ) : !list?.length ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--ink-3)", padding: "4px 2px" }}>
          <span style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(34,160,107,.12)", color: C.ok, display: "grid", placeItems: "center" }}>
            <Icon name="check" size={14} strokeWidth={2.4} />
          </span>
          No incidents in the last 30 days.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,300px),1fr))", gap: 10 }}>
          {list.map((i) => {
            const color = i.status === "down" ? C.crit : C.warn;
            const open = !i.endedAt;
            return (
              <div key={i.id} style={{ display: "flex", gap: 12, padding: "14px 16px", borderRadius: 16, background: "var(--fill-1)" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 5, flex: "none", boxShadow: `0 0 0 3px ${halo(color)}` }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span className="ellipsis" style={{ fontSize: 13, fontWeight: 700 }}>{i.target}</span>
                    <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color, whiteSpace: "nowrap" }}>{open ? `ongoing · ${duration(i.durationSec)}` : duration(i.durationSec)}</span>
                  </span>
                  <span style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{i.message || (i.status === "down" ? "Unreachable" : "Degraded")}</span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    {dateTime(i.startedAt)}
                    {i.endedAt ? ` → ${dateTime(i.endedAt)}` : " · still open"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
