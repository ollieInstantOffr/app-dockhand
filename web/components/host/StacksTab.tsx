"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post } from "@/lib/api";
import { C, containerColor, halo, plural, portsText, shortSha } from "@/lib/format";
import type { JobRef, Stack } from "@/lib/types";
import { EmptyState, Skel } from "../ui";
import { Icon } from "../icons";
import { useShell } from "../shell/context";
import { trackJob } from "./jobs";

const STATUS_DOT: Record<Stack["status"], string> = { running: C.ok, partial: C.warn, stopped: "#9aa1ad" };

export function StacksTab({ hostId, stacks }: { hostId: string; stacks: Stack[] | undefined }) {
  const shell = useShell();
  const router = useRouter();
  const newStack = () => shell.openDialog({ type: "compose", hostId });

  if (!stacks) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Skel w={200} h={14} />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="glass-card" style={{ borderRadius: 22, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Skel w={10} h={10} r="50%" />
              <Skel w={140} h={16} />
              <Skel w={180} h={11} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Skel w={160} h={48} r={14} />
              <Skel w={160} h={48} r={14} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (stacks.length === 0) {
    return (
      <EmptyState icon="layers" title="No stacks yet" text="Compose projects on this host show up here. Write a compose file, or deploy a repo from GitHub and keep it in sync.">
        <button className="btn" onClick={newStack}>
          <Icon name="plus" size={15} />
          New stack
        </button>
        <button className="btn2" style={{ height: 40 }} onClick={() => router.push(`/deploy?mode=git&host=${hostId}`)}>
          Deploy from GitHub
        </button>
      </EmptyState>
    );
  }

  const git = stacks.filter((s) => s.source === "git").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {plural(stacks.length, "stack")} · {git} tracked from git
        </span>
        <button className="btn sm" style={{ marginLeft: "auto" }} onClick={newStack}>
          <Icon name="plus" size={15} />
          New stack
        </button>
      </div>
      {stacks.map((s) => (
        <StackCard key={s.name} s={s} hostId={hostId} />
      ))}
    </div>
  );
}

function StackCard({ s, hostId }: { s: Stack; hostId: string }) {
  const shell = useShell();
  const { openDialog, openContainer } = shell;
  const [busy, setBusy] = useState<string | null>(null);
  const dot = STATUS_DOT[s.status];
  const running = s.services.filter((v) => v.state === "running").length;
  const isGit = s.source === "git";
  const primary = s.status === "stopped" ? { label: "Start", action: "up" } : isGit ? { label: "Redeploy", action: "redeploy" } : { label: "Deploy", action: "redeploy" };
  const inv = [`/api/hosts/${hostId}`, "/api/containers", "/api/overview"];

  const run = async (action: string, title: string, done: string) => {
    setBusy(action);
    await trackJob(shell, post<JobRef>(`/api/hosts/${hostId}/stacks/${encodeURIComponent(s.name)}/${action}`), { title, done, invalidate: inv });
    setBusy(null);
  };

  const stop = async () => {
    const ok = await shell.confirm({
      title: `Stop ${s.name}?`,
      text: `All ${plural(s.services.length, "service")} in this stack are stopped. Containers and volumes are kept, so you can start it again.`,
      confirmLabel: "Stop stack",
      icon: "stop",
    });
    if (ok) run("stop", `Stopping ${s.name}`, `${s.name} stopped`);
  };

  return (
    <div className="glass-card" style={{ borderRadius: 22, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: dot, boxShadow: `0 0 0 4px ${halo(dot)}`, flex: "none" }} />
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>{s.name}</span>
        {s.path && <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{s.path}</span>}
        {s.repo && (
          <span className="mono" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "3px 9px 3px 6px", borderRadius: 8, background: "var(--fill-1)", color: "var(--ink-4)" }}>
            <span style={{ width: 16, height: 16, borderRadius: 5, background: "var(--btn)", color: "var(--btn-ink)", display: "grid", placeItems: "center" }}>
              <Icon name="branch" size={10} strokeWidth={2.2} />
            </span>
            {s.repo}
            {s.sha && <span style={{ color: "var(--ink-3)" }}>@ {shortSha(s.sha)}</span>}
          </span>
        )}
        <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          {running}/{s.services.length} running
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn-primary-sm" disabled={!!busy} onClick={() => run(primary.action, `${primary.label === "Start" ? "Starting" : "Redeploying"} ${s.name}`, `${s.name} ${primary.label === "Start" ? "started" : "redeployed"}`)} style={{ height: 32, padding: "0 14px", borderRadius: 11, border: 0, background: "var(--btn)", color: "var(--btn-ink)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
            {busy === primary.action && <span className="spinner" style={{ width: 11, height: 11 }} />}
            {primary.label}
          </button>
          <button className="btn2" style={{ height: 32, padding: "0 12px", borderRadius: 11, fontSize: 12.5 }} onClick={() => openDialog({ type: "compose", hostId, stack: s.name })}>
            Edit compose
          </button>
          {s.status !== "stopped" && (
            <button className="btn2" style={{ height: 32, padding: "0 12px", borderRadius: 11, fontSize: 12.5 }} disabled={!!busy} onClick={stop}>
              {busy === "stop" && <span className="spinner" style={{ width: 11, height: 11 }} />}
              Stop
            </button>
          )}
        </div>
      </div>
      {s.services.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {s.services.map((v) => {
            const vdot = v.state === "missing" ? "#9aa1ad" : containerColor(v.state, v.health);
            const meta = v.state === "running" ? (v.ports.length ? portsText(v.ports) : "internal") : v.state;
            return (
              <button
                key={v.name}
                className="chip-hover"
                disabled={!v.containerId}
                onClick={() => v.containerId && openContainer(hostId, v.containerId)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px 10px 12px", borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent", cursor: v.containerId ? "pointer" : "default", textAlign: "left", color: "var(--ink)", maxWidth: "100%", opacity: 1 }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: vdot, flex: "none" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{v.name}</span>
                  <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                    {v.image} · {meta}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
