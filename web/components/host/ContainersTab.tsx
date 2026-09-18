"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { del, invalidate, post } from "@/lib/api";
import { C, bytesShort, containerColor, containerStateLabel, duration, ago, portsText, since } from "@/lib/format";
import type { Container, ContainerAction, Host, JobRef } from "@/lib/types";
import { EmptyState, Skel, useOutside, type MenuItem } from "../ui";
import { Icon, type IconName } from "../icons";
import { useShell } from "../shell/context";
import { SemiGauge } from "../charts/SemiGauge";
import { act, trackJob } from "./jobs";
import { InkStatus, gaugeColor } from "./bits";

export const CTR_GRID: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,280px),1fr))", gap: 14 };

export function sortContainers(list: Container[]): Container[] {
  return [...list].sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name));
}

export function matchContainer(c: Container, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return c.name.toLowerCase().includes(s) || c.image.toLowerCase().includes(s) || c.stack.toLowerCase().includes(s);
}

export function uptimeText(c: Container): string {
  if (c.state === "running") return c.startedAt ? `up ${duration(since(c.startedAt))}` : "running";
  if (c.state === "paused") return "paused";
  if (c.state === "restarting") return "restarting…";
  if (c.state === "exited" || c.state === "dead") return `exited (${c.exitCode})${c.finishedAt ? ` · ${ago(c.finishedAt)}` : ""}`;
  if (c.state === "created") return "created";
  return c.status || c.state;
}

/** Shared container actions (card, sidecar, palette). */
export function useContainerActions(hostId: string) {
  const shell = useShell();
  const base = `/api/hosts/${hostId}/containers`;
  const refresh = () => {
    invalidate(`/api/hosts/${hostId}`);
    invalidate("/api/containers");
    invalidate("/api/overview");
  };

  const run = async (c: Pick<Container, "id" | "name">, action: Exclude<ContainerAction, "update">) => {
    const label: Record<string, string> = { start: "Started", stop: "Stopped", restart: "Restarted", pause: "Paused", unpause: "Resumed", kill: "Killed" };
    await act(shell, () => post(`${base}/${c.id}/${action}`), { title: `${label[action]} ${c.name}` }, `Couldn't ${action === "unpause" ? "resume" : action} ${c.name}`);
    refresh();
  };

  const update = async (c: Pick<Container, "id" | "name" | "image" | "update">, ask = true) => {
    if (ask) {
      const ok = await shell.confirm({
        title: `Update ${c.name}?`,
        text: "Dockhand pulls the new image and recreates the container with the same configuration. It will be briefly unavailable.",
        confirmLabel: "Update",
        icon: "update",
        details: [
          { k: "Image", v: c.image },
          ...(c.update?.tag ? [{ k: "New version", v: c.update.tag }] : []),
        ],
      });
      if (!ok) return;
    }
    await trackJob(shell, post<JobRef>(`${base}/${c.id}/update`), { title: `Updating ${c.name}`, done: `${c.name} updated`, invalidate: [`/api/hosts/${hostId}`, "/api/containers", "/api/overview"] });
  };

  const remove = async (c: Pick<Container, "id" | "name" | "image">): Promise<boolean> => {
    const ok = await shell.confirm({
      title: `Remove ${c.name}?`,
      text: "The container is stopped and deleted. Named volumes are kept, so its data survives.",
      confirmLabel: "Remove",
      danger: true,
      icon: "trash",
      details: [{ k: "Image", v: c.image }],
    });
    if (!ok) return false;
    const r = await act(shell, () => del(`${base}/${c.id}?force=1&volumes=0`), { title: `Removed ${c.name}` }, `Couldn't remove ${c.name}`);
    refresh();
    return r !== undefined;
  };

  return { run, update, remove, refresh };
}

