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
import { CHECK_COLOR, INK_BTN, MACHINE_INVALIDATE, MachineDetail, type MachineTab } from "@/components/machines/MachinePanel";

// Machines: the hosts themselves rather than their containers — OS updates,
// hardening, services and ports, plus baselines that hold a group of machines
// to the same rules.

type View = "hosts" | "baselines";

const INVALIDATE = MACHINE_INVALIDATE;
const STATUS_COLOR = CHECK_COLOR;
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
  const tab: MachineTab = (["updates", "security", "services"] as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as MachineTab) : "updates";

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
      { k: "Hosts", v: String(list.length), sub: `${online.length} reachable`, color: "var(--ink)" },
      { k: "Updates", v: String(updates), sub: sec ? `${sec} security` : "no security updates", color: sec ? C.crit : updates ? C.warn : C.ok },
      { k: "Reboots", v: String(reboots), sub: reboots ? "pending after updates" : "none pending", color: reboots ? C.warn : C.ok },
      { k: "Hardening", v: String(failing), sub: failing ? "checks failing" : "all checks pass", color: failing ? C.crit : C.ok },
    ];
  }, [machines]);

  const summary = !machines
    ? "Reading your machines…"
    : `Your ${plural(machines.length, "host")} from the OS side · ${stats[1].v} update${stats[1].v === "1" ? "" : "s"} waiting · ${stats[3].v} hardening check${stats[3].v === "1" ? "" : "s"} failing`;

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
            {machines?.map((m) => (
            <MachineCard
              key={m.hostId}
              m={m}
              selected={m.hostId === cur?.hostId}
              onSelect={() => {
                setParams({ host: m.hostId });
                // The detail panel sits below the cards — bring it to the reader.
                requestAnimationFrame(() => document.getElementById("machine-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
              }}
            />
          ))}
          </div>

          {machines && !machines.length && <EmptyState icon="server" title="No hosts yet" text="Add a host and Dockhand will manage its operating system here too." />}
          {cur && (
            <div id="machine-detail" style={{ scrollMarginTop: 90 }}>
              <MachineDetail key={cur.hostId} machine={cur} tab={tab} onTab={(t: MachineTab) => setParams({ tab: t === "updates" ? "" : t })} />
            </div>
          )}
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
