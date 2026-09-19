"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, invalidate, post } from "@/lib/api";
import { C, ago, avatarBg, bytes, duration, initial, plural } from "@/lib/format";
import type { Container, Host, HostTestResult, JobRef } from "@/lib/types";
import { Skel, useOutside } from "../ui";
import { Icon } from "../icons";
import { useShell, type Shell } from "../shell/context";
import { SemiGauge } from "../charts/SemiGauge";
import { act, trackJob } from "./jobs";
import { InkStatus, gaugeColor, gbPair, hostBigColor, hostDot, hostStatusShort, stoppedText } from "./bits";

const CARD: React.CSSProperties = { borderRadius: 26, background: "var(--surface)", boxShadow: "var(--card-shadow)", display: "flex", flexDirection: "column", overflow: "hidden" };
const INVALIDATE = [`/api/hosts`, "/api/containers", "/api/overview"];

/** "Clean up" confirm + prune job (host header and the storage "Reclaim" button). */
export async function confirmPrune(shell: Pick<Shell, "confirm" | "toast">, host: Pick<Host, "id" | "name" | "total" | "running" | "diskUsed" | "diskTotal">, reclaimable?: number) {
  const ok = await shell.confirm({
    title: `Clean up ${host.name}?`,
    text: "Removes stopped containers, unused images, unused networks and the build cache. Volumes are kept.",
    confirmLabel: "Clean up",
    danger: true,
    icon: "clean",
    details: [
      { k: "Stopped containers", v: String(Math.max(0, host.total - host.running)) },
      ...(reclaimable != null ? [{ k: "Reclaimable", v: bytes(reclaimable) }] : host.diskTotal ? [{ k: "Disk used", v: `${bytes(host.diskUsed)} / ${bytes(host.diskTotal)}` }] : []),
    ],
  });
  if (!ok) return;
  trackJob(shell, post<JobRef>(`/api/hosts/${host.id}/prune`, { containers: true, images: true, networks: true, volumes: false, buildCache: true }), { title: `Cleaning up ${host.name}`, done: `${host.name} cleaned up`, invalidate: INVALIDATE });
}