export function ContainersTab({
  hostId,
  host,
  containers,
  filter,
  selected,
  setSelected,
}: {
  hostId: string;
  host: Host | undefined;
  containers: Container[] | undefined;
  filter: string;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
}) {
  const router = useRouter();
  if (!containers) {
    return (
      <div style={CTR_GRID}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="glass-card" style={{ borderRadius: 20, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <Skel w={20} h={20} r={7} style={{ flex: "none" }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                <Skel w="55%" h={14} />
                <Skel w="80%" h={10} />
              </span>
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <Skel w="50%" h={4} />
              <Skel w="50%" h={4} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <Skel w="25%" h={30} r={10} />
              <Skel w="25%" h={30} r={10} />
              <Skel w="25%" h={30} r={10} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (containers.length === 0) {
    return (
      <EmptyState icon="box" title="Nothing running here" text="This host has Docker but no containers yet. Run one from an image, or deploy a compose stack from GitHub.">
        <button className="btn" onClick={() => router.push(`/deploy?mode=image&host=${hostId}`)}>
          Run a container
        </button>
        <button className="btn2" style={{ height: 40 }} onClick={() => router.push(`/deploy?mode=git&host=${hostId}`)}>
          Deploy from GitHub
        </button>
      </EmptyState>
    );
  }
  const shown = sortContainers(containers).filter((c) => matchContainer(c, filter));
  if (!shown.length) {
    return <div style={{ padding: "28px 4px", fontSize: 13.5, color: "var(--ink-3)" }}>No containers match “{filter}”.</div>;
  }
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };
  return (
    <div style={CTR_GRID}>
      {shown.map((c) => (
        <ContainerCard key={c.id} c={c} hostId={hostId} memTotal={host?.memTotal ?? 0} selected={selected.has(c.id)} onToggle={() => toggle(c.id)} />
      ))}
    </div>
  );
}

/** Short uppercase state for the header band. */
function stateShort(c: Container): string {
  if (c.state === "exited" && c.exitCode !== 0) return "Crashed";
  if (c.state === "exited") return "Stopped";
  return containerStateLabel(c.state, c.health);
}

function ContainerCard({ c, hostId, memTotal, selected, onToggle }: { c: Container; hostId: string; memTotal: number; selected: boolean; onToggle: () => void }) {
  const { openContainer, openTerminal } = useShell();
  const actions = useContainerActions(hostId);
  const [busy, setBusy] = useState(false);
  // Lift the card above its neighbours while its "…" menu is open, or the next row covers the menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const color = containerColor(c.state, c.health);
  const dot = color.startsWith("#") ? color : "#9aa1ad";
  const running = c.state === "running";
  const live = running || c.state === "paused";
  const crashed = c.state === "dead" || (c.state === "exited" && c.exitCode !== 0);
  const memMax = c.memLimit > 0 ? c.memLimit : memTotal;
  const memPct = memMax > 0 ? Math.min(100, (c.memUsed / memMax) * 100) : 0;
  const cpuPct = Math.min(100, Math.max(0, c.cpu));

  const wrap = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const primary: { label: string; icon: IconName; go: () => Promise<void> } =
    running || c.state === "restarting" ? { label: "Stop", icon: "stop", go: () => actions.run(c, "stop") } : c.state === "paused" ? { label: "Resume", icon: "play", go: () => actions.run(c, "unpause") } : { label: "Start", icon: "play", go: () => actions.run(c, "start") };

  const menu: MenuItem[] = [
    { label: "Restart", icon: "restart", onClick: wrap(() => actions.run(c, "restart")) },
    c.state === "paused" ? { label: "Resume", icon: "play", onClick: wrap(() => actions.run(c, "unpause")) } : { label: "Pause", icon: "pause", onClick: wrap(() => actions.run(c, "pause")) },
    { label: c.update?.available ? `Update to ${c.update.tag}` : "Update", icon: "update", onClick: () => actions.update(c) },
    { label: "Edit config", icon: "sliders", onClick: () => openContainer(hostId, c.id, "env") },
    { label: "Remove", icon: "trash", danger: true, onClick: () => actions.remove(c) },
  ];

  // Big stat: live CPU while running, otherwise the exit code / state.
  const big = running
    ? { v: `${c.cpu.toFixed(c.cpu < 10 ? 1 : 0)}%`, l: "cpu", color: c.health === "unhealthy" ? C.crit : "var(--ink)" }
    : c.state === "paused"
      ? { v: "Paused", l: "", color: C.warn }
      : c.state === "restarting"
        ? { v: "Restarting", l: "", color: C.warn }
        : crashed
          ? { v: String(c.exitCode), l: "exit code", color: C.crit }
          : c.state === "created"
            ? { v: "Created", l: "", color: "var(--ink-3)" }
            : { v: "Stopped", l: "", color: "var(--ink-3)" };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className="ctr-card"
      onClick={() => openContainer(hostId, c.id)}
      style={{ position: "relative", zIndex: menuOpen ? 6 : undefined, borderRadius: 26, background: "var(--surface)", boxShadow: selected ? "0 0 0 2px #2f6fed, var(--card-shadow)" : "var(--card-shadow)", display: "flex", flexDirection: "column", overflow: "visible", cursor: "pointer", minWidth: 0, opacity: !menuOpen && !live && !crashed && c.state !== "restarting" ? 0.82 : 1 }}
    >
      <div className="ink-head" style={{ padding: "14px 14px 14px 16px", borderRadius: "26px 26px 0 0" }}>
        <button
          onClick={(e) => {
            stop(e);
            onToggle();
          }}
          title={selected ? "Deselect" : "Select"}
          aria-pressed={selected}
          className="mono"
          style={{ position: "relative", width: 34, height: 34, flex: "none", borderRadius: 11, border: 0, background: selected ? "#2f6fed" : "rgba(127,127,127,.22)", color: selected ? "#fff" : "var(--btn-ink)", cursor: "pointer", padding: 0, display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, boxShadow: "0 0 0 2px rgba(255,255,255,.14)", transition: "all .2s" }}
        >
          {selected ? <Icon name="check" size={16} strokeWidth={3} /> : (c.name.trim()[0] ?? "?").toUpperCase()}
        </button>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 2, flex: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span className="ellipsis" title={c.name} style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.2, flex: "0 1 auto", minWidth: 0 }}>{c.name}</span>
            {c.stack && <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.7, padding: "2px 6px", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", whiteSpace: "nowrap", letterSpacing: ".03em", maxWidth: "45%", minWidth: 24, overflow: "hidden", textOverflow: "ellipsis", flex: "0 6 auto" }} title={`stack: ${c.stack}`}>{c.stack}</span>}
          </span>
          <span className="mono ellipsis" style={{ fontSize: 11, opacity: 0.6 }}>{c.image}</span>
        </span>
        <InkStatus color={dot} label={stateShort(c)} title={c.status} pulse={running && c.health !== "unhealthy" ? "live" : crashed || c.health === "unhealthy" || c.state === "restarting" ? "down" : undefined} />
        <CardMenu items={menu} onOpenChange={setMenuOpen} />
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 18, padding: "16px 18px 16px 16px" }}>
        <span style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 10, flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span className="big-num" style={{ fontSize: 30, color: big.color, whiteSpace: "nowrap" }}>{big.v}</span>
            {big.l && <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.2 }}>{big.l}</span>}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
            {c.update?.available && (
              <button
                className="upd-tag"
                title={`Update to ${c.update.tag}`}
                onClick={(e) => {
                  stop(e);
                  actions.update(c);
                }}
                style={{ display: "flex", alignItems: "center", gap: 5, height: 24, padding: "0 9px 0 7px", borderRadius: 8, border: 0, background: "rgba(47,111,237,.1)", color: "#2f6fed", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}
              >
                <Icon name="update" size={12} strokeWidth={2} />
                {c.update.tag || "update"}
              </button>
            )}
            <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)", minWidth: 0 }}>{portsText(c.ports)}</span>
          </span>
        </span>
        <span style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
          <SemiGauge label="CPU" value={live ? cpuPct : 0} color={live ? gaugeColor(cpuPct, C.blue) : "#9aa1ad"} width={54} valueLabel={live ? `${Math.round(cpuPct)}%` : "—"} />
          <SemiGauge label="MEM" value={live ? memPct : 0} color={live ? gaugeColor(memPct, C.violet) : "#9aa1ad"} width={54} valueLabel={live ? (memMax > 0 ? `${Math.round(memPct)}%` : bytesShort(c.memUsed)) : "—"} />
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 14px 14px 16px" }}>
        <span className="ellipsis" style={{ fontSize: 11.5, color: crashed ? "var(--crit-ink)" : "var(--ink-3)", fontWeight: 600, flex: 1, minWidth: 0 }}>{uptimeText(c)}</span>
        <button
          className="fill-hover"
          title="Logs"
          onClick={(e) => {
            stop(e);
            openTerminal({ kind: "logs", hostId, containerId: c.id, name: c.name });
          }}
          style={ICON_BTN}
        >
          <Icon name="logs" size={15} />
        </button>
        <button
          className="fill-hover"
          title={running ? "Shell" : "Container is not running"}
          disabled={!running}
          onClick={(e) => {
            stop(e);
            openTerminal({ kind: "exec", hostId, containerId: c.id, name: c.name });
          }}
          style={ICON_BTN}
        >
          <Icon name="terminal" size={15} />
        </button>
        <button
          className="fill-hover"
          disabled={busy}
          onClick={(e) => {
            stop(e);
            wrap(primary.go)();
          }}
          style={{ height: 32, padding: "0 12px", borderRadius: 10, border: 0, background: "var(--fill-1)", cursor: "pointer", color: "var(--ink)", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, flex: "none" }}
        >
          {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name={primary.icon} size={13} />}
          {primary.label}
        </button>
      </div>
    </div>
  );
}

