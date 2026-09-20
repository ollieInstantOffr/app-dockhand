"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api";
import { C, avatarBg, bytes, initial, plural } from "@/lib/format";
import type { Alert, Container, FleetMetrics, Host, Machine } from "@/lib/types";
import { Icon } from "@/components/icons";
import { PulseSpark } from "@/components/charts/PulseSpark";
import type { PulseSparkDatum } from "@/components/charts/PulseSpark.types";

// Fleet pulse: how hard the fleet is working right now, where it went over the
// last day, and the handful of things worth doing next.

type Metric = "cpu" | "mem" | "disk";
const METRICS: { id: Metric; label: string }[] = [
  { id: "cpu", label: "CPU" },
  { id: "mem", label: "Memory" },
  { id: "disk", label: "Disk" },
];
const HOT = 85;
const WARM = 70;
const SNOOZE_KEY = "dockhand.fleet.snoozed";

const level = (v: number) => (v >= HOT ? C.crit : v >= WARM ? C.warn : C.ok);
const val = (h: Host, m: Metric) => (m === "cpu" ? h.cpu : m === "mem" ? h.mem : h.disk);
const online = (h: Host) => h.status !== "offline" && h.status !== "pending";

export function FleetPulse({ hosts, containers, alerts }: { hosts: Host[]; containers: Container[] | undefined; alerts: Alert[] }) {
  const router = useRouter();
  const [metric, setMetric] = useState<Metric>("cpu");
  const { data: fm } = useApi<FleetMetrics>("/api/fleet/metrics", { refresh: 60000, revalidateOnFocus: false });
  const { data: machines } = useApi<Machine[]>("/api/machines", { refresh: 120000, revalidateOnFocus: false });

  const live = hosts.filter(online);
  const avg = (m: Metric) => (live.length ? live.reduce((n, h) => n + val(h, m), 0) / live.length : 0);
  const now = avg(metric);
  const busiest = [...live].sort((a, b) => val(b, metric) - val(a, metric))[0];
  const hot = live.filter((h) => val(h, metric) >= HOT).length;
  const warm = live.filter((h) => val(h, metric) >= WARM).length - hot;

  const label = METRICS.find((m) => m.id === metric)!.label.toLowerCase();
  const metricLabel = `average ${label} across ${plural(live.length, "host")}`;
  let headline = live.length ? `Everything comfortable — busiest is ${busiest?.name} at ${Math.round(val(busiest!, metric))}%.` : "No hosts are reachable right now.";
  if (hot > 0) headline = `${plural(hot, "host")} over ${HOT}% ${label}${busiest ? ` — ${busiest.name} at ${Math.round(val(busiest, metric))}%` : ""}.`;
  else if (warm > 0) headline = `${plural(warm, "host")} over ${WARM}% ${label}${busiest ? ` — ${busiest.name} at ${Math.round(val(busiest, metric))}%` : ""}.`;

  const series: PulseSparkDatum[] = useMemo(() => (fm?.points ?? []).map((p) => ({ at: p.at, value: p[metric] })), [fm, metric]);
  const trendDelta = fm && fm.prev[metric] > 0 ? fm.avg[metric] - fm.prev[metric] : null;
  const trendColor = trendDelta == null ? "var(--btn-ink)" : trendDelta > 2 ? C.warn : trendDelta < -2 ? C.ok : "var(--btn-ink)";
  const trendText = trendDelta == null ? (series.length ? "no history yet" : "collecting…") : "vs the day before";

  const rows = [...hosts].sort((a, b) => Number(online(b)) - Number(online(a)) || val(b, metric) - val(a, metric));
  const suggestions = useSuggestions(hosts, containers, machines, alerts);

  return (
    <div style={{ borderRadius: 26, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 14px 40px rgba(20,24,40,.18)", padding: "22px 24px 18px", display: "flex", flexDirection: "column", gap: 16, marginBottom: 22, overflow: "hidden", animation: "rise .4s ease both" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 240, flex: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.6 }}>Fleet pulse</span>
          <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span className="big-num" style={{ fontSize: 46, transition: "color .4s", color: live.length ? level(now) : "var(--btn-ink)" }}>{live.length ? `${Math.round(now)}%` : "—"}</span>
            <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.8, whiteSpace: "nowrap" }}>{metricLabel}</span>
          </span>
          <span style={{ fontSize: 13.5, opacity: 0.75, lineHeight: 1.4 }}>{headline}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "none", width: "min(240px, 100%)" }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.55, whiteSpace: "nowrap" }}>Last 24h</span>
            {trendDelta != null && (
              <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, color: trendColor }}>
                {trendDelta > 0 ? "+" : ""}
                {trendDelta.toFixed(1)} pts
              </span>
            )}
            <span className="ellipsis" style={{ fontSize: 11, opacity: 0.65, whiteSpace: "nowrap" }}>{trendText}</span>
          </span>
          <span style={{ position: "relative", display: "block", width: "100%", height: 60 }}>
            {series.length > 1 ? <PulseSpark data={series} color={level(now)} threshold={HOT} /> : <span style={{ display: "block", height: "100%", borderRadius: 12, background: "rgba(127,127,127,.18)" }} />}
          </span>
        </div>

        <div style={{ display: "inline-flex", padding: 3, borderRadius: 13, background: "rgba(127,127,127,.22)", gap: 2, flex: "none", alignSelf: "flex-start" }}>
          {METRICS.map((m) => {
            const on = m.id === metric;
            return (
              <button
                key={m.id}
                onClick={() => setMetric(m.id)}
                style={{ height: 32, padding: "0 13px", border: 0, borderRadius: 10, background: on ? "var(--btn-ink)" : "transparent", color: on ? "var(--btn)" : "var(--btn-ink)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", transition: "all .2s", display: "flex", alignItems: "center", gap: 7 }}
              >
                {m.label}
                <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>{live.length ? `${Math.round(avg(m.id))}%` : "—"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,400px),1fr))", gap: "2px 36px" }}>
        {rows.map((h) => {
          const v = val(h, metric);
          const up = online(h);
          return (
            <button
              key={h.id}
              onClick={() => router.push(`/hosts/${h.id}`)}
              className="pulse-row"
              style={{ display: "grid", gridTemplateColumns: "minmax(120px,160px) minmax(0,1fr) 44px", alignItems: "center", gap: 14, height: 34, border: 0, background: "transparent", borderRadius: 12, padding: "0 8px 0 6px", cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ width: 22, height: 22, borderRadius: 7, background: avatarBg(h.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, flex: "none", opacity: up ? 1 : 0.45 }}>{initial(h.name)}</span>
                <span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600, opacity: up ? 0.92 : 0.5, minWidth: 0 }}>{h.name}</span>
              </span>
              <span style={{ position: "relative", height: 12, display: "block" }}>
                <span style={{ position: "absolute", inset: 0, borderRadius: 6, background: "rgba(127,127,127,.18)" }} />
                <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${up ? Math.max(2, Math.min(100, v)) : 0}%`, minWidth: up ? 4 : 0, borderRadius: 6, background: level(v), boxShadow: v >= WARM ? `0 0 10px ${level(v)}66` : "none", transition: "width .9s cubic-bezier(.2,.8,.2,1), background .4s, box-shadow .4s" }} />
              </span>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, textAlign: "right", color: up ? level(v) : "rgba(127,127,127,.7)", whiteSpace: "nowrap" }}>{up ? `${Math.round(v)}%` : "off"}</span>
            </button>
          );
        })}
      </div>
      <span style={{ fontSize: 11.5, opacity: 0.55, padding: "2px 6px 0" }}>Red bars are over {HOT}%, amber over {WARM}%. Click a host to open it.</span>

      <NextActions suggestions={suggestions} />
      <style>{`.pulse-row:hover{background:rgba(127,127,127,.16)}.sug-chip:hover{background:rgba(127,127,127,.34);transform:translateY(-1px)}`}</style>
    </div>
  );
}

// ─── Next best actions ─────────────────────────────────────────────────────

export interface Suggestion {
  id: string;
  severity: "crit" | "warn" | "info";
  title: string;
  gain?: string;
  href: string;
}

const SEV_COLOR: Record<Suggestion["severity"], string> = { crit: "#ff5f57", warn: C.warn, info: C.blue };

/** Everything worth doing next, worst first, with anything snoozed filtered out. */
function useSuggestions(hosts: Host[], containers: Container[] | undefined, machines: Machine[] | undefined, alerts: Alert[]): { list: Suggestion[]; snoozed: number; snooze: (id: string) => void; reset: () => void } {
  const [snoozedMap, setSnoozedMap] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>;
      const live = Object.fromEntries(Object.entries(raw).filter(([, until]) => until > Date.now()));
      setSnoozedMap(live);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const write = (m: Record<string, number>) => {
    setSnoozedMap(m);
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify(m));
    } catch {
      /* storage unavailable */
    }
  };

  const all = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    const byHost = new Map<string, Container[]>();
    for (const c of containers ?? []) byHost.set(c.hostId, [...(byHost.get(c.hostId) ?? []), c]);

    for (const h of hosts) {
      if (!online(h)) {
        out.push({ id: `offline:${h.id}`, severity: "crit", title: `${h.name} is unreachable`, gain: h.lastError ? "see why" : undefined, href: `/hosts/${h.id}` });
        continue;
      }
      const list = byHost.get(h.id) ?? [];
      const crashed = list.filter((c) => c.state === "dead" || (c.state === "exited" && c.exitCode !== 0));
      if (crashed.length) out.push({ id: `crashed:${h.id}`, severity: "crit", title: `${plural(crashed.length, "container")} crashed on ${h.name}`, gain: crashed[0].name, href: `/hosts/${h.id}?status=crashed` });
      const unhealthy = list.filter((c) => c.health === "unhealthy" || c.state === "restarting");
      if (unhealthy.length) out.push({ id: `unhealthy:${h.id}`, severity: "warn", title: `${plural(unhealthy.length, "container")} unhealthy on ${h.name}`, gain: unhealthy[0].name, href: `/hosts/${h.id}?status=unhealthy` });
      if (h.disk >= HOT) out.push({ id: `disk:${h.id}`, severity: h.disk >= 92 ? "crit" : "warn", title: `Disk ${Math.round(h.disk)}% on ${h.name}`, gain: h.diskTotal ? `${bytes(h.diskTotal - h.diskUsed)} free` : undefined, href: `/hosts/${h.id}?tab=storage` });
      else if (h.mem >= HOT) out.push({ id: `mem:${h.id}`, severity: "warn", title: `Memory ${Math.round(h.mem)}% on ${h.name}`, href: `/hosts/${h.id}` });
      if (h.updates > 0) out.push({ id: `updates:${h.id}`, severity: "info", title: `Update ${plural(h.updates, "container")} on ${h.name}`, href: `/hosts/${h.id}?status=updates` });
      const stopped = list.filter((c) => c.state === "exited" && c.exitCode === 0);
      if (stopped.length >= 5) out.push({ id: `stopped:${h.id}`, severity: "info", title: `${plural(stopped.length, "container")} stopped on ${h.name}`, gain: "clean up", href: `/hosts/${h.id}?status=stopped` });
    }

    for (const m of machines ?? []) {
      if (m.security > 0) out.push({ id: `sec:${m.hostId}`, severity: "crit", title: `${plural(m.security, "security patch", "security patches")} on ${m.name}`, href: `/machines?host=${m.hostId}` });
      else if (m.packages.length > 0) out.push({ id: `pkgs:${m.hostId}`, severity: "info", title: `${plural(m.packages.length, "OS update")} on ${m.name}`, href: `/machines?host=${m.hostId}` });
      if (m.reboot) out.push({ id: `reboot:${m.hostId}`, severity: "warn", title: `${m.name} needs a reboot`, gain: "after updates", href: `/machines?host=${m.hostId}` });
      const bad = m.checks.filter((c) => c.status === "bad").length;
      if (bad > 0) out.push({ id: `hard:${m.hostId}`, severity: "warn", title: `${plural(bad, "hardening check")} failing on ${m.name}`, href: `/machines?host=${m.hostId}&tab=security` });
    }

    // Anything already scrolling past in the alert ticker doesn't need saying twice.
    const ticking = new Set((alerts ?? []).map((a) => `${a.kind}:${a.hostId ?? ""}`));
    const covered = (s: Suggestion) => {
      const host = s.id.split(":")[1] ?? "";
      const kinds: Record<string, string> = { offline: "host_down", crashed: "container_crash", unhealthy: "unhealthy", disk: "disk_space" };
      const kind = kinds[s.id.split(":")[0]];
      return !!kind && ticking.has(`${kind}:${host}`);
    };
    const rank = { crit: 0, warn: 1, info: 2 };
    return out.filter((s) => !covered(s)).sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [hosts, containers, machines, alerts]);

  const list = all.filter((s) => !snoozedMap[s.id]);
  return {
    list,
    snoozed: all.length - list.length,
    snooze: (id: string) => write({ ...snoozedMap, [id]: Date.now() + 24 * 3600 * 1000 }),
    reset: () => write({}),
  };
}

function NextActions({ suggestions }: { suggestions: ReturnType<typeof useSuggestions> }) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const { list, snoozed, snooze, reset } = suggestions;
  const shown = all ? list : list.slice(0, 4);
  const urgent = list.filter((s) => s.severity === "crit").length;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingTop: 14, borderTop: "1px solid rgba(127,127,127,.3)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 4, whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.6 }}>Next best actions</span>
        {urgent > 0 && (
          <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, height: 18, padding: "0 6px", borderRadius: 9, background: "#ff5f57", color: "#fff", display: "inline-flex", alignItems: "center" }}>{urgent} urgent</span>
        )}
      </span>
      {!list.length && <span style={{ fontSize: 12.5, opacity: 0.7 }}>Nothing to do — the fleet is healthy.</span>}
      {shown.map((s) => (
        <span key={s.id} className="sug-chip" style={{ display: "flex", alignItems: "center", gap: 9, height: 36, padding: "0 4px 0 10px", borderRadius: 18, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", fontSize: 12.5, whiteSpace: "nowrap", transition: "background .2s, transform .2s" }}>
          <button onClick={() => router.push(s.href)} style={{ display: "flex", alignItems: "center", gap: 9, border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", padding: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEV_COLOR[s.severity], boxShadow: `0 0 8px ${SEV_COLOR[s.severity]}`, flex: "none" }} />
            <span style={{ fontWeight: 600 }}>{s.title}</span>
            {s.gain && <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>{s.gain}</span>}
          </button>
          <button onClick={() => snooze(s.id)} title="Snooze for a day" aria-label={`Snooze ${s.title} for a day`} style={{ width: 26, height: 26, borderRadius: "50%", border: 0, background: "rgba(127,127,127,.28)", color: "inherit", cursor: "pointer", display: "grid", placeItems: "center", flex: "none", opacity: 0.75 }}>
            <Icon name="x" size={12} strokeWidth={2.4} />
          </button>
        </span>
      ))}
      {list.length > 4 && (
        <button onClick={() => setAll(!all)} style={{ height: 36, padding: "0 14px", borderRadius: 18, border: "1.5px dashed rgba(127,127,127,.5)", background: "transparent", color: "var(--btn-ink)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", opacity: 0.8 }}>
          {all ? "Show less" : `+${list.length - 4} more`}
        </button>
      )}
      {snoozed > 0 && (
        <button onClick={reset} style={{ height: 36, padding: "0 12px", borderRadius: 18, border: 0, background: "transparent", color: "var(--btn-ink)", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: 0.6, marginLeft: "auto" }}>
          Show {snoozed} snoozed
        </button>
      )}
    </div>
  );
}