export function HostHeader({ host, containers }: { host: Host | undefined; containers: Container[] | undefined }) {
  const router = useRouter();
  const shell = useShell();
  if (!host) {
    return (
      <div style={CARD}>
        <div className="ink-head" style={{ padding: "16px 18px 16px 20px", gap: 14 }}>
          <Skel w={44} h={44} r={14} style={{ flex: "none", opacity: 0.4 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
            <Skel w={160} h={18} style={{ opacity: 0.4 }} />
            <Skel w={260} h={10} style={{ opacity: 0.4 }} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "16px 20px" }}>
          <Skel w={120} h={38} />
          <span style={{ flex: 1 }} />
          <Skel w={64} h={40} r={12} />
          <Skel w={64} h={40} r={12} />
          <Skel w={64} h={40} r={12} />
        </div>
      </div>
    );
  }

  const offline = host.status === "offline";
  const local = host.method === "local";

  const updateAll = async () => {
    if (host.updates === 0) {
      shell.toast({ kind: "info", title: "Everything is up to date", text: `No image updates on ${host.name}.` });
      return;
    }
    const ok = await shell.confirm({
      title: `Update ${plural(host.updates, "container")} on ${host.name}?`,
      text: "Dockhand pulls each new image and recreates the container with the same configuration. Each one restarts briefly.",
      confirmLabel: "Update all",
      icon: "update",
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`/api/hosts/${host.id}/update-all`), { title: `Updating containers on ${host.name}`, done: `${host.name} is up to date`, invalidate: INVALIDATE });
  };

  const reboot = async () => {
    const ok = await shell.confirm({
      title: `Reboot ${host.name}?`,
      text: `Every container on this host goes down until the machine is back. Containers with a restart policy come back on their own.`,
      confirmLabel: "Reboot",
      danger: true,
      icon: "power",
      typeToConfirm: host.name,
      details: [
        { k: "Running containers", v: String(host.running) },
        { k: "Up", v: duration(host.uptimeSec) },
      ],
    });
    if (!ok) return;
    const r = await act(shell, () => post(`/api/hosts/${host.id}/reboot`), { title: `Rebooting ${host.name}`, text: "It shows as offline until it comes back — usually a minute or two." }, `Couldn't reboot ${host.name}`);
    if (r !== undefined) invalidate("/api/hosts");
  };

  const meta = [host.address, host.os, host.dockerVersion && `docker ${host.dockerVersion}`, host.uptimeSec > 0 && `up ${duration(host.uptimeSec)}`].filter(Boolean).join(" · ");
  const gauges = [
    { label: "CPU", v: host.cpu, base: C.blue, detail: host.cpuCores ? plural(host.cpuCores, "core") : "—" },
    { label: "MEM", v: host.mem, base: C.violet, detail: gbPair(host.memUsed, host.memTotal) },
    { label: "DISK", v: host.disk, base: C.ok, detail: gbPair(host.diskUsed, host.diskTotal) },
  ];

  return (
    <div style={{ ...CARD, overflow: "visible", position: "relative", zIndex: 5 }}>
      <div className="ink-head" style={{ gap: 14, padding: "16px 18px 16px 20px", flexWrap: "wrap", borderRadius: "26px 26px 0 0" }}>
        <span style={{ width: 44, height: 44, borderRadius: 14, background: avatarBg(host.color), color: "#fff", display: "grid", placeItems: "center", fontSize: 17, fontWeight: 700, flex: "none", boxShadow: "0 0 0 2px rgba(255,255,255,.14)" }}>{initial(host.name)}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 3, flex: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{host.name}</h1>
            <InkStatus color={hostDot(host)} label={hostStatusShort(host)} pulse={offline ? "down" : undefined} />
          </span>
          <span className="mono ellipsis" style={{ fontSize: 11.5, opacity: 0.6 }}>{meta}</span>
        </span>
        <ShellButton host={host} containers={containers} offline={offline} />
        <button
          onClick={() => router.push(`/machines?host=${host.id}`)}
          title="Operating system updates, hardening and services"
          style={{ height: 36, padding: "0 14px", borderRadius: 12, border: 0, background: "rgba(127,127,127,.22)", color: "var(--btn-ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", flex: "none" }}
        >
          <Icon name="shield" size={15} strokeWidth={2.2} />
          OS &amp; security
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "16px 20px", flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "flex-end", gap: 10, flex: 1, minWidth: 200 }}>
          <span className="big-num" style={{ fontSize: 38, lineHeight: 1, color: hostBigColor(host), whiteSpace: "nowrap" }}>{host.running}</span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12, lineHeight: 1.2, color: "var(--ink-3)", flex: "none", paddingBottom: 3 }}>
            <span style={{ color: "var(--ink-2)", fontWeight: 600, whiteSpace: "nowrap" }}>of {host.total} running</span>
            <span style={{ whiteSpace: "nowrap" }}>{stoppedText(host)}</span>
          </span>
        </span>
        <span style={{ display: "flex", gap: 14, alignItems: "flex-end", opacity: offline ? 0.5 : 1 }}>
          {gauges.map((g) => (
            <SemiGauge key={g.label} label={g.label} value={offline ? 0 : g.v} color={offline ? "#9aa1ad" : gaugeColor(g.v, g.base)} width={64} detail={g.detail} valueLabel={offline ? "—" : undefined} />
          ))}
        </span>
        <span style={{ width: 1, height: 44, background: "var(--line-1)", margin: "0 4px" }} />
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn2" onClick={updateAll} disabled={offline}>
            <Icon name="update" size={15} />
            Update all
          </button>
          <button className="btn2" onClick={() => confirmPrune(shell, host)} disabled={offline}>
            <Icon name="clean" size={15} />
            Clean up
          </button>
          {!local && (
            <button className="btn2" onClick={reboot} disabled={offline}>
              <Icon name="power" size={15} />
              Reboot
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * "Open SSH": opens a root/login shell on the host itself (SSH for remote hosts,
 * an nsenter helper for the local one). The chevron lists the host shell and
 * every running container.
 */
function ShellButton({ host, containers, offline }: { host: Host; containers: Container[] | undefined; offline: boolean }) {
  const { openTerminal } = useShell();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const running = (containers ?? []).filter((c) => c.state === "running").sort((a, b) => a.name.localeCompare(b.name));
  const local = host.method === "local";
  const hostTitle = local ? "Root shell on the Docker host (via nsenter)" : `ssh ${host.user}@${host.address}`;
  const openHost = () => {
    setOpen(false);
    openTerminal({ kind: "shell", hostId: host.id });
  };
  const seg: React.CSSProperties = { height: 36, border: 0, background: "var(--btn-ink)", color: "var(--btn)", fontSize: 13, fontWeight: 700, cursor: offline ? "default" : "pointer", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", opacity: offline ? 0.6 : 1 };
  return (
    <span ref={ref} style={{ position: "relative", display: "flex", flex: "none", gap: 1 }}>
      <button onClick={openHost} disabled={offline} title={offline ? "Host is offline" : hostTitle} style={{ ...seg, padding: "0 12px 0 14px", borderRadius: "12px 0 0 12px" }}>
        <Icon name="terminal" size={15} strokeWidth={2.2} />
        Open SSH
      </button>
      <button onClick={() => setOpen(!open)} disabled={offline} aria-label="Choose a shell" aria-haspopup="menu" aria-expanded={open} style={{ ...seg, padding: "0 10px", borderRadius: "0 12px 12px 0" }}>
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ right: 0, top: 42, minWidth: 260, maxHeight: 360, overflow: "auto", color: "var(--ink)" }}>
          <span className="section-label" style={{ padding: "6px 10px 4px" }}>Host</span>
          <button className="menu-item" role="menuitem" style={{ flex: "none" }} onClick={openHost}>
            <Icon name="server" size={15} />
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span>Host shell</span>
              <span className="mono ellipsis" style={{ fontSize: 11, fontWeight: 400, color: "var(--ink-3)" }}>{local ? "root on this machine" : `${host.user}@${host.address}`}</span>
            </span>
          </button>
          <span className="section-label" style={{ padding: "10px 10px 4px" }}>Containers</span>
          {running.length === 0 && <span style={{ padding: "6px 10px 8px", fontSize: 12.5, color: "var(--ink-3)" }}>No running containers on {host.name}</span>}
          {running.map((c) => (
            <button
              key={c.id}
              className="menu-item mono"
              role="menuitem"
              style={{ flex: "none" }}
              onClick={() => {
                setOpen(false);
                openTerminal({ kind: "exec", hostId: host.id, containerId: c.id, name: c.name });
              }}
            >
              <span className="dot" style={{ width: 7, height: 7, background: C.ok }} />
              <span className="ellipsis">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function OfflineBanner({ host }: { host: Host }) {
  const shell = useShell();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      const r = await post<HostTestResult>(`/api/hosts/${host.id}/test`);
      if (r.ok) shell.toast({ kind: "ok", title: `${host.name} is back online` });
      else {
        const failed = r.steps.find((s) => s.status === "failed");
        shell.toast({ kind: "error", title: `Still can't reach ${host.name}`, text: r.error || failed?.sub || failed?.label });
      }
    } catch (e) {
      shell.toast({ kind: "error", title: `Still can't reach ${host.name}`, text: errMsg(e) });
    } finally {
      setBusy(false);
      invalidate("/api/hosts");
      invalidate("/api/overview");
    }
  };
  const retryText = [host.lastSeenAt ? `last seen ${ago(host.lastSeenAt)}` : "never connected", host.failCount > 0 && `${plural(host.failCount, "failed check")}`].filter(Boolean).join(" · ");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", borderRadius: 18, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.35)", animation: "rise .3s ease both", flexWrap: "wrap" }}>
      <span style={{ width: 36, height: 36, borderRadius: 11, background: "rgba(226,80,76,.16)", color: "#e2504c", display: "grid", placeItems: "center", flex: "none" }}>
        <Icon name="alert" size={18} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 200 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Can&apos;t reach {host.name}</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{host.lastError || "The SSH connection failed. Dockhand keeps retrying in the background."}</span>
      </span>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{retryText}</span>
      <button className="btn sm" onClick={retry} disabled={busy}>
        {busy ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <Icon name="restart" size={15} />}
        Retry now
      </button>
      <button className="btn2" onClick={() => shell.openDialog({ type: "host", hostId: host.id })}>
        Edit connection
      </button>
    </div>
  );
}
