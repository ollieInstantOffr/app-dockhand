"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { del, errMsg, invalidate, post, put, useApi } from "@/lib/api";
import { C, ago, avatarBg, duration, halo, initial, plural } from "@/lib/format";
import type { Baseline, BaselineInput, BaselinesResponse, CheckStatus, Machine, MachineCheck, MachinePackage, MachineService } from "@/lib/types";
import type { JobRef } from "@/lib/types";
import { Dialog, DialogHeader, EmptyState, Seg, Tabs } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { HoverStyles } from "@/components/host/HoverStyles";
import { trackJob } from "@/components/host/jobs";

// Machines: the hosts themselves rather than their containers — OS updates,
// hardening, services and ports, plus baselines that hold a group of machines
// to the same rules.

type View = "hosts" | "baselines";
type Tab = "updates" | "security" | "services";

const INVALIDATE = ["/api/machines", "/api/baselines"];
const STATUS_COLOR: Record<CheckStatus, string> = { ok: C.ok, warn: C.warn, bad: C.crit, unknown: "var(--fill-2)" };
const CARD: React.CSSProperties = { borderRadius: 26, background: "var(--surface)", boxShadow: "var(--card-shadow)", overflow: "hidden", display: "flex", flexDirection: "column" };

export default function MachinesPage() {
  return (
    <Suspense fallback={null}>
      <Machines />
    </Suspense>
  );
}

