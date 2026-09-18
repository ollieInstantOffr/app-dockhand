"use client";

import { useEffect, useState } from "react";
import { patch, useApi } from "@/lib/api";
import { C, ago, bytes, bytesShort, containerColor, containerStateLabel, dateTime, duration, halo, since } from "@/lib/format";
import type { ContainerDetail, ContainerEvent, Host, JobRef, KV } from "@/lib/types";
import { Skel, Spark } from "../ui";
import { Icon, type IconName } from "../icons";
import { useShell } from "../shell/context";
import { HoverStyles } from "../host/HoverStyles";
import { trackJob } from "../host/jobs";
import { useContainerActions } from "../host/ContainersTab";
import { LogRows, useLogStream, useStickToBottom } from "../host/logStream";

type SideTab = "overview" | "env" | "mounts" | "logs" | "events";
const TABS: { value: SideTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "env", label: "Environment" },
  { value: "mounts", label: "Mounts & network" },
  { value: "logs", label: "Logs" },
  { value: "events", label: "Events" },
];

const BTN2: React.CSSProperties = { height: 34, padding: "0 14px", borderRadius: 12, border: 0, background: "rgba(127,127,127,.25)", color: "var(--btn-ink)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 };
const SUB: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" };
const TILE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 12, background: "var(--fill-1)", border: "1px solid transparent" };
const POLICIES: ContainerDetail["restartPolicy"][] = ["no", "always", "unless-stopped", "on-failure"];


