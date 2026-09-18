"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader, HostChips, LogBlock, ProgressList, Skel, Stepper } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post, put, useApi, useJob } from "@/lib/api";
import type { JobRef } from "@/lib/types";
import { Actions, Field, Group, useHosts } from "./common";
import { ComposeEditor, STACK_NAME_RE, TemplateChips, ValidationLine, isValid, useComposeValidation, type ComposeTemplate } from "./ComposeEditor";

export function ComposeDialog({ hostId: initialHost, stack, onClose }: { hostId: string; stack?: string; onClose: () => void }) {
  const { toast } = useShell();
  const editing = !!stack;
  const hosts = useHosts();
  const [step, setStep] = useState(editing ? 1 : 0);
  const [name, setName] = useState(stack ?? "");
  const [hostId, setHostId] = useState(initialHost);
  const [tpl, setTpl] = useState("");
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const notified = useRef(false);

  const templates = useApi<ComposeTemplate[]>(editing ? null : "/api/compose/templates");
  const existing = useApi<{ path: string; content: string }>(editing ? `/api/hosts/${initialHost}/stacks/${encodeURIComponent(stack!)}/compose` : null, { revalidateOnFocus: false });
  const validation = useComposeValidation(content, step === 1 && !jobId);

  useEffect(() => {
    if (existing.data && original === null) {
      setOriginal(existing.data.content);
      setContent(existing.data.content);
    }
  }, [existing.data, original]);
  useEffect(() => {
    const first = templates.data?.[0];
    if (first && !tpl) {
      setTpl(first.id);
      setContent(first.content);
    }
  }, [templates.data, tpl]);

  const host = hosts.find((h) => h.id === hostId);
  const stackName = name.trim();

  useEffect(() => {
    if (!job || job.status === "running" || notified.current) return;
    notified.current = true;
    invalidate(`/api/hosts/${hostId}/stacks`);
    invalidate(`/api/hosts/${hostId}/containers`);
    invalidate("/api/containers");
    if (job.status === "success") toast({ kind: "ok", title: editing ? `${stackName} updated` : `${stackName} is up`, text: host ? `on ${host.name}` : undefined });
    else toast({ kind: "error", title: `${stackName} failed to deploy`, text: job.steps.find((s) => s.status === "failed")?.sub });
  }, [job, hostId, editing, stackName, host, toast]);

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!STACK_NAME_RE.test(stackName)) return setErr("Stack names use lowercase letters, digits, “-” and “_”.");
    if (!hostId) return setErr("Pick a host to deploy to.");
    setStep(1);
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = editing
        ? await put<JobRef>(`/api/hosts/${hostId}/stacks/${encodeURIComponent(stackName)}/compose`, { content })
        : await post<JobRef>(`/api/hosts/${hostId}/stacks`, { name: stackName, content });
      notified.current = false;
      setJobId(r.jobId);
    } catch (e) {
      toast({ kind: "error", title: editing ? "Couldn't apply changes" : "Couldn't create the stack", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? `Edit ${stack}` : "New stack";
  const sub = editing ? existing.data?.path ?? `/opt/dockhand/stacks/${stack}/docker-compose.yml` : `${host?.name ?? "host"} · /opt/dockhand/stacks/${stackName || "<name>"}/docker-compose.yml`;
  const running = !!jobId && (!job || job.status === "running");
  const unchanged = editing && original !== null && content === original;

  return (
    <Dialog onClose={onClose} width={step === 0 ? 520 : 760}>
      <DialogHeader icon="layers" title={title} sub={sub} monoSub onClose={onClose} />
      {!editing && <Stepper steps={["Details", "Compose"]} current={jobId && job?.status === "success" ? 2 : step} />}

      {step === 0 && (
        <form onSubmit={next} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Stack name">
            <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. paperless" autoCapitalize="off" />
          </Field>
          <Group label="Deploy to">
            <HostChips hosts={hosts} selected={hostId ? [hostId] : []} onToggle={setHostId} />
          </Group>
          <Group label="Start from">
            {templates.data ? (
              <TemplateChips
                templates={templates.data}
                value={tpl}
                onPick={(t) => {
                  setTpl(t.id);
                  setContent(t.content);
                }}
              />
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <Skel w={80} h={34} r={11} />
                <Skel w={130} h={34} r={11} />
                <Skel w={100} h={34} r={11} />
              </div>
            )}
          </Group>
          {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
          <Actions style={{ marginTop: 4 }}>
            <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn">Continue to compose</button>
          </Actions>
        </form>
      )}

      {step === 1 && !jobId && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {editing && !existing.data ? (
            existing.error ? (
              <div style={{ padding: "12px 14px", borderRadius: 12, background: "var(--crit-bg)", color: "var(--crit-ink)", fontSize: 13 }}>Couldn&apos;t load the compose file: {errMsg(existing.error)}</div>
            ) : (
              <Skel h={320} r={16} />
            )
          ) : (
            <ComposeEditor value={content} onChange={setContent} errorLine={validation.status === "done" && !validation.result.ok ? validation.result.line : undefined} />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <ValidationLine state={validation} />
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Changed services are recreated; the rest keep running.</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {editing ? (
                <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
              ) : (
                <button type="button" className="btn2 lg" onClick={() => setStep(0)}>Back</button>
              )}
              <button type="button" className="btn" onClick={apply} disabled={busy || !isValid(validation) || unchanged}>
                {busy && <span className="spinner" />}
                {editing ? "Apply changes" : "Deploy stack"}
              </button>
            </div>
          </div>
        </div>
      )}

      {jobId && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))", gap: 14, alignItems: "start" }}>
          {job ? <ProgressList steps={job.steps} /> : <div style={{ fontSize: 13, color: "var(--ink-3)", padding: "9px 10px" }}>Queuing job…</div>}
          <LogBlock lines={job?.log.length ? job.log : [{ text: "Starting…", level: "muted" }]} running={running} style={{ minHeight: 220, maxHeight: 360 }} />
        </div>
      )}
      {jobId && !running && (
        <Actions>
          {job?.status === "failed" && (
            <button type="button" className="btn2 lg" onClick={() => setJobId(null)}>Back to editor</button>
          )}
          <button type="button" className="btn" autoFocus onClick={onClose}>Done</button>
        </Actions>
      )}
      {running && (
        <Actions>
          <span style={{ fontSize: 12, color: "var(--ink-3)", marginRight: "auto" }}>You can close this — the deploy keeps running.</span>
          <button type="button" className="btn2 lg" onClick={onClose}>Close</button>
        </Actions>
      )}
    </Dialog>
  );
}