function Machines() {
  const shell = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view: View = params.get("view") === "baselines" ? "baselines" : "hosts";
  const selected = params.get("host") ?? "";
  const selectedBase = params.get("baseline") ?? "";
  const tab: Tab = (["updates", "security", "services"] as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "updates";

  const setParams = (p: Record<string, string>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(p)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const { data: machines, error } = useApi<Machine[]>("/api/machines", { refresh: 60000 });
  const bases = useApi<BaselinesResponse>("/api/baselines", { refresh: 60000 });
  // Default to a machine worth looking at: the first reachable one, then the first.
  const cur = machines?.find((m) => m.hostId === selected) ?? machines?.find((m) => m.status !== "offline" && m.status !== "pending") ?? machines?.[0];
  const curBase = bases.data?.baselines.find((b) => b.id === selectedBase) ?? bases.data?.baselines[0];

  const fleet = async (action: "audit" | "security" | "all", title: string, text: string, label: string, danger?: boolean) => {
    const online = (machines ?? []).filter((m) => m.status !== "offline" && m.status !== "pending");
    if (!online.length) return shell.toast({ kind: "warn", title: "No machines are reachable" });
    const ok = await shell.confirm({
      title,
      text,
      confirmLabel: label,
      danger,
      icon: action === "audit" ? "shield" : "update",
      details: online.slice(0, 5).map((m) => ({ k: m.name, v: action === "audit" ? m.os || "—" : `${m.packages.length} update${m.packages.length === 1 ? "" : "s"}` })),
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/machines/fleet/${action}`), { title, done: `${title} finished`, invalidate: INVALIDATE });
  };

  const stats = useMemo(() => {
    const list = machines ?? [];
    const online = list.filter((m) => m.status !== "offline" && m.status !== "pending");
    const updates = list.reduce((n, m) => n + m.packages.length, 0);
    const sec = list.reduce((n, m) => n + m.security, 0);
    const reboots = list.filter((m) => m.reboot).length;
    const failing = list.reduce((n, m) => n + m.checks.filter((c) => c.status === "bad" || c.status === "warn").length, 0);
    return [
      { k: "Machines", v: String(list.length), sub: `${online.length} reachable`, color: "var(--ink)" },
      { k: "Updates", v: String(updates), sub: sec ? `${sec} security` : "no security updates", color: sec ? C.crit : updates ? C.warn : C.ok },
      { k: "Reboots", v: String(reboots), sub: reboots ? "pending after updates" : "none pending", color: reboots ? C.warn : C.ok },
      { k: "Hardening", v: String(failing), sub: failing ? "checks failing" : "all checks pass", color: failing ? C.crit : C.ok },
    ];
  }, [machines]);

  const summary = !machines
    ? "Reading your machines…"
    : `${plural(machines.length, "machine")} · ${stats[1].v} update${stats[1].v === "1" ? "" : "s"} waiting · ${stats[3].v} hardening check${stats[3].v === "1" ? "" : "s"} failing`;

  if (error && !machines) return <EmptyState icon="server" title="Couldn't load machines" text={error.message} />;

  return (
    <section data-screen-label="Machines" style={{ animation: "rise .4s ease both", display: "flex", flexDirection: "column", gap: 20, maxWidth: 1360 }}>
      <HoverStyles />
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 className="page-title">Machines</h1>
          <p className="page-sub">{summary}</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Seg<View>
            value={view}
            onChange={(v) => setParams({ view: v === "hosts" ? "" : v })}
            options={[
              { value: "hosts", label: "Hosts" },
              { value: "baselines", label: "Baselines" },
            ]}
            style={{ marginRight: 6 }}
          />
          <button className="btn2" onClick={() => fleet("audit", "Security audit", "Re-reads every machine: packages, services, listening ports and hardening checks. Nothing is changed.", "Run audit")}>
            <Icon name="shield" size={15} />
            Security audit
          </button>
          <button className="btn2" onClick={() => fleet("security", "Install security patches", "Installs only the security updates on every reachable machine. Services may restart; a reboot can still be needed afterwards.", "Install security patches", true)}>
            <Icon name="lock" size={15} />
            Security patches only
          </button>
          <button className="btn" onClick={() => fleet("all", "Patch all machines", "Installs every pending update on every reachable machine. Services may restart; a reboot can still be needed afterwards.", "Patch all", true)}>
            <Icon name="update" size={15} />
            Patch all hosts
          </button>
        </div>
      </div>

      {view === "hosts" ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
            {stats.map((st) => (
              <div key={st.k} style={{ borderRadius: 20, background: "var(--surface)", boxShadow: "var(--card-shadow)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-3)" }}>{st.k}</span>
                <span className="big-num" style={{ fontSize: 32, color: st.color, transition: "color .3s" }}>{machines ? st.v : "—"}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{st.sub}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 14 }}>
            {!machines && [0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 168, borderRadius: 22 }} />)}
            {machines?.map((m) => <MachineCard key={m.hostId} m={m} selected={m.hostId === cur?.hostId} onSelect={() => setParams({ host: m.hostId })} />)}
          </div>

          {machines && !machines.length && <EmptyState icon="server" title="No hosts yet" text="Add a host and Dockhand will manage its operating system here too." />}
          {cur && <MachineDetail key={cur.hostId} machine={cur} tab={tab} onTab={(t) => setParams({ tab: t === "updates" ? "" : t })} />}
        </>
      ) : (
        <BaselinesView
          data={bases.data}
          machines={machines ?? []}
          selected={curBase}
          onSelect={(id) => setParams({ baseline: id })}
          reload={() => {
            bases.mutate();
            invalidate("/api/machines");
          }}
        />
      )}
    </section>
  );
}

// ─── Host cards ────────────────────────────────────────────────────────────

function secDots(m: Machine) {
  return m.checks.slice(0, 8).map((c) => ({ id: c.id, c: STATUS_COLOR[c.status] }));
}

function MachineCard({ m, selected, onSelect }: { m: Machine; selected: boolean; onSelect: () => void }) {
  const offline = m.status === "offline" || m.status === "pending";
  const dot = offline ? "#9aa1ad" : m.status === "degraded" ? C.warn : C.ok;
  const ok = m.checks.filter((c) => c.status === "ok").length;
  const secColor = m.checks.some((c) => c.status === "bad") ? C.crit : m.checks.some((c) => c.status === "warn") ? C.warn : C.ok;
  const chips: { t: string; bg: string; c: string }[] = [];
  if (m.security > 0) chips.push({ t: `${m.security} security`, bg: "rgba(226,80,76,.12)", c: "var(--crit-ink)" });
  const other = m.packages.length - m.security;
  if (other > 0) chips.push({ t: `${other} update${other === 1 ? "" : "s"}`, bg: "rgba(224,160,32,.15)", c: "var(--warn-ink)" });
  if (m.reboot) chips.push({ t: "reboot required", bg: "rgba(224,160,32,.15)", c: "var(--warn-ink)" });
  const scanned = !!m.os;
  if (scanned && !m.packages.length && !m.reboot && m.pkgManager === "apt") chips.push({ t: "up to date", bg: "rgba(34,160,107,.12)", c: "var(--ok-ink)" });
  if (!scanned) chips.push({ t: m.status === "offline" ? "unreachable" : "not scanned", bg: "var(--fill-1)", c: "var(--ink-3)" });

  return (
    <button
      onClick={onSelect}
      className="dh-lift"
      style={{ textAlign: "left", border: 0, padding: 0, cursor: "pointer", borderRadius: 22, background: "var(--surface)", boxShadow: "var(--card-shadow)", overflow: "hidden", display: "flex", flexDirection: "column", opacity: offline ? 0.6 : 1, outline: `2px solid ${selected ? C.blue : "transparent"}`, outlineOffset: 2, font: "inherit", color: "var(--ink)", transition: "box-shadow .2s, outline-color .2s, transform .2s" }}
    >
      <span className="ink-head" style={{ padding: "12px 14px", gap: 10, width: "100%", boxSizing: "border-box" }}>
        <span style={{ width: 34, height: 34, borderRadius: 11, background: avatarBg(m.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700, flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)" }}>{initial(m.name)}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: 1 }}>
          <span className="ellipsis" style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "-0.01em" }}>{m.name}</span>
          <span className="mono ellipsis" style={{ fontSize: 11, opacity: 0.6 }}>{m.os ? `${m.os} ${m.release} · ${m.kernel}` : "not scanned yet"}</span>
        </span>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, boxShadow: `0 0 12px ${dot}`, flex: "none" }} />
      </span>
      <span style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: 10, width: "100%", boxSizing: "border-box" }}>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", minHeight: 24 }}>
          {chips.map((c) => (
            <span key={c.t} style={{ height: 24, padding: "0 9px", borderRadius: 8, background: c.bg, color: c.c, fontSize: 11.5, fontWeight: 700, display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>{c.t}</span>
          ))}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-3)", flexWrap: "wrap" }}>
          <span style={{ display: "flex", gap: 3 }}>
            {secDots(m).map((d, i) => <span key={`${d.id}${i}`} style={{ width: 7, height: 7, borderRadius: 2, background: d.c }} />)}
          </span>
          <span style={{ fontWeight: 600, color: secColor, whiteSpace: "nowrap" }}>{m.checks.length ? `${ok}/${m.checks.length} hardened` : "no audit yet"}</span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, whiteSpace: "nowrap" }}>{m.lastPatchAt ? `patched ${ago(m.lastPatchAt)}` : scanned && m.collectedAt ? `scanned ${ago(m.collectedAt)}` : ""}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, paddingTop: 8, borderTop: "1px solid var(--line-1)" }}>
          <span className="ellipsis" style={{ color: "var(--ink-3)", flex: 1, minWidth: 0 }}>{m.baselines.length ? m.baselines.join(", ") : "no baseline"}</span>
          <span style={{ fontWeight: 700, color: m.drift ? C.crit : C.ok, whiteSpace: "nowrap" }}>{m.baselines.length ? (m.drift ? `${m.drift} drift` : "compliant") : "—"}</span>
        </span>
      </span>
    </button>
  );
}

// ─── Machine detail ────────────────────────────────────────────────────────

function MachineDetail({ machine, tab, onTab }: { machine: Machine; tab: Tab; onTab: (t: Tab) => void }) {
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
    const ok = await shell.confirm({
      title: `Reboot ${m.name}?`,
      text: "Every container on this machine stops and starts again with it. Containers with a restart policy come back by themselves.",
      confirmLabel: "Reboot",
      danger: true,
      icon: "power",
      details: m.rebootPkgs.length ? [{ k: "Waiting on", v: m.rebootPkgs.slice(0, 3).join(", ") }] : undefined,
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/fix/reboot`), { title: `Rebooting ${m.name}`, done: `${m.name} is rebooting`, invalidate: INVALIDATE });
  };

  const tabs: { value: Tab; label: string; icon: IconName; count?: number }[] = [
    { value: "updates", label: "Updates", icon: "update", count: m.packages.length || undefined },
    { value: "security", label: "Security", icon: "shield", count: m.checks.filter((c) => c.status === "bad" || c.status === "warn").length || undefined },
    { value: "services", label: "Services", icon: "cpu", count: m.services.filter((s) => s.active === "running").length || undefined },
  ];

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
          <button className="ink-fill" onClick={() => router.push(`/hosts/${m.hostId}`)} style={INK_BTN}>
            <Icon name="box" size={15} />
            Containers
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

      {m.error && (
        <div style={{ margin: "14px 20px 0", padding: "10px 14px", borderRadius: 12, background: "var(--warn-bg)", border: "1px solid rgba(224,160,32,.3)", fontSize: 12.5, color: "var(--warn-ink)", lineHeight: 1.5 }}>{m.error}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px 0", flexWrap: "wrap" }}>
        <Tabs items={tabs} value={tab} onChange={onTab} />
      </div>

      {tab === "updates" && <UpdatesTab m={m} reload={reload} />}
      {tab === "security" && <SecurityTab m={m} reload={reload} />}
      {tab === "services" && <ServicesTab m={m} reload={reload} />}
    </div>
  );
}

const INK_BTN: React.CSSProperties = { height: 36, padding: "0 14px", borderRadius: 12, border: 0, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" };

function UpdatesTab({ m, reload }: { m: Machine; reload: () => void }) {
  const shell = useShell();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set(m.packages.filter((p) => p.security).map((p) => p.name))), [m.hostId, m.packages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const aptUpdate = () =>
    trackJob(shell, post<JobRef>(`/api/machines/${m.hostId}/apt-update`), { title: `apt update on ${m.name}`, done: "Package lists refreshed", invalidate: INVALIDATE, onDone: reload });

  const install = async () => {
    const names = [...picked];
    if (!names.length) return;
    const sec = m.packages.filter((p) => picked.has(p.name) && p.security).length;
    const ok = await shell.confirm({
      title: `Install ${plural(names.length, "update")} on ${m.name}?`,
      text: "apt installs them now, keeping your existing config files. Services that depend on them restart, and a reboot may be needed afterwards.",
      confirmLabel: `Install ${names.length}`,
      icon: "update",
      details: [{ k: "Security updates", v: String(sec) }, ...names.slice(0, 4).map((n) => ({ k: n, v: m.packages.find((p) => p.name === n)?.candidate ?? "" }))],
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

// ─── Baselines ─────────────────────────────────────────────────────────────

function BaselinesView({ data, machines, selected, onSelect, reload }: { data?: BaselinesResponse; machines: Machine[]; selected?: Baseline; onSelect: (id: string) => void; reload: () => void }) {
  const shell = useShell();
  const [editing, setEditing] = useState<Baseline | null>(null);
  const [creating, setCreating] = useState(false);
  const rules = data?.rules ?? [];

  const save = async (input: BaselineInput, id?: string) => {
    try {
      if (id) await put(`/api/baselines/${id}`, input);
      else await post("/api/baselines", input);
      shell.toast({ kind: "ok", title: id ? "Baseline saved" : `Baseline “${input.name}” created` });
      reload();
      setEditing(null);
      setCreating(false);
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't save the baseline", text: errMsg(e) });
    }
  };

  const patch = async (b: Baseline, p: Partial<BaselineInput>) => {
    const body: BaselineInput = { name: b.name, description: b.description, color: b.color, rules: b.rules, hostIds: b.hostIds, ...p };
    try {
      await put(`/api/baselines/${b.id}`, body);
      reload();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't update the baseline", text: errMsg(e) });
    }
  };

  const remove = async (b: Baseline) => {
    const ok = await shell.confirm({ title: `Delete “${b.name}”?`, text: "The machines keep their current settings; only the baseline and its compliance view go away.", confirmLabel: "Delete", danger: true, icon: "trash" });
    if (!ok) return;
    try {
      await del(`/api/baselines/${b.id}`);
      shell.toast({ kind: "ok", title: `Deleted ${b.name}` });
      reload();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't delete", text: errMsg(e) });
    }
  };

  const apply = async (b: Baseline) => {
    const failing = b.compliance.reduce((n, r) => n + r.drift, 0);
    const ok = await shell.confirm({
      title: `Apply “${b.name}” to ${plural(b.compliance.length, "machine")}?`,
      text: "Dockhand fixes every failing rule over SSH: SSH settings, the firewall, automatic updates and pending security patches. Services may restart.",
      confirmLabel: `Fix ${failing} ${failing === 1 ? "rule" : "rules"}`,
      danger: true,
      icon: "shield",
      details: b.compliance.filter((r) => r.drift).slice(0, 5).map((r) => ({ k: r.name, v: `${r.drift} failing` })),
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/baselines/${b.id}/apply`), { title: `Applying ${b.name}`, done: `${b.name} applied`, invalidate: INVALIDATE, onDone: reload });
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: 14 }}>
        {!data && [0, 1].map((i) => <span key={i} className="skel" style={{ height: 150, borderRadius: 22 }} />)}
        {data?.baselines.map((b) => {
          const on = b.id === selected?.id;
          const col = b.pct >= 100 ? C.ok : b.pct >= 60 ? C.warn : C.crit;
          return (
            <button key={b.id} onClick={() => onSelect(b.id)} className="dh-lift" style={{ textAlign: "left", border: 0, padding: 0, cursor: "pointer", borderRadius: 22, background: "var(--surface)", boxShadow: "var(--card-shadow)", overflow: "hidden", display: "flex", flexDirection: "column", outline: `2px solid ${on ? C.blue : "transparent"}`, outlineOffset: 2, font: "inherit", color: "var(--ink)", transition: "box-shadow .2s, outline-color .2s, transform .2s" }}>
              <span className="ink-head" style={{ padding: "12px 14px", gap: 10, width: "100%", boxSizing: "border-box" }}>
                <span style={{ width: 34, height: 34, borderRadius: 11, background: b.color, display: "grid", placeItems: "center", flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)", color: "#fff" }}>
                  <Icon name="shield" size={17} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: 1 }}>
                  <span className="ellipsis" style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "-0.01em" }}>{b.name}</span>
                  <span className="mono ellipsis" style={{ fontSize: 11, opacity: 0.6 }}>{plural(b.rules.length, "rule")} · {plural(b.hostIds.length, "host")}</span>
                </span>
                <span className="mono" style={{ fontSize: 15, fontWeight: 600, color: col, whiteSpace: "nowrap" }}>{b.hostIds.length ? `${b.pct}%` : "—"}</span>
              </span>
              <span style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: 8, width: "100%", boxSizing: "border-box" }}>
                <span style={{ height: 6, borderRadius: 3, background: "var(--fill-2)", overflow: "hidden", display: "block" }}>
                  <span style={{ display: "block", height: "100%", width: `${b.hostIds.length ? b.pct : 0}%`, background: col, borderRadius: 3, transition: "width .6s cubic-bezier(.2,.8,.2,1)" }} />
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  <span className="ellipsis" style={{ color: "var(--ink-2)", flex: 1, minWidth: 0 }}>{b.description || "No description"}</span>
                  <span style={{ fontWeight: 700, color: b.drift ? C.crit : C.ok, whiteSpace: "nowrap" }}>{b.drift ? `${b.drift} drift` : "compliant"}</span>
                </span>
              </span>
            </button>
          );
        })}
        <button onClick={() => setCreating(true)} style={{ border: "1.5px dashed var(--line-3)", borderRadius: 22, background: "transparent", minHeight: 120, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", color: "var(--ink-2)", font: "inherit", fontSize: 13, fontWeight: 600, transition: "all .2s" }}>
          <span style={{ width: 36, height: 36, borderRadius: 12, background: "var(--fill-1)", display: "grid", placeItems: "center" }}>
            <Icon name="plus" size={18} />
          </span>
          New baseline
        </button>
      </div>

      {selected && (
        <BaselineDetail
          b={selected}
          machines={machines}
          rules={rules}
          onEdit={() => setEditing(selected)}
          onDelete={() => remove(selected)}
          onApply={() => apply(selected)}
          onToggleRule={(id) => patch(selected, { rules: selected.rules.includes(id) ? selected.rules.filter((r) => r !== id) : [...selected.rules, id] })}
          onToggleHost={(id) => patch(selected, { hostIds: selected.hostIds.includes(id) ? selected.hostIds.filter((h) => h !== id) : [...selected.hostIds, id] })}
        />
      )}

      {(creating || editing) && (
        <BaselineDialog
          b={editing}
          rules={rules}
          machines={machines}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={save}
        />
      )}
    </>
  );
}

function BaselineDetail({ b, machines, rules, onEdit, onDelete, onApply, onToggleRule, onToggleHost }: { b: Baseline; machines: Machine[]; rules: { id: string; title: string; group: string }[]; onEdit: () => void; onDelete: () => void; onApply: () => void; onToggleRule: (id: string) => void; onToggleHost: (id: string) => void }) {
  const col = b.pct >= 100 ? C.ok : b.pct >= 60 ? C.warn : C.crit;
  const groups = useMemo(() => {
    const out = new Map<string, { id: string; title: string; group: string }[]>();
    for (const r of rules) out.set(r.group, [...(out.get(r.group) ?? []), r]);
    return [...out.entries()];
  }, [rules]);
  const failsFor = (ruleId: string) => b.compliance.filter((r) => r.cells[ruleId] === "bad" || r.cells[ruleId] === "warn").length;

  return (
    <div style={CARD}>
      <div className="ink-head" style={{ gap: 14, padding: "16px 18px 16px 20px", flexWrap: "wrap" }}>
        <span style={{ width: 44, height: 44, borderRadius: 14, background: b.color, color: "#fff", display: "grid", placeItems: "center", flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)" }}>
          <Icon name="shield" size={21} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 3, flex: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{b.name}</h2>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: col, whiteSpace: "nowrap" }}>{b.hostIds.length ? `${b.pct}% compliant` : "no machines yet"}</span>
          </span>
          <span className="ellipsis" style={{ fontSize: 12.5, opacity: 0.65 }}>
            {b.description || "No description"} · {plural(b.rules.length, "rule")} · {b.drift ? `${b.drift} failing` : "everything passing"}
          </span>
        </span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="ink-fill" onClick={onDelete} style={INK_BTN}>Delete</button>
          <button className="ink-fill" onClick={onEdit} style={INK_BTN}>
            <Icon name="sliders" size={15} />
            Edit
          </button>
          <button onClick={onApply} disabled={!b.drift} style={{ ...INK_BTN, background: "var(--btn-ink)", color: "var(--btn)", opacity: b.drift ? 1 : 0.5 }}>
            <Icon name="shield" size={15} />
            {b.drift ? `Fix ${b.drift}` : "Compliant"}
          </button>
        </span>
      </div>

      <div style={{ padding: "18px 20px 20px", display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(260px,1fr)", gap: 22, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="section-label">Compliance · machine × rule</span>
          {!b.compliance.length ? (
            <div style={{ padding: 18, borderRadius: 16, background: "var(--fill-1)", fontSize: 13, color: "var(--ink-2)" }}>No machines assigned yet — pick them below.</div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", borderRadius: 16, border: "1px solid var(--line-1)", overflow: "hidden" }}>
                {b.compliance.map((r) => (
                  <div key={r.hostId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderTop: "1px solid var(--line-1)", opacity: r.status === "offline" ? 0.6 : 1 }}>
                    <span style={{ width: 26, height: 26, borderRadius: 8, background: avatarBg(r.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flex: "none" }}>{initial(r.name)}</span>
                    <span className="ellipsis" style={{ fontSize: 13, fontWeight: 600, width: 110 }}>{r.name}</span>
                    <span style={{ display: "flex", gap: 4, flex: 1, flexWrap: "wrap" }}>
                      {b.rules.map((id) => (
                        <span key={id} title={`${rules.find((x) => x.id === id)?.title ?? id}: ${r.cells[id] ?? "unknown"}`} style={{ width: 14, height: 14, borderRadius: 4, background: STATUS_COLOR[r.cells[id] ?? "unknown"], transition: "background .3s" }} />
                      ))}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: r.drift ? C.crit : C.ok, whiteSpace: "nowrap" }}>{r.drift ? `${r.drift} drift` : "compliant"}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11.5, color: "var(--ink-3)" }}>
                {b.rules.map((id) => (
                  <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--fill-2)" }} />
                    {rules.find((x) => x.id === id)?.title ?? id}
                  </span>
                ))}
              </div>
            </>
          )}
          <span className="section-label" style={{ marginTop: 6 }}>Machines in this baseline</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {machines.map((m) => {
              const on = b.hostIds.includes(m.hostId);
              return (
                <button
                  key={m.hostId}
                  onClick={() => onToggleHost(m.hostId)}
                  style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 12px 0 6px", borderRadius: 11, border: `1.5px solid ${on ? C.blue : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "var(--ink)", transition: "all .15s", whiteSpace: "nowrap" }}
                >
                  <span style={{ width: 22, height: 22, borderRadius: 7, background: avatarBg(m.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700 }}>{initial(m.name)}</span>
                  {m.name}
                </button>
              );
            })}
            {!machines.length && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No hosts yet.</span>}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <span className="section-label">Rules in this baseline</span>
          {groups.map(([group, list]) => (
            <div key={group} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", textTransform: "capitalize" }}>{group}</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {list.map((r) => {
                  const on = b.rules.includes(r.id);
                  const fails = on ? failsFor(r.id) : 0;
                  return (
                    <button
                      key={r.id}
                      onClick={() => onToggleRule(r.id)}
                      style={{ height: 30, padding: "0 11px", borderRadius: 9, border: `1.5px solid ${on ? C.blue : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", color: on ? "var(--ink)" : "var(--ink-3)", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, transition: "all .15s", whiteSpace: "nowrap" }}
                    >
                      {r.title}
                      {fails > 0 && <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 5, background: "rgba(226,80,76,.18)", color: "var(--crit-ink)" }}>{fails}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const COLORS = ["#2f6fed", "#7a5cf0", "#22a06b", "#e0a020", "#e2504c", "#14b8c4"];

function BaselineDialog({ b, rules, machines, onClose, onSave }: { b: Baseline | null; rules: { id: string; title: string; group: string }[]; machines: Machine[]; onClose: () => void; onSave: (input: BaselineInput, id?: string) => void }) {
  const [name, setName] = useState(b?.name ?? "");
  const [description, setDescription] = useState(b?.description ?? "");
  const [color, setColor] = useState(b?.color ?? COLORS[0]);
  const [picked, setPicked] = useState<string[]>(b?.rules ?? rules.map((r) => r.id));
  const [hostIds, setHostIds] = useState<string[]>(b?.hostIds ?? []);
  const [err, setErr] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setErr("Give the baseline a name.");
    onSave({ name: name.trim(), description: description.trim(), color, rules: picked, hostIds }, b?.id);
  };

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <Dialog onClose={onClose} width={560}>
      <DialogHeader icon="shield" title={b ? `Edit ${b.name}` : "New baseline"} sub="A set of rules every machine in it should meet" onClose={onClose} />
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="field">
          Name
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Internet-facing" />
        </div>
        <div className="field">
          Description
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What these machines have in common" />
        </div>
        <div className="field">
          Colour
          <div style={{ display: "flex", gap: 8 }}>
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={c} style={{ width: 28, height: 28, borderRadius: 9, background: c, border: color === c ? "2px solid var(--ink)" : "2px solid transparent", cursor: "pointer" }} />
            ))}
          </div>
        </div>
        <div className="field">
          Rules
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {rules.map((r) => {
              const on = picked.includes(r.id);
              return (
                <button key={r.id} type="button" onClick={() => toggle(picked, setPicked, r.id)} style={{ height: 30, padding: "0 11px", borderRadius: 9, border: `1.5px solid ${on ? C.blue : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", color: on ? "var(--ink)" : "var(--ink-3)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {r.title}
                </button>
              );
            })}
          </div>
        </div>
        <div className="field">
          Machines
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {machines.map((m) => {
              const on = hostIds.includes(m.hostId);
              return (
                <button key={m.hostId} type="button" onClick={() => toggle(hostIds, setHostIds, m.hostId)} style={{ display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 12px 0 6px", borderRadius: 11, border: `1.5px solid ${on ? C.blue : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
                  <span style={{ width: 22, height: 22, borderRadius: 7, background: avatarBg(m.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700 }}>{initial(m.name)}</span>
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
        {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn">{b ? "Save" : "Create baseline"}</button>
        </div>
      </form>
    </Dialog>
  );
}
