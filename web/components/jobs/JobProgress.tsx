"use client";

import { useEffect, useState } from "react";
import { C } from "@/lib/format";
import type { Job, JobStep } from "@/lib/types";
import { LogBlock } from "@/components/ui";
import { Icon } from "@/components/icons";
import { UpdateGauge } from "@/components/charts/UpdateGauge";
import { UpdateStages } from "@/components/charts/UpdateStages";
import type { UpdateStagesDatum } from "@/components/charts/UpdateStages.types";

// Live progress for any job: the Graphite gauge and stage strip used for
// Dockhand's own updates, the current step, elapsed time, and the output.

const STEP_STATUS: Record<string, UpdateStagesDatum["status"]> = { done: "done", running: "active", pending: "pending", skipped: "skipped", failed: "failed" };

/** Short labels for the strip: "Fetching repository" → "Fetch", keeping it readable in narrow dialogs. */
function shortLabel(label: string): string {
  const map: Record<string, string> = {
    "Fetching repository": "Fetch",
    Fetching: "Fetch",
    "Uploading to host": "Upload",
    "Updating checkout": "Checkout",
    "Writing .env": ".env",
    "Building & starting": "Build & start",
    Building: "Build",
    Starting: "Start",
    "Saving stack": "Save",
  };
  return map[label] ?? label.split(" ")[0];
}

export function jobPercent(job: Job): number {
  if (job.status === "success") return 100;
  const steps = job.steps.length ? job.steps : [];
  const total = Math.max(1, steps.length);
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const running = steps.some((s) => s.status === "running") ? 0.5 : 0;
  return Math.round(((done + running) / total) * 100);
}

export function currentStep(job: Job): JobStep | undefined {
  return job.steps.find((s) => s.status === "running") ?? job.steps.find((s) => s.status === "failed");
}

function elapsed(job: Job, now: number): string {
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  const s = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Full progress: gauge, current step, stage strip, and the log behind "Show output". */
export function JobProgress({ job, doneText, failedText }: { job: Job; doneText?: string; failedText?: string }) {
  const [now, setNow] = useState(Date.now());
  const running = job.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (job.status === "failed") setOpen(true);
  }, [job.status]);

  const tone = job.status === "success" ? "ok" : job.status === "failed" ? "crit" : "run";
  const cur = currentStep(job);
  const idx = cur ? job.steps.indexOf(cur) + 1 : job.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const lastError = [...job.log].reverse().find((l) => l.level === "error")?.text;
  const title =
    job.status === "success" ? (doneText ?? "Done") : job.status === "failed" ? `${failedText ?? "Failed"}${cur ? ` at ${cur.label.toLowerCase()}` : ""}` : cur?.label ?? "Starting…";
  const sub =
    job.status === "failed"
      ? lastError ?? "See the output below."
      : `${job.status === "success" ? "Finished" : `Step ${Math.max(1, idx)} of ${job.steps.length}`} · ${elapsed(job, now)}${cur?.sub && running ? ` · ${cur.sub}` : ""}`;
  const stages: UpdateStagesDatum[] = job.steps.map((s) => ({ label: shortLabel(s.label), value: s.status === "running" ? 50 : 100, status: job.status === "success" ? "done" : STEP_STATUS[s.status] ?? "pending" }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={jobPercent(job)} aria-label={title} style={{ display: "flex", alignItems: "center", gap: 18, padding: "16px 18px", borderRadius: 18, background: "var(--fill-1)", flexWrap: "wrap" }}>
        <UpdateGauge value={jobPercent(job)} tone={tone} width={88} />
        <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: "1 1 220px", minWidth: 0 }}>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700, color: tone === "crit" ? "var(--crit-ink)" : "var(--ink)" }}>
              {tone === "run" && <span className="spinner" style={{ width: 12, height: 12, color: C.blue, flex: "none" }} />}
              {tone === "ok" && <Icon name="checkCircle" size={15} color={C.ok} />}
              <span className="ellipsis">{title}</span>
            </span>
            <span className="ellipsis" style={{ fontSize: 12, color: tone === "crit" ? "var(--crit-ink)" : "var(--ink-3)" }}>{sub}</span>
          </span>
          {stages.length > 0 && <UpdateStages data={stages} />}
        </div>
      </div>
      {job.log.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 6, border: 0, background: "transparent", color: "var(--ink-3)", fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>
            <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }}>
              <Icon name="chevronRight" size={12} />
            </span>
            {open ? "Hide output" : "Show output"}
          </button>
          {open && <LogBlock lines={job.log} running={running} style={{ maxHeight: 240 }} />}
        </div>
      )}
    </div>
  );
}

/** One-line progress for a card: spinner, step, and a thin stage strip. */
export function JobProgressInline({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const cur = currentStep(job);
  const failed = job.status === "failed";
  const stages: UpdateStagesDatum[] = job.steps.map((s) => ({ label: shortLabel(s.label), value: 50, status: STEP_STATUS[s.status] ?? "pending" }));
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 14, border: `1px solid ${failed ? "rgba(226,80,76,.3)" : "rgba(47,111,237,.25)"}`, background: failed ? "var(--crit-bg)" : "rgba(47,111,237,.06)", cursor: "pointer", textAlign: "left", font: "inherit", color: "var(--ink)", width: "100%" }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: failed ? "var(--crit-ink)" : "var(--ink)" }}>
        {failed ? <Icon name="alert" size={14} color={C.crit} /> : <span className="spinner" style={{ width: 11, height: 11, color: C.blue }} />}
        <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
          {failed ? `${job.title} failed${cur ? ` at ${cur.label.toLowerCase()}` : ""}` : `${job.title} — ${cur?.label ?? "starting"}…`}
        </span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{failed ? "View output" : `${jobPercent(job)}% · Show progress`}</span>
      </span>
      {stages.length > 0 && <UpdateStages data={stages} height={6} gap={3} />}
    </button>
  );
}
