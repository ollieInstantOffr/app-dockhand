"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, LogBlock, ProgressList } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { invalidate, useJob } from "@/lib/api";
import type { JobLogLine } from "@/lib/types";
import { cardStyle } from "./shared";

/** Step 3 of every deploy flow: progress list + live log. */
export function DeployProgress({ jobId, name, hostId, hostName, target, onAnother, onBack }: { jobId: string; name: string; hostId: string; hostName: string; target: "stack" | "container"; onAnother: () => void; onBack: () => void }) {
  const job = useJob(jobId);
  const router = useRouter();
  const { toast } = useShell();
  const notified = useRef(false);

  useEffect(() => {
    if (!job || job.status === "running" || notified.current) return;
    notified.current = true;
    invalidate("/api/hosts");
    invalidate("/api/containers");
    invalidate("/api/overview");
    invalidate("/api/github");
    if (job.status === "success") toast({ kind: "ok", title: `${name} is live`, text: `Deployed to ${hostName}` });
    else toast({ kind: "error", title: `Deploy of ${name} failed`, text: job.steps.find((s) => s.status === "failed")?.sub || "See the log for details" });
  }, [job, name, hostName, toast]);

  const running = !job || job.status === "running";
  const lines: JobLogLine[] = job?.log.length ? job.log : [{ text: "Starting…", level: "muted" }];
  const failedStep = job?.steps.find((s) => s.status === "failed");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 18, alignItems: "start", animation: "rise .3s ease both" }}>
      <Card style={{ ...cardStyle, gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span className="ellipsis" style={{ fontSize: 16, fontWeight: 700 }}>{name}</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}>→ {hostName}</span>
          {running && <span className="spinner" style={{ marginLeft: "auto", color: "var(--blue)", width: 13, height: 13 }} />}
        </div>
        {job ? (
          <ProgressList steps={job.steps} />
        ) : (
          <div style={{ padding: "9px 10px", fontSize: 13, color: "var(--ink-3)" }}>Queuing job…</div>
        )}
        {job?.status === "success" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 6, borderTop: "1px solid var(--line-1)", animation: "rise .3s ease both" }}>
            <button type="button" className="btn" onClick={() => router.push(`/hosts/${hostId}?tab=${target === "stack" ? "stacks" : "containers"}`)}>
              Open {target} on {hostName}
            </button>
            <button type="button" className="btn2" onClick={onAnother}>Deploy another</button>
          </div>
        )}
        {job?.status === "failed" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 6, borderTop: "1px solid var(--line-1)", animation: "rise .3s ease both" }}>
            <div style={{ padding: "10px 12px", borderRadius: 12, background: "var(--crit-bg)", color: "var(--crit-ink)", fontSize: 12.5, lineHeight: 1.5 }}>
              {failedStep ? <><b>{failedStep.label} failed.</b> {failedStep.sub}</> : "The deploy failed — see the log for details."}
            </div>
            <button type="button" className="btn" onClick={onBack}>Back to configuration</button>
            <button type="button" className="btn2" onClick={onAnother}>Deploy another</button>
          </div>
        )}
      </Card>
      <LogBlock
        lines={lines}
        running={running}
        style={{ borderRadius: 22, background: "rgba(20,23,31,.92)", border: "1px solid rgba(255,255,255,.08)", boxShadow: "0 24px 60px rgba(20,25,40,.25)", padding: "16px 20px", fontSize: 12.5, lineHeight: 1.75, minHeight: 420, maxHeight: 640, wordBreak: "break-word" }}
      />
    </div>
  );
}