export function ContainerSidecar({ hostId, containerId, initialTab, onClose }: { hostId: string; containerId: string; initialTab?: string; onClose: () => void }) {
  const shell = useShell();
  const actions = useContainerActions(hostId);
  const [tab, setTab] = useState<SideTab>(TABS.some((t) => t.value === initialTab) ? (initialTab as SideTab) : "overview");
  const [editing, setEditing] = useState(initialTab === "env");
  const [busy, setBusy] = useState(false);
  const { data: c, error } = useApi<ContainerDetail>(`/api/hosts/${hostId}/containers/${containerId}`, { refresh: 5000 });
  const { data: host } = useApi<Host>(`/api/hosts/${hostId}`);

  useEffect(() => {
    setTab(TABS.some((t) => t.value === initialTab) ? (initialTab as SideTab) : "overview");
    setEditing(initialTab === "env");
  }, [containerId, initialTab]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".dialog-scrim")) return; // a confirm/dialog on top handles Esc
      if ((e.target as HTMLElement | null)?.closest?.("[data-terminal-window]")) return; // Esc in the terminal window is its own
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const color = c ? containerColor(c.state, c.health) : "#9aa1ad";
  const solid = color.startsWith("#") ? color : "#9aa1ad";
  const running = c?.state === "running";
  // Logs and shells open in the floating terminal window (it sits above the sidecar).
  const go = (t: "logs" | "exec") => shell.openTerminal({ kind: t, hostId, containerId, name: c?.name });

  const primary: { label: string; icon: IconName; run: () => Promise<void> } | null = !c
    ? null
    : running || c.state === "restarting"
      ? { label: "Stop", icon: "stop", run: () => actions.run(c, "stop") }
      : c.state === "paused"
        ? { label: "Resume", icon: "play", run: () => actions.run(c, "unpause") }
        : { label: "Start", icon: "play", run: () => actions.run(c, "start") };

  const upText = !c ? "" : running && c.startedAt ? `up ${duration(since(c.startedAt))}` : c.finishedAt && c.state !== "created" ? `${c.state} ${ago(c.finishedAt)}` : c.state;

  return (
    <>
      <HoverStyles />
      <div className="scrim" onClick={onClose} />
      <aside data-screen-label="Container detail" className="drawer" style={{ width: "min(520px, calc(100vw - 120px))", background: "var(--surface)", border: 0, backdropFilter: "none", WebkitBackdropFilter: "none", boxShadow: "-20px 0 80px rgba(0,0,0,.25)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "20px 22px 0", display: "flex", flexDirection: "column", gap: 14, background: "var(--btn)", color: "var(--btn-ink)", flex: "none" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <span style={{ width: 42, height: 42, borderRadius: 13, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
              <Icon name="box" size={21} />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {c ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <h2 className="mono" style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", wordBreak: "break-all" }}>{c.name}</h2>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 9px", borderRadius: 20, background: halo(solid, 0.2), color: solid, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", boxShadow: "0 0 8px currentColor" }} />
                      {containerStateLabel(c.state, c.health)}
                    </span>
                    {c.update?.available && (
                      <button className="upd-tag" onClick={() => actions.update(c)} style={{ display: "flex", alignItems: "center", gap: 4, height: 22, padding: "0 8px 0 6px", borderRadius: 7, border: 0, background: "rgba(47,111,237,.12)", color: "#2f6fed", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        <Icon name="update" size={12} strokeWidth={2} />
                        Update to {c.update.tag}
                      </button>
                    )}
                  </div>
                  <span className="mono ellipsis" style={{ fontSize: 11.5, opacity: 0.6 }}>{c.image}</span>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>
                    {host?.name ?? "…"} · {upText} · <span className="mono">{c.shortId}</span>
                  </span>
                </>
              ) : error ? (
                <>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Container not found</h2>
                  <span style={{ fontSize: 12.5, opacity: 0.6 }}>{error.message}</span>
                </>
              ) : (
                <>
                  <Skel w="55%" h={20} style={{ opacity: 0.4 }} />
                  <Skel w="75%" h={11} style={{ opacity: 0.4 }} />
                  <Skel w="45%" h={11} style={{ opacity: 0.4 }} />
                </>
              )}
            </div>
            <button className="ink-btn" onClick={onClose} aria-label="Close" style={{ width: 32, height: 32, borderRadius: 10, border: 0, background: "rgba(127,127,127,.25)", color: "var(--btn-ink)", opacity: 0.7, cursor: "pointer", flex: "none", display: "grid", placeItems: "center" }}>
              <Icon name="x" size={14} />
            </button>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              disabled={!primary || busy}
              style={{ height: 34, padding: "0 12px", borderRadius: 12, border: 0, background: "var(--btn-ink)", color: "var(--btn)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 8 }}
              onClick={async () => {
                if (!primary) return;
                setBusy(true);
                await primary.run();
                setBusy(false);
              }}
            >
              {busy ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <Icon name={primary?.icon ?? "play"} size={14} />}
              {primary?.label ?? "Start"}
            </button>
            {running && c && (
              <button className="ink-fill" style={BTN2} disabled={busy} onClick={async () => { setBusy(true); await actions.run(c, "restart"); setBusy(false); }}>
                <Icon name="restart" size={14} />
                Restart
              </button>
            )}
            <button className="ink-fill" style={BTN2} onClick={() => go("logs")}>
              <Icon name="logs" size={14} />
              Logs
            </button>
            <button className="ink-fill" style={BTN2} disabled={!running} title={running ? undefined : "Container is not running"} onClick={() => go("exec")}>
              <Icon name="terminal" size={14} />
              Shell
            </button>
            <button className="ink-fill" style={BTN2} disabled={!c} onClick={() => { setTab("env"); setEditing(true); }}>
              <Icon name="sliders" size={14} />
              Edit config
            </button>
            <button
              className="ink-fill"
              style={{ ...BTN2, color: "var(--crit)", marginLeft: "auto" }}
              disabled={!c}
              onClick={async () => {
                if (c && (await actions.remove(c))) onClose();
              }}
            >
              Remove
            </button>
          </div>

          <div style={{ display: "flex", gap: 18, overflowX: "auto", overflowY: "hidden" }}>
            {TABS.map((t) => {
              const on = t.value === tab;
              return (
                <button key={t.value} onClick={() => setTab(t.value)} style={{ border: 0, background: "transparent", padding: "0 0 10px", fontSize: 13, color: "var(--btn-ink)", opacity: on ? 1 : 0.55, fontWeight: 600, borderBottom: `2px solid ${on ? "var(--btn-ink)" : "transparent"}`, cursor: "pointer", whiteSpace: "nowrap", flex: "none", transition: "opacity .15s" }}>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "18px 22px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
          {!c && !error && <BodySkeleton />}
          {c && tab === "overview" && <Overview c={c} color={color} />}
          {c && tab === "env" && <EnvTab c={c} hostId={hostId} editing={editing} setEditing={setEditing} />}
          {c && tab === "mounts" && <MountsTab c={c} address={host?.address ?? ""} />}
          {tab === "logs" && <LogsPane hostId={hostId} containerId={containerId} onFull={() => go("logs")} />}
          {c && tab === "events" && <Events events={c.events} />}
        </div>
      </aside>
    </>
  );
}

function BodySkeleton() {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skel key={i} h={70} r={14} />
        ))}
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <Skel key={i} h={14} w={`${60 + ((i * 13) % 35)}%`} />
      ))}
    </>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────

function Overview({ c, color }: { c: ContainerDetail; color: string }) {
  const h = c.history ?? { cpu: [], mem: [], netRx: [], netTx: [] };
  const last = (a: number[]) => (a.length ? a[a.length - 1] : 0);
  const live = c.state === "running";
  const memMax = c.memLimit > 0 ? c.memLimit : Math.max(1, ...h.mem);
  const netMax = Math.max(1, ...h.netRx, ...h.netTx);
  const stats = [
    { k: "CPU", v: live ? `${c.cpu.toFixed(1)}%` : "—", values: h.cpu, max: Math.max(100, ...h.cpu), color: C.blue, fmt: (v: number) => `${v.toFixed(1)}%` },
    { k: "Memory", v: live ? `${bytesShort(c.memUsed)}${c.memLimit > 0 ? ` / ${bytesShort(c.memLimit)}` : ""}` : "—", values: h.mem, max: memMax, color: C.violet, fmt: (v: number) => bytes(v) },
    { k: "Net in", v: live ? `${bytesShort(last(h.netRx))}/s` : "—", values: h.netRx, max: netMax, color: C.ok, fmt: (v: number) => `${bytes(v)}/s` },
    { k: "Net out", v: live ? `${bytesShort(last(h.netTx))}/s` : "—", values: h.netTx, max: netMax, color: C.warn, fmt: (v: number) => `${bytes(v)}/s` },
  ];
  const imageId = c.imageId.replace(/^sha256:/, "").slice(0, 12);
  const facts: KV[] = [
    { k: "Image ID", v: imageId || "—" },
    { k: "Created", v: `${dateTime(c.createdAt)} · ${ago(c.createdAt)}` },
    { k: "Restart policy", v: c.restartPolicy || "no" },
    { k: "Command", v: c.command || "—" },
    ...(c.entrypoint ? [{ k: "Entrypoint", v: c.entrypoint }] : []),
    { k: "Workdir", v: c.workdir || "/" },
    { k: "Hostname", v: c.hostname || "—" },
    { k: "Restart count", v: String(c.restartCount) },
    ...(c.state !== "running" && c.state !== "created" ? [{ k: "Exit code", v: String(c.exitCode) }] : []),
  ];
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {stats.map((x) => (
          <div key={x.k} style={{ padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent", display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, fontWeight: 700, color: "var(--ink-3)", letterSpacing: ".05em", textTransform: "uppercase" }}>
              <span>{x.k}</span>
              <span className="mono ellipsis" style={{ fontWeight: 500, color: "var(--ink)", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>{x.v}</span>
            </span>
            <span style={{ display: "flex" }}>
              <Spark values={x.values} count={24} max={x.max} height={28} gap={2} radius={1.5} color={x.color} formatValue={x.fmt} />
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {facts.map((x) => (
          <div key={x.k} className="fact-row" title={x.v} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 12px", borderRadius: 10, fontSize: 12.5 }}>
            <span style={{ color: "var(--ink-3)", flex: "none" }}>{x.k}</span>
            <span className="mono ellipsis" style={{ fontSize: 12, textAlign: "right", minWidth: 0 }}>{x.v}</span>
          </div>
        ))}
      </div>
      {c.healthCmd && (
        <div style={{ padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
            Health check
            {c.health !== "none" && <span style={{ fontWeight: 600, color: "var(--ink-3)" }}>· {c.health}</span>}
            <span className="mono" style={{ marginLeft: "auto", fontWeight: 500, fontSize: 11.5, color: "var(--ink-3)" }}>every {c.healthInterval || "30s"}</span>
          </div>
          <code className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)", wordBreak: "break-all" }}>{c.healthCmd}</code>
        </div>
      )}
    </>
  );
}

// ─── Environment ───────────────────────────────────────────────────────────

function EnvTab({ c, hostId, editing, setEditing }: { c: ContainerDetail; hostId: string; editing: boolean; setEditing: (v: boolean) => void }) {
  const shell = useShell();
  const [show, setShow] = useState(false);
  const [rows, setRows] = useState<KV[]>([]);
  const [policy, setPolicy] = useState<ContainerDetail["restartPolicy"]>(c.restartPolicy);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setRows(c.env.map((e) => ({ k: e.k, v: e.v })));
      setPolicy(c.restartPolicy);
    }
    // Only snapshot when entering edit mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = async () => {
    const env = rows.filter((r) => r.k.trim()).map((r) => ({ k: r.k.trim(), v: r.v }));
    const keys = env.map((r) => r.k);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) {
      shell.toast({ kind: "error", title: "Duplicate variable", text: `${dup} is set more than once.` });
      return;
    }
    const ok = await shell.confirm({
      title: `Recreate ${c.name}?`,
      text: "Docker can't change environment variables on a running container, so Dockhand recreates it with the new configuration. It restarts briefly.",
      confirmLabel: "Save & recreate",
      icon: "sliders",
    });
    if (!ok) return;
    setSaving(true);
    const body: { env: KV[]; restartPolicy?: string } = { env };
    if (policy !== c.restartPolicy) body.restartPolicy = policy;
    const job = await trackJob(shell, patch<JobRef>(`/api/hosts/${hostId}/containers/${c.id}`, body), { title: `Recreating ${c.name}`, done: `${c.name} updated`, invalidate: [`/api/hosts/${hostId}`, "/api/containers"] });
    setSaving(false);
    if (job?.status === "success") setEditing(false);
  };

  if (editing) {
    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Editing {rows.length} variables</span>
          <button className="btn2 sm" style={{ marginLeft: "auto" }} disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button className="btn xs" disabled={saving} onClick={save}>
            {saving && <span className="spinner" style={{ width: 12, height: 12 }} />}
            Save
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,.9fr) minmax(0,1.1fr) 30px", gap: 6 }}>
              <input className="input sm mono" value={r.k} placeholder="KEY" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} style={{ fontSize: 12 }} />
              <input className="input sm mono" value={r.v} placeholder="value" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} style={{ fontSize: 12 }} />
              <button className="icon-btn" style={{ height: 36, width: 30 }} aria-label="Remove variable" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          <button className="btn-link" style={{ alignSelf: "flex-start", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }} onClick={() => setRows([...rows, { k: "", v: "" }])}>
            <Icon name="plus" size={13} />
            Add variable
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={SUB}>Restart policy</span>
          <div className="seg fit">
            {POLICIES.map((p) => (
              <button key={p} className={p === policy ? "on" : ""} onClick={() => setPolicy(p)} style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                {p}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
          {c.env.length} variable{c.env.length === 1 ? "" : "s"}
          {c.env.some((e) => e.secret) ? ` · ${c.env.filter((e) => e.secret).length} secret` : ""}
        </span>
        <button className="btn2 sm" style={{ marginLeft: "auto" }} onClick={() => setShow(!show)}>
          <Icon name={show ? "eyeOff" : "eye"} size={13} />
          {show ? "Hide secrets" : "Show secrets"}
        </button>
        <button className="btn2 sm" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {c.env.length === 0 && <span style={{ fontSize: 12.5, color: "var(--ink-3)", padding: "8px 12px" }}>No environment variables.</span>}
        {c.env.map((e, i) => {
          const masked = e.secret && !show;
          return (
            <div key={`${e.k}-${i}`} className="fact-row mono" title={masked ? undefined : e.v} style={{ display: "grid", gridTemplateColumns: "minmax(0,.9fr) minmax(0,1.1fr)", gap: 10, padding: "8px 12px", borderRadius: 10, fontSize: 12 }}>
              <span className="ellipsis" style={{ fontWeight: 600 }}>{e.k}</span>
              <span className="ellipsis" style={{ color: masked ? "var(--ink-3)" : e.secret ? "var(--warn-ink)" : "var(--ink-2)" }}>{masked ? "••••••••" : e.v || '""'}</span>
            </div>
          );
        })}
      </div>
      {c.labels.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={SUB}>Labels</span>
          {c.labels.map((l) => (
            <div key={l.k} className="mono" title={`${l.k}=${l.v}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, padding: "6px 12px", fontSize: 11.5, color: "var(--ink-2)" }}>
              <span className="ellipsis">{l.k}</span>
              <span className="ellipsis" style={{ color: "var(--ink)" }}>{l.v}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Mounts & network ──────────────────────────────────────────────────────

function MountsTab({ c, address }: { c: ContainerDetail; address: string }) {
  const pub = c.ports.filter((p) => p.host > 0);
  const seen = new Set<string>();
  const portRows = pub.filter((p) => {
    const k = `${p.host}/${p.container}/${p.proto}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const hostAddr = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={SUB}>Mounts</span>
        {c.mounts.length === 0 && <Muted>No mounts — this container keeps no data outside its image.</Muted>}
        {c.mounts.map((m, i) => (
          <div key={i} style={{ ...TILE, alignItems: "flex-start" }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: "rgba(122,92,240,.12)", color: "#7a5cf0", display: "grid", placeItems: "center", flex: "none" }}>
              <Icon name="disk" size={15} />
            </span>
            <span className="mono" style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0, fontSize: 11.5 }}>
              <span className="ellipsis" style={{ fontWeight: 600, color: "var(--ink)" }} title={m.src}>{m.src || "(anonymous)"}</span>
              <span className="ellipsis" style={{ color: "var(--ink-3)" }} title={m.dst}>→ {m.dst}</span>
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 7px", borderRadius: 7, background: "var(--fill-1)", color: "var(--ink-3)", whiteSpace: "nowrap" }}>
              {m.type !== "bind" ? `${m.type} · ` : ""}
              {m.mode}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={SUB}>Networks</span>
        {c.networks.length === 0 && <Muted>Not attached to any network.</Muted>}
        {c.networks.map((n) => (
          <div key={n.name} style={TILE}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: "rgba(47,111,237,.12)", color: "#2f6fed", display: "grid", placeItems: "center", flex: "none" }}>
              <Icon name="network" size={15} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
              <span className="mono ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>{n.name}</span>
              <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {n.ip || "no ip"}
                {n.gw ? ` · gw ${n.gw}` : ""}
              </span>
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 7px", borderRadius: 7, background: "var(--fill-1)", color: "var(--ink-3)" }}>{n.driver}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={SUB}>Published ports</span>
        {portRows.length === 0 && <Muted>{c.ports.length ? `Only exposed internally (${c.ports.map((p) => `${p.container}/${p.proto}`).join(", ")}).` : "No ports published."}</Muted>}
        {portRows.map((p) => (
          <div key={`${p.host}-${p.container}-${p.proto}`} className="mono" style={{ ...TILE, fontSize: 12 }}>
            <span style={{ color: "var(--ink)" }}>{p.ip && p.ip !== "0.0.0.0" && p.ip !== "::" ? `${p.ip}:` : ""}{p.host}</span>
            <span style={{ color: "var(--ink-3)" }}>→</span>
            <span style={{ color: "var(--ink)" }}>{p.container}</span>
            <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-3)" }}>{p.proto}</span>
            {p.proto === "tcp" && address && (
              <a href={`http://${hostAddr}:${p.host}`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                open ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12.5, color: "var(--ink-3)", padding: "2px 2px" }}>{children}</span>;
}

// ─── Logs ──────────────────────────────────────────────────────────────────

function LogsPane({ hostId, containerId, onFull }: { hostId: string; containerId: string; onFull: () => void }) {
  const [filter, setFilter] = useState("");
  const { lines, status } = useLogStream(hostId, containerId, "tail", false);
  const { ref, onScroll } = useStickToBottom(lines);
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input className="input mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" style={{ height: 34, fontSize: 12, flex: 1 }} />
        <button className="btn2" style={{ height: 34, fontSize: 12 }} onClick={onFull} title="Open in the terminal window">
          Full view ↗
        </button>
      </div>
      <div ref={ref} onScroll={onScroll} className="mono" style={{ borderRadius: 14, background: "rgba(20,23,31,.94)", padding: "12px 14px", fontSize: 11.5, lineHeight: 1.7, color: "#d5d8de", flex: 1, minHeight: 300, overflow: "auto" }}>
        {lines.length === 0 && <div style={{ color: "#6b7280" }}>{status === "connecting" ? "Connecting…" : status === "error" ? "Couldn't open the log stream." : status === "ended" ? "No log output." : "Waiting for log lines…"}</div>}
        <LogRows lines={lines} filter={filter} compact />
      </div>
    </>
  );
}

// ─── Events ────────────────────────────────────────────────────────────────

function eventColor(a: string): string {
  const s = a.toLowerCase();
  if (s.includes("unhealthy") || s.startsWith("die") || s.startsWith("kill") || s.startsWith("oom") || s.includes("error")) return C.crit;
  if (s.includes("healthy") || s.startsWith("start") || s.startsWith("create") || s.startsWith("unpause")) return C.ok;
  if (s.startsWith("restart") || s.startsWith("pause") || s.includes("starting")) return C.warn;
  if (s.startsWith("stop") || s.startsWith("destroy")) return "#9aa1ad";
  return C.blue;
}

function Events({ events }: { events: ContainerEvent[] }) {
  if (!events?.length) return <Muted>No events recorded yet.</Muted>;
  return (
    <div style={{ borderLeft: "1px solid var(--line-2)", padding: "0 0 0 16px", marginLeft: 4, display: "flex", flexDirection: "column", gap: 14 }}>
      {events.map((e, i) => (
        <div key={i} style={{ position: "relative", fontSize: 12.5, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ position: "absolute", left: -20, top: 5, width: 7, height: 7, borderRadius: "50%", background: eventColor(e.action) }} />
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", flex: "none" }} title={new Date(e.t).toLocaleString()}>
            {dateTime(e.t)}
          </span>
          <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>{e.action}</span>
          <span style={{ color: "var(--ink-2)" }}>{e.by}</span>
        </div>
      ))}
    </div>
  );
}
