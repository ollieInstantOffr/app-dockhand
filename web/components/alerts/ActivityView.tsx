"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "@/lib/api";
import { ago, C, dateTime, halo } from "@/lib/format";
import type { Host, Job } from "@/lib/types";
import { EmptyState, LogBlock, Seg } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";

// Activity: everything Dockhand has done — deploys, updates, patches, backups,
// clean-ups — with who asked for it. Answers "who restarted that, and when?".

const KIND: Record<string, { icon: IconName; label: string }> = {
  git: { icon: "branch", label: "Deploy" },
  image: { icon: "box", label: "Container" },
  compose: { icon: "layers", label: "Stack" },
  stack: { icon: "layers", label: "Stack" },
  pull: { icon: "download", label: "Pull" },
  update: { icon: "update", label: "Update" },
  backup: { icon: "disk", label: "Backup" },
  prune: { icon: "clean", label: "Clean-up" },
  "self-update": { icon: "update", label: "Dockhand" },
};

type Filter = "all" | "failed" | "running";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
];

/** How the job was started: a person, or Dockhand itself. */
function actorLabel(actor: string | undefined): string {
  switch (actor) {
    case undefined:
    case "":
    case "unknown":
      return "Dockhand";
    case "auto-deploy":
      return "GitHub push";
    case "auto-update":
      return "automatic update";
    case "webhook":
      return "webhook";
    default:
      return actor;
  }
}

export function ActivityView() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const { data: jobs, error } = useApi<Job[]>("/api/jobs?limit=100", { refresh: 10000 });
  const { data: hosts } = useApi<Host[]>("/api/hosts");
  const hostName = (id: string | null) => (id ? hosts?.find((h) => h.id === id)?.name : undefined);

  const list = (jobs ?? []).filter((j) => (filter === "all" ? true : filter === "failed" ? j.status === "failed" : j.status === "running"));

  return (
    <>
      <Seg fit options={FILTERS} value={filter} onChange={setFilter} style={{ marginBottom: 16 }} />
      {error && !jobs && <EmptyState icon="alert" title="Couldn't load activity" text={error.message} />}
      {!jobs && !error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="skel" style={{ height: 64, borderRadius: 18 }} />
          ))}
        </div>
      )}
      {jobs && !list.length && (
        <EmptyState icon="logs" title={filter === "failed" ? "Nothing has failed" : filter === "running" ? "Nothing running" : "No activity yet"} text="Deploys, updates, patches, backups and clean-ups all show up here with who started them." />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.map((j) => {
          const k = KIND[j.kind] ?? { icon: "dots" as IconName, label: j.kind };
          const color = j.status === "failed" ? C.crit : j.status === "running" ? C.blue : C.ok;
          const host = hostName(j.hostId);
          const isOpen = open === j.id;
          const took = j.finishedAt ? Math.max(1, Math.round((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000)) : 0;
          return (
            <div key={j.id} className="glass-card" style={{ borderRadius: 18, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : j.id)}
                aria-expanded={isOpen}
                style={{ display: "flex", alignItems: "center", gap: 12, border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--ink)", font: "inherit", textAlign: "left" }}
              >
                <span style={{ width: 34, height: 34, borderRadius: 11, background: halo(color, 0.14), color, display: "grid", placeItems: "center", flex: "none" }}>
                  {j.status === "running" ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name={k.icon} size={16} />}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                  <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>{j.title}</span>
                  <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {k.label} · by {actorLabel(j.actor)}
                    {host ? ` · ${host}` : ""}
                    {took ? ` · took ${took < 60 ? `${took}s` : `${Math.round(took / 60)}m`}` : ""}
                  </span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }} title={dateTime(j.startedAt)}>{ago(j.startedAt)}</span>
                  <span style={{ display: "inline-flex", transform: isOpen ? "rotate(90deg)" : undefined, transition: "transform .15s", color: "var(--ink-3)" }}>
                    <Icon name="chevronRight" size={13} />
                  </span>
                </span>
              </button>
              {isOpen && <JobDetail id={j.id} onOpenHost={() => j.hostId && router.push(`/hosts/${j.hostId}`)} hasHost={!!j.hostId} />}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** One job's steps and output, loaded when it is expanded. */
function JobDetail({ id, onOpenHost, hasHost }: { id: string; onOpenHost: () => void; hasHost: boolean }) {
  const { data: job } = useApi<Job>(`/api/jobs/${id}`, { refresh: 5000 });
  if (!job) return <span className="skel" style={{ height: 80, borderRadius: 12 }} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {job.steps.map((s) => (
          <span
            key={s.label}
            style={{ height: 26, padding: "0 10px", borderRadius: 9, fontSize: 11.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, background: "var(--fill-1)", color: s.status === "failed" ? "var(--crit-ink)" : s.status === "done" ? "var(--ok-ink)" : "var(--ink-3)" }}
          >
            {s.status === "done" && <Icon name="check" size={11} strokeWidth={3} />}
            {s.status === "failed" && <Icon name="x" size={11} strokeWidth={3} />}
            {s.label}
            {s.t && <span className="mono" style={{ opacity: 0.6 }}>{s.t}</span>}
          </span>
        ))}
      </div>
      {job.log.length > 0 && <LogBlock lines={job.log} running={job.status === "running"} style={{ maxHeight: 220 }} />}
      {hasHost && (
        <button type="button" className="btn2 sm" style={{ alignSelf: "flex-start" }} onClick={onOpenHost}>
          Open host
        </button>
      )}
    </div>
  );
}
