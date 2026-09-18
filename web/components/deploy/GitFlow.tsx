"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Dropdown, EmptyState, HostTargets, Skel, Toggle } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { errMsg, post, useApi } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Branch, DeployCheckInput, DeployIssue, DryRunResult, GitAccount, GitDeployInput, Host, JobRef, KV, Repo, RepoInspect } from "@/lib/types";
import { BackButton, BigButton, DeployStepper, DryRunButton, EnvImport, IssuesPanel, cardStyle, deployBtnLabel, mergeKV, useDeployCheck } from "./shared";
import { DeployProgress } from "./DeployProgress";

type EnvRow = { k: string; v: string; required: boolean; comment: string };

export function GitFlow({ initialHost }: { initialHost: string }) {
  const [step, setStep] = useState(0);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [job, setJob] = useState<{ id: string; name: string; hostId: string; hostName: string } | null>(null);

  return (
    <>
      <DeployStepper current={step} />
      {step === 0 && (
        <RepoPicker
          onPick={(r) => {
            setRepo(r);
            setStep(1);
          }}
        />
      )}
      {step === 1 && repo && (
        <GitConfigure
          key={repo.fullName}
          repo={repo}
          initialHost={initialHost}
          onBack={() => setStep(0)}
          onStarted={(j) => {
            setJob(j);
            setStep(2);
          }}
        />
      )}
      {step === 2 && job && (
        <DeployProgress
          jobId={job.id}
          name={job.name}
          hostId={job.hostId}
          hostName={job.hostName}
          target="stack"
          onBack={() => setStep(1)}
          onAnother={() => {
            setJob(null);
            setRepo(null);
            setStep(0);
          }}
        />
      )}
    </>
  );
}

// ─── Step 1: pick a repo ───────────────────────────────────────────────────

