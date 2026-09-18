"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api";
import { C, ago, avatarBg, greeting, initial, plural, severityColor } from "@/lib/format";
import type { Alert, Container, Host, Overview } from "@/lib/types";
import { EmptyState, Skel } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { HoverStyles } from "@/components/host/HoverStyles";
import { FleetDonut } from "@/components/charts/FleetDonut";
import { SemiGauge } from "@/components/charts/SemiGauge";
import { InkStatus, gaugeColor, hostBigColor, hostDot, hostStatusShort, stoppedText } from "@/components/host/bits";
import { markRead } from "@/components/alerts/actions";

const GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,300px),1fr))", gap: 18 };
const CARD: React.CSSProperties = { borderRadius: 26, background: "var(--surface)", boxShadow: "var(--card-shadow)", display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 };

type SegKey = "running" | "unhealthy" | "stopped" | "down";
interface Seg {
  key: SegKey;
  label: string;
  color: string;
  n: number;
  hosts: Set<string>;
}

export default function FleetPage() {
  const router = useRouter();
  const { openDialog, user } = useShell();
  const { data: hosts, error: hostsErr } = useApi<Host[]>("/api/hosts", { refresh: 10000 });
  const { data: ov } = useApi<Overview>("/api/overview", { refresh: 10000 });
  const { data: containers } = useApi<Container[]>(hosts && hosts.length ? "/api/containers" : null, { refresh: 15000 });
  const { data: alerts } = useApi<Alert[]>("/api/alerts?filter=unread", { refresh: 15000 });
  const [segFilter, setSegFilter] = useState<SegKey | null>(null);
  const first = user.name.trim().split(/\s+/)[0];
  const hello = first ? `${greeting()}, ${first}` : greeting();

  const loading = !hosts && !hostsErr;
  const empty = !!hosts && hosts.length === 0;
  const attention = ov?.attention ?? [];
  const ticker = (alerts ?? []).filter((a) => !a.read && !a.resolved && (a.severity === "crit" || a.severity === "warn"));

  const nHosts = ov?.hosts ?? hosts?.length ?? 0;
  const running = ov?.running ?? hosts?.reduce((a, h) => a + h.running, 0) ?? 0;

  let summary = "Checking in on your fleet…";
  if (hostsErr && !hosts) summary = "Couldn't load your hosts.";
  else if (empty) summary = "Add a host to get started.";
  else if (hosts) summary = `${plural(nHosts, "host")} · ${running} container${running === 1 ? "" : "s"} running · ${attention.length ? `${attention.length} need${attention.length === 1 ? "s" : ""} attention` : "all healthy"}`;

  const segs = useMemo<Seg[]>(() => {
    const mk = (key: SegKey, label: string, color: string): Seg => ({ key, label, color, n: 0, hosts: new Set() });
    const s: Record<SegKey, Seg> = { running: mk("running", "Running", C.ok), unhealthy: mk("unhealthy", "Unhealthy", C.warn), stopped: mk("stopped", "Stopped", "#9aa1ad"), down: mk("down", "Crashed · offline", C.crit) };
    const offline = new Set((hosts ?? []).filter((h) => h.status === "offline").map((h) => h.id));
    for (const h of hosts ?? []) {
      if (offline.has(h.id) && h.total > 0) {
        s.down.n += h.total;
        s.down.hosts.add(h.id);
      }
    }
    for (const c of containers ?? []) {
      if (offline.has(c.hostId)) continue;
      let k: SegKey;
      if (c.state === "running") k = c.health === "unhealthy" || c.health === "starting" ? "unhealthy" : "running";
      else if (c.state === "restarting") k = "unhealthy";
      else if (c.state === "dead" || (c.state === "exited" && c.exitCode !== 0)) k = "down";
      else k = "stopped";
      s[k].n++;
      s[k].hosts.add(c.hostId);
    }
    return [s.running, s.unhealthy, s.stopped, s.down];
  }, [hosts, containers]);
  const totalCtr = segs.reduce((a, g) => a + g.n, 0);

  const filterHosts = segFilter ? segs.find((g) => g.key === segFilter)?.hosts : null;
  // Opening a host from a donut segment lands on its Containers tab filtered to that status.
  const SEG_STATUS: Record<SegKey, string> = { running: "running", unhealthy: "unhealthy", stopped: "stopped", down: "crashed" };
  const hostHref = (id: string, seg: SegKey | null) => `/hosts/${id}${seg ? `?status=${SEG_STATUS[seg]}` : ""}`;
  const pickSeg = (k: SegKey) => {
    const g = segs.find((x) => x.key === k);
    if (!g || g.n === 0) return;
    if (g.hosts.size === 1) {
      router.push(hostHref([...g.hosts][0], k));
      return;
    }
    setSegFilter(segFilter === k ? null : k);
  };

  return (
    <section data-screen-label="Fleet" style={{ animation: "rise .4s ease both" }}>
      <HoverStyles />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 20, flexWrap: "wrap", marginBottom: 26 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em" }} suppressHydrationWarning>
            {hello}
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 15, color: "var(--ink-2)" }}>{summary}</p>
        </div>
      </div>

      {ticker.length > 0 && !empty && <AlertTicker alerts={ticker} />}

      {loading && (
        <div style={GRID}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="glass-card" style={{ borderRadius: 22, padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Skel w={38} h={38} r={12} style={{ flex: "none" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <Skel w="40%" h={14} />
                  <Skel w="65%" h={10} />
                </span>
                <Skel w={64} h={22} r={20} />
              </div>
              <div style={{ display: "flex", gap: 18 }}>
                <Skel w={44} h={44} r="50%" />
                <Skel w={44} h={44} r="50%" />
                <Skel w={44} h={44} r="50%" />
              </div>
              <Skel w="100%" h={28} />
            </div>
          ))}
        </div>
      )}

      {hostsErr && !hosts && (
        <EmptyState icon="alert" title="Couldn't load hosts" text={hostsErr.message}>
          <button className="btn2" style={{ height: 40 }} onClick={() => window.location.reload()}>
            Try again
          </button>
        </EmptyState>
      )}

      {empty && (
        <EmptyState icon="server" title="No hosts yet" text="Connect the first machine running Docker. Dockhand talks to it over SSH — there is nothing to install on the host.">
          <button className="btn" onClick={() => openDialog({ type: "host" })}>
            Add your first host
          </button>
          <button className="btn2" style={{ height: 40 }} onClick={() => router.push("/settings/hosts")}>
            Import from SSH config
          </button>
        </EmptyState>
      )}

      {hosts && hosts.length > 0 && (
        <div style={GRID}>
          <FleetCard segs={segs} total={totalCtr} hosts={hosts.length} loaded={!!containers} active={segFilter} onPick={pickSeg} onClear={() => setSegFilter(null)} />
          {hosts.map((h) => (
            <HostCard key={h.id} h={h} dim={!!filterHosts && !filterHosts.has(h.id)} onOpen={() => router.push(hostHref(h.id, filterHosts?.has(h.id) ? segFilter : null))} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Alerts ticker ─────────────────────────────────────────────────────────

function AlertTicker({ alerts }: { alerts: Alert[] }) {
  const router = useRouter();
  const { openNotifications } = useShell();
  const [paused, setPaused] = useState(false);
  // Repeat the chips so one half of the strip is always wider than the viewport, then
  // duplicate that half: translating by -50% then loops seamlessly.
  const reps = Math.max(1, Math.ceil(6 / alerts.length));
  const half = Array.from({ length: reps }, () => alerts).flat();
  const loop = [...half, ...half];
  const dur = `${Math.max(24, half.length * 7)}s`;
  const go = (a: Alert) => {
    markRead(a.id).catch(() => {});
    if (a.href) router.push(a.href);
    else openNotifications();
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, height: 48, padding: "0 6px 0 16px", borderRadius: 24, background: "var(--btn)", color: "var(--btn-ink)", boxShadow: "0 14px 40px rgba(20,24,40,.18)", marginBottom: 26, overflow: "hidden", animation: "rise .4s ease both" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none", fontSize: 12, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", opacity: 0.9 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ff5f57", boxShadow: "0 0 10px #ff5f57", animation: "downPulse 1.6s ease-in-out infinite" }} />
        {plural(alerts.length, "alert")}
      </span>
      <span style={{ width: 1, height: 20, background: "rgba(127,127,127,.35)", flex: "none" }} />
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        style={{ flex: 1, minWidth: 0, overflow: "hidden", position: "relative", height: 34, maskImage: "linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)", WebkitMaskImage: "linear-gradient(90deg,transparent,#000 24px,#000 calc(100% - 24px),transparent)" }}
      >
        <div style={{ position: "absolute", left: 0, top: 0, display: "flex", alignItems: "center", gap: 6, width: "max-content", animation: `ticker ${dur} linear infinite`, animationPlayState: paused ? "paused" : "running" }}>
          {loop.map((a, i) => {
            const solid = severityColor(a.severity);
            return (
              <button
                key={`${a.id}-${i}`}
                className="tick-chip"
                onClick={() => go(a)}
                tabIndex={i < alerts.length ? 0 : -1}
                aria-hidden={i >= alerts.length || undefined}
                style={{ display: "flex", alignItems: "center", gap: 9, height: 34, padding: "0 12px 0 10px", borderRadius: 17, border: 0, background: "rgba(127,127,127,.18)", color: "var(--btn-ink)", fontSize: 12.5, cursor: "pointer", whiteSpace: "nowrap", flex: "none", transition: "background .2s" }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: solid, boxShadow: `0 0 8px ${solid}` }} />
                {a.hostName && <span className="mono" style={{ opacity: 0.7 }}>{a.hostName}</span>}
                <span style={{ fontWeight: 600 }}>{a.title}</span>
                <span style={{ opacity: 0.55, fontSize: 11.5 }} suppressHydrationWarning>{ago(a.createdAt)}</span>
                <span style={{ fontWeight: 700, color: solid }}>{a.action || "Open"} →</span>
              </button>
            );
          })}
        </div>
      </div>
      <button onClick={openNotifications} style={{ height: 36, padding: "0 14px", borderRadius: 18, border: 0, background: "var(--btn-ink)", color: "var(--btn)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", flex: "none" }}>
        Open inbox
      </button>
    </div>
  );
}

// ─── Fleet summary card ────────────────────────────────────────────────────

function FleetCard({ segs, total, hosts, loaded, active, onPick, onClear }: { segs: Seg[]; total: number; hosts: number; loaded: boolean; active: SegKey | null; onPick: (k: SegKey) => void; onClear: () => void }) {
  const [hi, setHi] = useState<number | null>(null);
  const activeIdx = active ? segs.findIndex((g) => g.key === active) : -1;
  const shown = hi ?? (activeIdx >= 0 ? activeIdx : null);
  const cur = shown != null ? segs[shown] : null;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  return (
    <div style={CARD} onMouseLeave={() => setHi(null)}>
      <div className="ink-head">
        <span style={{ width: 34, height: 34, borderRadius: 11, background: "rgba(127,127,127,.22)", display: "grid", placeItems: "center", flex: "none" }}>
          <Icon name="grid" size={17} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.2 }}>Fleet</span>
          <span className="mono ellipsis" style={{ fontSize: 11, opacity: 0.6 }}>
            {plural(hosts, "host")} · {loaded ? plural(total, "container") : "…"}
          </span>
        </span>
        {active && (
          <button className="ink-btn" onClick={onClear} title="Clear filter" style={{ height: 28, padding: "0 10px", borderRadius: 9, border: 0, background: "rgba(127,127,127,.18)", color: "var(--btn-ink)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", opacity: 0.85, whiteSpace: "nowrap" }}>
            Clear ✕
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "16px 18px 18px", flex: 1 }}>
        {loaded ? (
          <FleetDonut
            data={segs.map((g) => ({ name: g.label, value: g.n, color: g.color }))}
            centerLabel={String(cur ? cur.n : total)}
            centerSub={cur ? cur.label.split(" ")[0].toLowerCase() : "containers"}
            size={104}
            highlight={shown}
            onHover={setHi}
            onPointClick={(d) => {
              const g = segs.find((x) => x.label === d.name);
              if (g) onPick(g.key);
            }}
          />
        ) : (
          <Skel w={104} h={104} r="50%" style={{ flex: "none" }} />
        )}
        <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          {segs.map((g, i) => (
            <button
              key={g.key}
              className="leg-row"
              onMouseEnter={() => setHi(i)}
              onClick={() => onPick(g.key)}
              disabled={g.n === 0}
              title={g.n ? (g.hosts.size === 1 ? "Open host" : "Show hosts with these containers") : undefined}
              style={{ display: "flex", alignItems: "center", gap: 9, height: 27, padding: "0 2px", border: 0, borderTop: "1px solid var(--line-1)", background: "transparent", cursor: g.n ? "pointer" : "default", color: "var(--ink)", fontSize: 12.5, textAlign: "left", opacity: shown == null || shown === i ? 1 : 0.4 }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: g.color, flex: "none" }} />
              <span className="ellipsis" style={{ flex: 1, color: active === g.key ? "var(--ink)" : "var(--ink-2)", fontWeight: active === g.key ? 700 : 400 }}>{g.label}</span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{loaded ? g.n : "–"}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", width: 34, textAlign: "right" }}>{loaded ? `${pct(g.n)}%` : ""}</span>
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

// ─── Host card ─────────────────────────────────────────────────────────────

function HostCard({ h, dim, onOpen }: { h: Host; dim: boolean; onOpen: () => void }) {
  const off = h.status === "offline" || h.status === "pending";
  const dot = hostDot(h);
  const gauges = [
    { label: "CPU", v: h.cpu, base: C.blue },
    { label: "MEM", v: h.mem, base: C.violet },
    { label: "DISK", v: h.disk, base: C.ok },
  ];
  return (
    <button className="fleet-card" onClick={onOpen} style={{ ...CARD, position: "relative", textAlign: "left", border: 0, padding: 0, cursor: "pointer", color: "var(--ink)", opacity: dim ? 0.35 : h.status === "offline" ? 0.6 : 1 }}>
      <div className="ink-head" style={{ width: "100%" }}>
        <span style={{ width: 34, height: 34, borderRadius: 11, background: avatarBg(h.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)" }}>{initial(h.name)}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: 1 }}>
          <span className="ellipsis" style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.2 }}>{h.name}</span>
          <span className="mono ellipsis" style={{ fontSize: 11, opacity: 0.6 }}>
            {h.address}
            {h.os ? ` · ${h.os}` : ""}
          </span>
        </span>
        <InkStatus color={dot} label={hostStatusShort(h)} title={h.lastError || undefined} pulse={h.status === "offline" ? "down" : undefined} />
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 18, padding: "18px 20px 18px 18px", width: "100%" }}>
        <span style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 10, flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span className="big-num" style={{ fontSize: 38, color: hostBigColor(h) }}>{h.running}</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.2 }}>
              of {h.total}
              <br />
              running
            </span>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {h.updates > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 5, height: 24, padding: "0 9px 0 7px", borderRadius: 8, background: "rgba(47,111,237,.1)", color: "#2f6fed", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                <Icon name="update" size={12} strokeWidth={2} />
                {plural(h.updates, "update")}
              </span>
            )}
            <span style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{stoppedText(h)}</span>
          </span>
        </span>
        <span style={{ display: "flex", gap: 14, alignItems: "flex-end" }}>
          {gauges.map((g) => (
            <SemiGauge key={g.label} label={g.label} value={off ? 0 : g.v} color={off ? "#9aa1ad" : gaugeColor(g.v, g.base)} width={54} valueLabel={off ? "—" : undefined} />
          ))}
        </span>
      </div>
    </button>
  );
}