const ICON_BTN: React.CSSProperties = { width: 32, height: 32, borderRadius: 10, border: 0, background: "var(--fill-1)", cursor: "pointer", color: "var(--ink-2)", display: "grid", placeItems: "center", flex: "none" };

/** "…" menu on the dark header band. */
function CardMenu({ items, onOpenChange }: { items: MenuItem[]; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <span ref={ref} style={{ position: "relative", display: "flex" }} onClick={(e) => e.stopPropagation()}>
      <button className="ink-btn" aria-label="More actions" onClick={() => setOpen(!open)} style={{ width: 30, height: 30, borderRadius: 10, border: 0, background: "transparent", cursor: "pointer", color: "var(--btn-ink)", opacity: 0.7, display: "grid", placeItems: "center" }}>
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="menu" style={{ right: 0, top: 34, minWidth: 200, color: "var(--ink)" }}>
          {items.map((m) => (
            <button
              key={m.label}
              type="button"
              className="menu-item"
              style={{ color: m.danger ? "var(--crit-ink)" : "var(--ink)" }}
              onClick={() => {
                setOpen(false);
                m.onClick();
              }}
            >
              {m.icon && <span style={{ display: "flex", color: m.danger ? "var(--crit-ink)" : "var(--ink-3)" }}><Icon name={m.icon} size={15} /></span>}
              {m.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
