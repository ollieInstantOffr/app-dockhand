"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, HostTargets } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { ComposeEditor, STACK_NAME_RE, TemplateChips, ValidationLine, isValid, useComposeValidation, type ComposeTemplate } from "@/components/dialogs/ComposeEditor";
import { errMsg, post, useApi } from "@/lib/api";
import type { DeployIssue, Host, JobRef } from "@/lib/types";
import { BackButton, BigButton, DeployStepper, IssuesPanel, cardStyle, deployBtnLabel, useDeployCheck } from "./shared";

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
import { DeployProgress } from "./DeployProgress";

export function ComposeFlow({ initialHost }: { initialHost: string }) {
  const { toast } = useShell();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState(initialHost);
  const [tpl, setTpl] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<{ id: string; hostId: string; hostName: string } | null>(null);

  const hostsQ = useApi<Host[]>("/api/hosts");
  const hosts = useMemo(() => (hostsQ.data ?? []).filter((h) => h.status === "online" || h.status === "degraded"), [hostsQ.data]);
  const templates = useApi<ComposeTemplate[]>("/api/compose/templates");
  const validation = useComposeValidation(content, step === 1);

  useEffect(() => {
    if (hosts.length && !hosts.some((h) => h.id === hostId)) setHostId(hosts[0].id);
  }, [hosts, hostId]);
  useEffect(() => {
    const first = templates.data?.[0];
    if (first && !tpl) {
      setTpl(first.id);
      setContent(first.content);
    }
  }, [templates.data, tpl]);

  const host = hosts.find((h) => h.id === hostId);
  const nameOk = STACK_NAME_RE.test(name.trim());

  const check = useDeployCheck(step === 1 && host && nameOk ? { kind: "compose", hostId: host.id, name: name.trim(), composeFile: content } : null);
  const canFix = (i: DeployIssue) => !!(i.fix?.patch.name || i.fix?.patch.ports?.length);
  const applyFix = (i: DeployIssue) => {
    const p = i.fix?.patch;
    if (!p) return;
    if (p.name) setName(p.name.toLowerCase());
    if (p.ports?.length) {
      // rewrite the published side of "8080:80" style mappings in the compose text
      setContent((cur) => p.ports!.reduce((txt, { from, to }) => txt.replace(new RegExp(`(^|[\\s"'\\-\\[,:])${escRe(from)}(?=:\\d)`, "gm"), `$1${to}`), cur));
    }
    toast({ kind: "ok", title: i.fix!.label, text: i.field });
  };

  const next = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!nameOk) return toast({ kind: "warn", title: "Give the stack a name", text: "Lowercase letters, digits, “-” and “_”." });
    if (!host) return toast({ kind: "warn", title: "Pick a host to deploy to" });
    setStep(1);
  };

  const deploy = async () => {
    if (!host) return;
    setBusy(true);
    try {
      const r = await post<JobRef>(`/api/hosts/${host.id}/stacks`, { name: name.trim(), content });
      setJob({ id: r.jobId, hostId: host.id, hostName: host.name });
      setStep(2);
    } catch (e) {
      toast({ kind: "error", title: "Couldn't deploy the stack", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DeployStepper current={step} />
      {step === 0 && (
        <Card style={{ ...cardStyle, gap: 16, maxWidth: 720, animation: "rise .3s ease both" }}>
          <form onSubmit={next} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>New stack</span>
            <label className="field">
              Stack name
              <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="e.g. paperless" />
              <span className="field-hint">Written to /opt/dockhand/stacks/{name.trim() || "<name>"}/docker-compose.yml</span>
            </label>
            <div className="field" style={{ gap: 8 }}>
              Deploy to
              {hostsQ.data && !hosts.length ? <span className="field-hint">No online hosts — add or reconnect a host first.</span> : <div className="dh-targets"><HostTargets hosts={hosts} value={hostId} onChange={setHostId} /></div>}
            </div>
            <div className="field">
              Start from
              <TemplateChips
                templates={templates.data ?? []}
                value={tpl}
                onPick={(t) => {
                  setTpl(t.id);
                  setContent(t.content);
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="btn">Continue to compose</button>
            </div>
          </form>
        </Card>
      )}
      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, animation: "rise .3s ease both" }}>
          <Card style={{ ...cardStyle, gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <BackButton onClick={() => setStep(0)} />
              <span className="mono ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}>→ {host?.name}</span>
            </div>
            <ComposeEditor value={content} onChange={setContent} errorLine={validation.status === "done" && !validation.result.ok ? validation.result.line : undefined} maxHeight={520} minHeight={320} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <ValidationLine state={validation} />
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Runs <span className="mono">docker compose up -d</span> on {host?.name}.</span>
            </div>
          </Card>
          <div style={{ maxWidth: 420, width: "100%", alignSelf: "flex-end", display: "flex", flexDirection: "column", gap: 12 }}>
            <IssuesPanel issues={check.issues} crit={check.crit} warn={check.warn} canFix={canFix} onFix={applyFix} />
            <BigButton onClick={deploy} busy={busy} disabled={!isValid(validation)} blocked={check.crit > 0}>
              {deployBtnLabel(check.crit, check.warn, host?.name)}
            </BigButton>
          </div>
        </div>
      )}
      {step === 2 && job && (
        <DeployProgress
          jobId={job.id}
          name={name.trim()}
          hostId={job.hostId}
          hostName={job.hostName}
          target="stack"
          onBack={() => setStep(1)}
          onAnother={() => {
            setJob(null);
            setName("");
            setStep(0);
          }}
        />
      )}
    </>
  );
}
