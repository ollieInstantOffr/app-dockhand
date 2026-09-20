"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, get, invalidate, post, useApi } from "@/lib/api";
import { C, ago, avatarBg, duration, halo, initial, plural } from "@/lib/format";
import type { CheckStatus, Impact, JobRef, Machine, MachineCheck, MachinePackage, MachineService, PatchImpact } from "@/lib/types";
import { Tabs } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { trackJob } from "@/components/host/jobs";
import { impactDetails } from "@/components/impact/Impact";

// The machine side of a host — OS updates, hardening checks, ports and
// services. Used twice: as a tab on the host page (embedded) and as the detail
// panel on the fleet-wide Machines page.

export const MACHINE_INVALIDATE = ["/api/machines", "/api/baselines"];
export const CHECK_COLOR: Record<CheckStatus, string> = { ok: C.ok, warn: C.warn, bad: C.crit, unknown: "var(--fill-2)" };
export type MachineTab = "updates" | "security" | "services";
const INVALIDATE = MACHINE_INVALIDATE;
const STATUS_COLOR = CHECK_COLOR;
const CARD: React.CSSProperties = { borderRadius: 26, background: "var(--surface)", boxShadow: "var(--card-shadow)", overflow: "hidden", display: "flex", flexDirection: "column" };

// ─── Machine detail ────────────────────────────────────────────────────────