function RepoPicker({ onPick }: { onPick: (r: Repo) => void }) {
  const { openDialog } = useShell();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [compose, setCompose] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const accounts = useApi<GitAccount[]>("/api/github/accounts");
  const hasAccount = (accounts.data?.length ?? 0) > 0;
  const repos = useApi<Repo[]>(hasAccount ? `/api/github/repos?compose=${compose ? 1 : 0}&q=${encodeURIComponent(dq)}` : null);

  const total = accounts.data?.reduce((n, a) => n + a.repoCount, 0) ?? 0;
  const withCompose = accounts.data?.reduce((n, a) => n + a.composeRepoCount, 0) ?? 0;
  const loading = accounts.isLoading || (hasAccount && !repos.data && !repos.error);

  if (accounts.data && !hasAccount) {
    return (
      <EmptyState icon="branch" title="No GitHub account connected" text="Connect an account and Dockhand will list every repo that has a compose file, ready to deploy onto any host.">
        <button type="button" className="btn" onClick={() => openDialog({ type: "github" })}>Connect GitHub</button>
      </EmptyState>
    );
  }

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search repositories…" style={{ height: 40, padding: "0 14px", borderRadius: 12, border: "1px solid transparent", background: "var(--fill-1)", fontSize: 13.5, width: 300, maxWidth: "100%" }} />
        <div style={{ display: "flex", padding: 3, borderRadius: 12, background: "var(--fill-1)", border: "1px solid transparent", gap: 2, fontSize: 12.5, fontWeight: 600 }}>
          {[
            { v: true, label: "With compose" },
            { v: false, label: "All repos" },
          ].map((o) => (
            <button key={o.label} type="button" className="dh-filt" onClick={() => setCompose(o.v)} style={{ height: 30, padding: "0 12px", border: 0, borderRadius: 9, background: compose === o.v ? "var(--surface)" : "transparent", boxShadow: compose === o.v ? "0 2px 8px rgba(30,40,70,.12)" : "none", color: compose === o.v ? "var(--ink)" : "var(--ink-2)", cursor: "pointer", fontWeight: 600, fontSize: 12.5 }}>
              {o.label}
            </button>
          ))}
        </div>
        {accounts.data && (
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-3)" }}>
            {total} repos · {withCompose} with compose
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,320px),1fr))", gap: 14 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} style={{ borderRadius: 20, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <Skel w={34} h={34} r={10} style={{ flex: "none" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <Skel w="50%" h={14} />
                  <Skel w="70%" h={10} />
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Skel w={110} h={22} />
                <Skel w={90} h={22} />
              </div>
              <Skel h={11} />
            </Card>
          ))}
        </div>
      ) : repos.error ? (
        <EmptyState icon="alert" title="Couldn't load repositories" text={errMsg(repos.error)}>
          <button type="button" className="btn2" onClick={() => repos.mutate()}>Retry</button>
        </EmptyState>
      ) : (repos.data?.length ?? 0) === 0 ? (
        <EmptyState icon="search" title={dq ? `No repos match “${dq}”` : compose ? "No repos with a compose file" : "No repositories"} text={compose ? "Only repos with a docker-compose.yml (or compose.yaml) are shown. Switch to All repos to see everything." : "Check which repositories this account grants Dockhand access to."}>
          {compose && <button type="button" className="btn2" onClick={() => setCompose(false)}>Show all repos</button>}
        </EmptyState>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,320px),1fr))", gap: 14 }}>
          {repos.data!.map((r) => (
            <button key={`${r.accountId}/${r.fullName}`} type="button" className="dh-lift" onClick={() => onPick(r)} style={{ textAlign: "left", border: 0, borderRadius: 20, background: "var(--surface)", boxShadow: "var(--card-shadow)", padding: "16px 18px", cursor: "pointer", color: "var(--ink)", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: "var(--fill-1)", display: "grid", placeItems: "center", flex: "none", color: "var(--ink-2)" }}>
                  <Icon name={r.private ? "lock" : "branch"} size={17} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                  <span className="ellipsis" style={{ fontSize: 14.5, fontWeight: 700 }}>{r.name}</span>
                  <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {r.owner} · {r.private ? "private" : "public"} · updated {ago(r.pushedAt)}
                  </span>
                </span>
                {r.deployedOn && <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 8, background: "rgba(34,160,107,.12)", color: "var(--ok-ink)", whiteSpace: "nowrap" }}>on {r.deployedOn}</span>}
              </div>
              {r.composeFiles.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {r.composeFiles.map((f) => (
                    <span key={f} className="mono" style={{ fontSize: 11, padding: "4px 8px", borderRadius: 8, background: "rgba(47,111,237,.08)", color: "#2f6fed" }}>{f}</span>
                  ))}
                </div>
              )}
              <span style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{r.description || "No description"}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Step 2: configure ─────────────────────────────────────────────────────