export function MachineDetail({ machine, tab, onTab }: { machine: Machine; tab: MachineTab; onTab: (t: MachineTab) => void }) {
  const shell = useShell();
  const router = useRouter();
  const { data, mutate } = useApi<Machine>(`/api/machines/${machine.hostId}`, { refresh: 60000, fallbackData: machine });
  const m = data ?? machine;
  const [busy, setBusy] = useState(false);
  const offline = m.status === "offline" || m.status === "pending";
  const dot = offline ? "#9aa1ad" : m.status === "degraded" ? C.warn : C.ok;

  const reload = () => {
    mutate();
    invalidate("/api/machines");
    invalidate("/api/baselines");
  };

  const rescan = async () => {
    setBusy(true);
    try {
      await post(`/api/machines/${m.hostId}/refresh`);
      reload();
      shell.toast({ kind: "ok", title: `Scanned ${m.name}` });
    } catch (e) {
      shell.toast({ kind: "error", title: `Couldn't scan ${m.name}`, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const reboot = async () => {
    // Say what goes down before asking, not after.
    let blast: Impact | undefined;
    try {
      blast = await get<Impact>(`/api/hosts/${m.hostId}/impact?action=reboot`);
    } catch {
      /* the confirm still works without it */
    }
    const ok = await shell.confirm({
      title: `Reboot ${m.name}?`,
      text: blast?.summary ?? "Every container on this machine stops and starts again with it.",
      confirmLabel: "Reboot",
      danger: true,
      icon: "power",
      details: [...impactDetails(blast), ...(m.rebootPkgs.length ? [{ k: "Waiting on", v: m.rebootPkgs.slice(0, 3).join(", ") }] : [])],
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/fix/reboot`), { title: `Rebooting ${m.name}`, done: `${m.name} is rebooting`, invalidate: INVALIDATE });
  };

  const meta = [m.os && `${m.os} ${m.release}`, m.kernel, m.load && `load ${m.load}`, m.tempC != null && `${m.tempC.toFixed(0)}°C`, m.uptimeSec > 0 && `up ${duration(m.uptimeSec)}`].filter(Boolean).join(" · ");

  return (
    <div style={CARD}>
      <div className="ink-head" style={{ gap: 14, padding: "16px 18px 16px 20px", flexWrap: "wrap" }}>
        <span style={{ width: 44, height: 44, borderRadius: 14, background: avatarBg(m.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 17, fontWeight: 700, flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)" }}>{initial(m.name)}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 3, flex: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{m.name}</h2>
            <span className="ink-status" style={{ color: dot }}>
              <i />
              {offline ? "offline" : m.status}
            </span>
          </span>
          <span className="mono ellipsis" style={{ fontSize: 11.5, opacity: 0.6 }}>{meta || "not scanned yet"}</span>
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="ink-fill" onClick={rescan} disabled={busy || offline} style={INK_BTN}>
            {busy ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <Icon name="restart" size={15} />}
            Rescan
          </button>
          <button className="ink-fill" onClick={() => router.push(`/hosts/${m.hostId}`)} style={INK_BTN} title="Everything about this host: containers, stacks, storage, networks — and this panel">
            <Icon name="server" size={15} />
            Open host
          </button>
          <button className="ink-fill" onClick={reboot} disabled={offline} style={INK_BTN}>
            <Icon name="power" size={15} />
            Reboot
          </button>
          <button onClick={() => shell.openTerminal({ kind: "shell", hostId: m.hostId })} disabled={offline} style={{ ...INK_BTN, background: "var(--btn-ink)", color: "var(--btn)" }}>
            <Icon name="terminal" size={15} />
            Open SSH
          </button>
        </span>
      </div>
      <MachineBody m={m} tab={tab} onTab={onTab} reload={reload} />
    </div>
  );
}

/**
 * The machine tabs on the host page: the same Updates / Security / Services as
 * the Machines page, without repeating the host's own header.
 */
export function MachinePanel({ hostId, tab, onTab }: { hostId: string; tab: MachineTab; onTab: (t: MachineTab) => void }) {
  const shell = useShell();
  const { data: m, error, mutate } = useApi<Machine>(`/api/machines/${hostId}`, { refresh: 60000 });
  const [busy, setBusy] = useState(false);
  const reload = () => {
    mutate();
    invalidate("/api/machines");
    invalidate("/api/baselines");
  };
  const rescan = async () => {
    setBusy(true);
    try {
      await post(`/api/machines/${hostId}/refresh`);
      reload();
      shell.toast({ kind: "ok", title: "Machine scanned" });
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't scan this machine", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  if (!m) {
    return (
      <div style={{ padding: "18px 0" }}>
        {error ? (
          <div style={{ padding: "12px 16px", borderRadius: 14, background: "var(--warn-bg)", border: "1px solid rgba(224,160,32,.3)", fontSize: 13, color: "var(--warn-ink)" }}>{error.message}</div>
        ) : (
          [0, 1, 2].map((i) => <span key={i} className="skel" style={{ display: "block", height: 46, borderRadius: 14, marginBottom: 10 }} />)
        )}
      </div>
    );
  }
  const meta = [m.os && `${m.os} ${m.release}`, m.kernel, m.load && `load ${m.load}`, m.tempC != null && `${m.tempC.toFixed(0)}°C`, m.uptimeSec > 0 && `up ${duration(m.uptimeSec)}`].filter(Boolean).join(" · ");
  return (
    <div style={{ ...CARD, borderRadius: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px 0", flexWrap: "wrap" }}>
        <span className="mono ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)", flex: 1, minWidth: 0 }}>{meta || "not scanned yet"}</span>
        <button className="btn2 sm" onClick={rescan} disabled={busy}>
          {busy ? <span className="spinner" style={{ width: 11, height: 11 }} /> : <Icon name="restart" size={13} />}
          Rescan
        </button>
      </div>
      <MachineBody m={m} tab={tab} onTab={onTab} reload={reload} />
    </div>
  );
}

/** Error banner, tab bar and the tab itself — shared by both placements. */
function MachineBody({ m, tab, onTab, reload }: { m: Machine; tab: MachineTab; onTab: (t: MachineTab) => void; reload: () => void }) {
  const tabs: { value: MachineTab; label: string; icon: IconName; count?: number }[] = [
    { value: "updates", label: "Updates", icon: "update", count: m.packages.length || undefined },
    { value: "security", label: "Security", icon: "shield", count: m.checks.filter((c) => c.status === "bad" || c.status === "warn").length || undefined },
    { value: "services", label: "Services", icon: "cpu", count: m.services.filter((s) => s.active === "running").length || undefined },
  ];
  return (
    <>
      {m.error && (
        <div style={{ margin: "14px 20px 0", padding: "10px 14px", borderRadius: 12, background: "var(--warn-bg)", border: "1px solid rgba(224,160,32,.3)", fontSize: 12.5, color: "var(--warn-ink)", lineHeight: 1.5 }}>{m.error}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px 0", flexWrap: "wrap" }}>
        <Tabs items={tabs} value={tab} onChange={onTab} />
      </div>
      {tab === "updates" && <UpdatesTab m={m} reload={reload} />}
      {tab === "security" && <SecurityTab m={m} reload={reload} />}
      {tab === "services" && <ServicesTab m={m} reload={reload} />}
    </>
  );
}

export const INK_BTN: React.CSSProperties = { height: 36, padding: "0 14px", borderRadius: 12, border: 0, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" };

function UpdatesTab({ m, reload }: { m: Machine; reload: () => void }) {
  const shell = useShell();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set(m.packages.filter((p) => p.security).map((p) => p.name))), [m.hostId, m.packages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the current selection would restart, predicted from the package names.
  const [impact, setImpact] = useState<PatchImpact | undefined>();
  const [predicting, setPredicting] = useState(false);
  const pickedKey = [...picked].sort().join(",");
  useEffect(() => {
    if (!picked.size) {
      setImpact(undefined);
      return;
    }
    let alive = true;
    setPredicting(true);
    const t = setTimeout(async () => {
      try {
        const r = await post<PatchImpact>(`/api/machines/${m.hostId}/patch-impact`, { packages: [...picked] });
        if (alive) setImpact(r);
      } catch {
        if (alive) setImpact(undefined);
      } finally {
        if (alive) setPredicting(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pickedKey, m.hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  const aptUpdate = () =>
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/apt-update`), { title: `apt update on ${m.name}`, done: "Package lists refreshed", invalidate: INVALIDATE, onDone: reload });

  const install = async () => {
    const names = [...picked];
    if (!names.length) return;
    const sec = m.packages.filter((p) => picked.has(p.name) && p.security).length;
    const details = [{ k: "Security updates", v: String(sec) }];
    if (impact?.docker) details.push({ k: "Docker restarts", v: `${plural(impact.containers.length, "container")} stop briefly` });
    if (impact?.services.length) details.push({ k: "Services restarting", v: impact.services.join(", ") });
    if (impact?.reboot) details.push({ k: "Afterwards", v: "a reboot is needed to finish" });
    const ok = await shell.confirm({
      title: `Install ${plural(names.length, "update")} on ${m.name}?`,
      text: impact?.summary ?? "apt installs them now, keeping your existing config files.",
      confirmLabel: `Install ${names.length}`,
      danger: !!impact?.docker,
      icon: "update",
      details: [...details, ...names.slice(0, 3).map((n) => ({ k: n, v: m.packages.find((p) => p.name === n)?.candidate ?? "" }))],
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/install`, { packages: names }), { title: `Installing updates on ${m.name}`, done: `${m.name} updated`, invalidate: INVALIDATE, onDone: reload });
  };

  if (m.pkgManager !== "apt") {
    return (
      <div style={{ padding: "14px 20px 20px" }}>
        <div style={{ padding: 18, borderRadius: 16, background: "var(--fill-1)", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
          {m.collectedAt ? "This machine doesn't use apt, so Dockhand can't manage its packages. Its services, ports and hardening checks still work." : "Not scanned yet — press Rescan to read this machine."}
        </div>
      </div>
    );
  }

  if (!m.packages.length) {
    return (
      <div style={{ padding: "14px 20px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 18, borderRadius: 16, background: "var(--fill-1)", flexWrap: "wrap" }}>
          <span style={{ width: 36, height: 36, borderRadius: 11, background: "rgba(34,160,107,.12)", display: "grid", placeItems: "center", flex: "none" }}>
            <Icon name="check" size={18} color={C.ok} strokeWidth={2.6} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 200 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Everything is current</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              {m.lastPatchAt ? `Patched ${ago(m.lastPatchAt)}` : "No pending updates"}
              {m.aptUpdateAt ? ` · package lists from ${ago(m.aptUpdateAt)}` : ""}
            </span>
          </span>
          <button className="btn2" onClick={aptUpdate}>
            <Icon name="restart" size={15} />
            apt update
          </button>
        </div>
      </div>
    );
  }

  const toggle = (name: string) => {
    const n = new Set(picked);
    if (n.has(name)) n.delete(name);
    else n.add(name);
    setPicked(n);
  };
  const allOn = picked.size === m.packages.length;

  return (
    <div style={{ padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", flexDirection: "column", borderRadius: 16, border: "1px solid var(--line-1)", overflow: "hidden" }}>
        <button
          type="button"
          onClick={() => setPicked(allOn ? new Set() : new Set(m.packages.map((p) => p.name)))}
          style={{ display: "flex", alignItems: "center", gap: 14, padding: "9px 16px", border: 0, background: "var(--fill-1)", cursor: "pointer", font: "inherit", color: "var(--ink-3)", fontSize: 11.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", textAlign: "left" }}
        >
          <Box on={allOn} />
          {allOn ? "Deselect all" : "Select all"}
        </button>
        {m.packages.map((p) => <PackageRow key={p.name} p={p} on={picked.has(p.name)} onToggle={() => toggle(p.name)} />)}
      </div>
      {picked.size > 0 && <PatchImpactLine impact={impact} loading={predicting} />}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {picked.size ? `${plural(picked.size, "package")} selected` : "Nothing selected"}
          {m.aptUpdateAt ? ` · lists from ${ago(m.aptUpdateAt)}` : ""}
        </span>
        <button className="btn2" onClick={aptUpdate}>
          <Icon name="restart" size={15} />
          apt update
        </button>
        <button className="btn" onClick={install} disabled={!picked.size} style={{ marginLeft: "auto" }}>
          <Icon name="update" size={15} />
          Install {picked.size || ""} {picked.size === 1 ? "update" : "updates"}
        </button>
      </div>
    </div>
  );
}

/** What installing the selected updates would restart. */
function PatchImpactLine({ impact, loading }: { impact?: PatchImpact; loading: boolean }) {
  if (loading && !impact) return <span className="skel" style={{ height: 44, borderRadius: 14 }} />;
  if (!impact) return null;
  const tone = impact.severity === "crit" ? C.crit : impact.severity === "warn" ? C.warn : C.ok;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", border: `1px solid ${tone}33` }}>
      <span style={{ width: 28, height: 28, borderRadius: 9, background: `${tone}22`, color: tone, display: "grid", placeItems: "center", flex: "none" }}>
        <Icon name={impact.severity === "info" ? "check" : "alert"} size={15} strokeWidth={2.4} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{impact.summary}</span>
        {impact.containers.length > 0 && (
          <span className="ellipsis" style={{ fontSize: 12, color: "var(--ink-3)" }}>
            Stops: {impact.containers.slice(0, 6).map((c) => c.name).join(", ")}
            {impact.containers.length > 6 ? ` and ${impact.containers.length - 6} more` : ""}
          </span>
        )}
        {impact.pending.length > 0 && (
          <span className="ellipsis" style={{ fontSize: 12, color: "var(--ink-3)" }}>Already waiting for a restart: {impact.pending.join(", ")}</span>
        )}
        {impact.details.length > 0 && (
          <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            {impact.details.slice(0, 3).map((d) => `${d.name} — ${d.detail}`).join(" · ")}
          </span>
        )}
      </span>
    </div>
  );
}

function Box({ on }: { on: boolean }) {
  return (
    <span style={{ width: 18, height: 18, borderRadius: 6, border: `1.5px solid ${on ? C.blue : "var(--line-3)"}`, background: on ? C.blue : "transparent", display: "grid", placeItems: "center", color: "#fff", transition: "all .15s", flex: "none" }}>
      {on && <Icon name="check" size={12} strokeWidth={3} />}
    </span>
  );
}

function PackageRow({ p, on, onToggle }: { p: MachinePackage; on: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      className="row-hover"
      style={{ display: "grid", gridTemplateColumns: "22px minmax(120px,1.2fr) minmax(0,2fr) auto", gap: 14, alignItems: "center", padding: "11px 16px", borderTop: "1px solid var(--line-1)", cursor: "pointer", opacity: on ? 1 : 0.72, transition: "opacity .2s" }}
    >
      <Box on={on} />
      <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
      <span className="mono ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
        {p.current} <span style={{ color: "var(--ink-2)" }}>→</span> <span style={{ color: "var(--ink)" }}>{p.candidate}</span>
      </span>
      <span style={{ height: 22, padding: "0 8px", borderRadius: 7, background: p.security ? "rgba(226,80,76,.12)" : "var(--fill-1)", color: p.security ? "var(--crit-ink)" : "var(--ink-3)", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
        {p.security ? "security" : "standard"}
      </span>
    </div>
  );
}

function SecurityTab({ m, reload }: { m: Machine; reload: () => void }) {
  const shell = useShell();
  const score = `${m.checks.filter((c) => c.status === "ok").length}/${m.checks.length} passing`;

  const fix = async (c: MachineCheck) => {
    const ok = await shell.confirm({
      title: `${c.title} on ${m.name}?`,
      text: c.fixNote ?? "Dockhand applies this change over SSH.",
      confirmLabel: "Apply",
      danger: c.fixRisky,
      icon: "shield",
      details: [{ k: "Machine", v: m.name }, { k: "Now", v: c.sub }],
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/fix/${c.id}`), { title: `${c.title} on ${m.name}`, done: `${c.title} applied`, invalidate: INVALIDATE, onDone: reload });
  };

  return (
    <div style={{ padding: "14px 20px 20px", display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(220px,1fr)", gap: 18, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="section-label">Hardening · {m.checks.length ? score : "not scanned"}</span>
        {m.checks.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 14, background: "var(--fill-1)" }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: halo(STATUS_COLOR[c.status] === "var(--fill-2)" ? "#9aa1ad" : STATUS_COLOR[c.status], 0.14), display: "grid", placeItems: "center", flex: "none" }}>
              <Icon name={c.status === "ok" ? "check" : c.status === "unknown" ? "dots" : "alert"} size={15} color={c.status === "unknown" ? "var(--ink-3)" : STATUS_COLOR[c.status]} strokeWidth={2.4} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{c.title}</span>
              <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{c.sub}</span>
            </span>
            {c.fix && (c.status === "bad" || c.status === "warn") && (
              <button className="btn" style={{ height: 30, padding: "0 12px", fontSize: 12 }} onClick={() => fix(c)} disabled={!m.sudo}>
                Fix
              </button>
            )}
          </div>
        ))}
        {!m.checks.length && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>Press Rescan to audit this machine.</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="section-label">Listening ports</span>
        <div style={{ display: "flex", flexDirection: "column", borderRadius: 14, border: "1px solid var(--line-1)", overflow: "hidden" }}>
          {m.ports.map((p) => (
            <div key={`${p.port}-${p.process}-${p.address}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid var(--line-1)", fontSize: 12.5 }}>
              <span className="mono" style={{ fontWeight: 600, width: 46 }}>{p.port}</span>
              <span className="ellipsis" style={{ flex: 1, color: "var(--ink-2)" }}>{p.process || "—"}</span>
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: p.public ? C.warn : "var(--ink-3)", whiteSpace: "nowrap" }}>{p.public ? "all interfaces" : "localhost"}</span>
            </div>
          ))}
          {!m.ports.length && <div style={{ padding: "12px", fontSize: 12.5, color: "var(--ink-3)" }}>No listening ports found (Dockhand may need root to read them).</div>}
        </div>
      </div>
    </div>
  );
}

function ServicesTab({ m, reload }: { m: Machine; reload: () => void }) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rank = (x: MachineService) => (x.active === "failed" ? 0 : x.active === "running" ? 1 : 2);
    return m.services.filter((x) => !s || x.name.toLowerCase().includes(s) || x.description.toLowerCase().includes(s)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [m.services, q]);

  const act = async (sv: MachineService, action: "start" | "stop" | "restart") => {
    if (action !== "start") {
      const ok = await shell.confirm({
        title: `${action === "stop" ? "Stop" : "Restart"} ${sv.name}?`,
        text: `systemctl ${action} ${sv.name} on ${m.name}. Anything depending on it is interrupted.`,
        confirmLabel: action === "stop" ? "Stop" : "Restart",
        danger: action === "stop",
        icon: action === "stop" ? "stop" : "restart",
      });
      if (!ok) return;
    }
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/service`, { unit: sv.name, action }), { title: `${action} ${sv.name}`, done: `${sv.name} ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`, invalidate: INVALIDATE, onDone: reload });
  };

  const color = (s: string) => (s === "running" ? C.ok : s === "failed" ? C.crit : s === "activating" ? C.warn : "var(--muted)");

  return (
    <div style={{ padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      {m.services.length > 8 && <input className="filter-input" placeholder="Filter services…" value={q} onChange={(e) => setQ(e.target.value)} style={{ alignSelf: "flex-start" }} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 10 }}>
        {list.map((sv) => (
          <div key={sv.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: color(sv.active), boxShadow: `0 0 0 4px ${halo(color(sv.active).startsWith("#") ? color(sv.active) : "#9aa1ad", 0.16)}`, flex: "none" }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
              <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{sv.name}</span>
              <span className="ellipsis" style={{ fontSize: 12, color: "var(--ink-2)" }}>{sv.description || (sv.enabled ? "enabled at boot" : "not enabled at boot")}</span>
            </span>
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: color(sv.active) }}>{sv.active}</span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{sv.enabled ? "enabled" : "manual"}</span>
            </span>
            <button className="btn2 sm" onClick={() => act(sv, sv.active === "running" ? "restart" : "start")} disabled={!m.sudo}>
              {sv.active === "running" ? "Restart" : "Start"}
            </button>
            {sv.active === "running" && (
              <button className="btn2 sm danger" onClick={() => act(sv, "stop")} disabled={!m.sudo} aria-label={`Stop ${sv.name}`}>
                <Icon name="stop" size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      {!m.services.length && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>No systemd services found on this machine.</span>}
    </div>
  );
}