function GitConfigure({ repo, initialHost, onBack, onStarted }: { repo: Repo; initialHost: string; onBack: () => void; onStarted: (j: { id: string; name: string; hostId: string; hostName: string }) => void }) {
  const { toast } = useShell();
  const base = `/api/github/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const [branch, setBranch] = useState(repo.defaultBranch);
  const [file, setFile] = useState(repo.composeFiles[0] ?? "");
  const [hostId, setHostId] = useState(initialHost);
  const [path, setPath] = useState(`/opt/dockhand/stacks/${repo.name}`);
  const [auto, setAuto] = useState(true);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const branches = useApi<Branch[]>(`${base}/branches`);
  const inspect = useApi<RepoInspect>(`${base}/inspect?ref=${encodeURIComponent(branch)}&file=${encodeURIComponent(file)}`);
  const hostsQ = useApi<Host[]>("/api/hosts");
  const hosts = useMemo(() => (hostsQ.data ?? []).filter((h) => h.status === "online" || h.status === "degraded"), [hostsQ.data]);

  useEffect(() => {
    if (!hosts.length) return;
    if (!hosts.some((h) => h.id === hostId)) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  // compose file list comes from inspect when the repo summary had none
  useEffect(() => {
    if (!file && inspect.data?.composeFiles.length) setFile(inspect.data.composeFiles[0]);
  }, [inspect.data, file]);

  // (re)seed env rows from .env.example, keeping values the user already typed
  useEffect(() => {
    if (!inspect.data) return;
    setEnv((cur) => {
      const typed = new Map(cur.map((e) => [e.k, e.v]));
      const seeded = inspect.data!.env.map((e) => ({ ...e, v: typed.get(e.k) ?? e.v }));
      const extra = cur.filter((e) => !inspect.data!.env.some((x) => x.k === e.k));
      return [...seeded, ...extra];
    });
  }, [inspect.data]);

  const host = hosts.find((h) => h.id === hostId);
  const files = Array.from(new Set([...(inspect.data?.composeFiles ?? []), ...repo.composeFiles, ...(file ? [file] : [])]));
  const missing = env.filter((e) => e.required && !e.v.trim());

  const mergeEnv = (vars: KV[]) => setEnv((cur) => mergeKV(cur, vars, (e) => e.k, (e, kv) => (e ? { ...e, v: kv.v } : { k: kv.k, v: kv.v, required: false, comment: "" })));
  const merge = (vars: KV[]) => {
    mergeEnv(vars);
    toast({ kind: "ok", title: `Imported ${vars.length} variable${vars.length === 1 ? "" : "s"}` });
  };

  const cleanEnv = env.filter((e) => e.k.trim()).map((e) => ({ k: e.k, v: e.v }));
  const input = (): GitDeployInput => ({ accountId: repo.accountId, owner: repo.owner, name: repo.name, branch, composeFile: file, hostId: host?.id ?? "", path: path.trim(), env: cleanEnv, autoDeploy: auto });

  // Stack name on the host = last segment of the clone path.
  const stackName = path.trim().replace(/\/+$/, "").split("/").pop() || repo.name;
  const checkInput: DeployCheckInput | null = host && file
    ? { kind: "git", hostId: host.id, name: stackName, path: path.trim(), env: cleanEnv, requiredEnv: env.filter((e) => e.required).map((e) => e.k) }
    : null;
  const check = useDeployCheck(checkInput);
  const canFix = (i: DeployIssue) => !!(i.fix?.patch.name || i.fix?.patch.path || i.fix?.patch.env?.length);
  const applyFix = (i: DeployIssue) => {
    const p = i.fix?.patch;
    if (!p) return;
    if (p.path) setPath(p.path);
    else if (p.name) setPath((cur) => `${cur.trim().replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/opt/dockhand/stacks"}/${p.name}`);
    if (p.env?.length) mergeEnv(p.env);
    toast({ kind: "ok", title: i.fix!.label, text: i.field });
  };

  const deploy = async () => {
    if (!host) return toast({ kind: "warn", title: "Pick a host to deploy to" });
    if (!file) return toast({ kind: "warn", title: "This repo has no compose file selected" });
    if (missing.length) return toast({ kind: "warn", title: "Fill in the required variables", text: missing.map((m) => m.k).join(", ") });
    setBusy(true);
    try {
      const r = await post<JobRef>("/api/deploy/git", input());
      onStarted({ id: r.jobId, name: repo.name, hostId: host.id, hostName: host.name });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't start the deploy", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))", gap: 18, alignItems: "start", animation: "rise .3s ease both" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <Card style={{ ...cardStyle, gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <BackButton onClick={onBack} />
            <span className="ellipsis" style={{ fontSize: 16, fontWeight: 700 }}>{repo.owner}/{repo.name}</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}>updated {ago(repo.pushedAt)}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
            <div className="field">
              Branch
              <Dropdown
                value={branch}
                icon={<span style={{ display: "flex", color: "var(--ink-3)" }}><Icon name="branch" size={15} /></span>}
                options={(branches.data ?? [{ name: repo.defaultBranch, sha: "", updatedAt: null, isDefault: true }]).map((b) => ({ value: b.name, label: b.name, sub: b.isDefault ? "default" : b.updatedAt ? ago(b.updatedAt) : undefined }))}
                onChange={setBranch}
              />
            </div>
            <div className="field">
              Compose file
              <Dropdown value={file} placeholder="No compose file" icon={<span style={{ display: "flex", color: "var(--ink-3)" }}><Icon name="logs" size={15} /></span>} options={files.map((f) => ({ value: f, label: f }))} onChange={setFile} />
            </div>
          </div>
          <div className="field" style={{ gap: 8 }}>
            Deploy to
            {hostsQ.data && !hosts.length ? <span className="field-hint">No online hosts — add or reconnect a host first.</span> : <div className="dh-targets"><HostTargets hosts={hosts} value={hostId} onChange={setHostId} /></div>}
          </div>
          <label className="field">
            Clone path on host
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
        </Card>

        <Card style={{ ...cardStyle, gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700 }}>Environment</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>from .env.example — fill in the blanks</span>
            <button type="button" className="btn2 sm" style={{ marginLeft: "auto" }} onClick={() => setImporting((v) => !v)}>Import .env</button>
          </div>
          {importing && <EnvImport onMerge={merge} onClose={() => setImporting(false)} />}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {!inspect.data && !inspect.error &&
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(140px,.8fr) minmax(0,1.4fr)", gap: 8 }}>
                  <Skel h={36} r={10} />
                  <Skel h={36} r={10} />
                </div>
              ))}
            {inspect.error && <span style={{ fontSize: 12.5, color: "var(--crit-ink)" }}>Couldn't read the repo: {errMsg(inspect.error)}</span>}
            {inspect.data && env.length === 0 && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No .env.example found — nothing to fill in. Use Import .env to add variables.</span>}
            {env.map((e, i) => (
              <div key={e.k + i} style={{ display: "grid", gridTemplateColumns: "minmax(140px,.8fr) minmax(0,1.4fr)", gap: 8, alignItems: "center" }} title={e.comment || undefined}>
                <span className="mono ellipsis" style={{ fontSize: 12, fontWeight: 500, padding: "0 12px", height: 36, display: "flex", alignItems: "center", borderRadius: 10, background: "var(--fill-1)" }}>
                  {e.k}
                  {e.required && <span style={{ color: "var(--crit-ink)", marginLeft: 2 }}>*</span>}
                </span>
                <input
                  className="input mono sm"
                  value={e.v}
                  placeholder={e.comment || (e.required ? "required" : "")}
                  onChange={(ev) => setEnv((cur) => cur.map((x, j) => (j === i ? { ...x, v: ev.target.value } : x)))}
                  style={{ borderColor: e.required && !e.v.trim() ? "rgba(226,80,76,.45)" : "var(--line-2)" }}
                />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="dh-sticky" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Card style={{ ...cardStyle, gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>What will be created</span>
          {!inspect.data && !inspect.error && [0, 1, 2].map((i) => <Skel key={i} h={50} r={12} />)}
          {inspect.data?.services.length === 0 && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No services found in {file || "the compose file"}.</span>}
          {inspect.data?.services.map((v) => (
            <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, background: "var(--fill-1)", border: "1px solid transparent" }}>
              <span className="dot" style={{ width: 7, height: 7, background: "var(--muted)" }} />
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{v.name}</span>
                <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{v.image || "built from source"}</span>
              </span>
              <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{v.meta}</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, background: "rgba(47,111,237,.06)", border: "1px solid rgba(47,111,237,.25)", fontSize: 12.5, color: "var(--ink-4)", lineHeight: 1.45 }}>
            <Icon name="restart" size={15} color="#2f6fed" />
            <span>
              Auto-redeploy when <strong>{branch}</strong> changes
            </span>
            <span style={{ marginLeft: "auto" }}>
              <Toggle on={auto} onChange={setAuto} />
            </span>
          </div>
        </Card>
        <IssuesPanel issues={check.issues} crit={check.crit} warn={check.warn} canFix={canFix} onFix={applyFix} />
        <BigButton onClick={deploy} busy={busy} disabled={!host || !file} blocked={check.crit > 0}>
          {deployBtnLabel(check.crit, check.warn, host?.name)}
        </BigButton>
        <DryRunButton
          label="Dry run · compose config"
          title="Dry run"
          sub={`${repo.owner}/${repo.name}@${branch} · ${file || "compose"}`}
          disabled={!host || !file}
          run={() => post<DryRunResult>("/api/deploy/git/dry-run", input())}
        />
        <span style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>Clones with a read-only deploy key · nothing is pushed back</span>
      </div>
    </div>
  );
}
