"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, HostTargets, Seg, Toggle, useOutside } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { errMsg, post, useApi } from "@/lib/api";
import { AVATAR_COLORS, bytes } from "@/lib/format";
import type { Container, DeployCheckInput, DeployIssue, DryRunResult, Host, JobRef, KV, Network, RegistryInfo, RegistryRepo, RunContainerInput, Settings } from "@/lib/types";
import { BackButton, BigButton, ChipButton, DeployStepper, DryRunButton, EnvImport, IssuesPanel, PairRows, SummaryRow, cardStyle, deployBtnLabel, hashColor, mergeKV, useDeployCheck, type Pair } from "./shared";
import { DeployProgress } from "./DeployProgress";

// ─── Image name helpers ────────────────────────────────────────────────────

/** Split "ghcr.io/org/app:tag" → ["ghcr.io", "org/app:tag"]. */
export function splitRegistry(img: string): [string, string] {
  const i = img.indexOf("/");
  if (i > 0) {
    const first = img.slice(0, i);
    if (first.includes(".") || first.includes(":") || first === "localhost") return [first, img.slice(i + 1)];
  }
  return ["", img];
}

function hasTag(img: string) {
  const last = img.split("/").pop() ?? "";
  return last.includes(":") || img.includes("@");
}

export function withTag(img: string) {
  const s = img.trim();
  return !s || hasTag(s) ? s : `${s}:latest`;
}

function repoOf(img: string) {
  const s = img.split("@")[0];
  const last = s.lastIndexOf(":");
  return last > s.lastIndexOf("/") ? s.slice(0, last) : s;
}

function defaultName(img: string) {
  const base = (repoOf(img).split("/").pop() ?? "app").toLowerCase();
  return base.replace(/[^a-z0-9_.-]/g, "-") || "app";
}

const REGISTRIES = [
  { id: "hub", label: "Docker Hub", prefix: "" },
  { id: "ghcr", label: "GHCR", prefix: "ghcr.io" },
  { id: "quay", label: "Quay", prefix: "quay.io" },
  { id: "custom", label: "Custom…", prefix: "registry.example.com" },
] as const;

const PRESETS: { name: string; image: string; color: string }[] = [
  { name: "nginx", image: "nginx:1.27-alpine", color: "#22a06b" },
  { name: "PostgreSQL", image: "postgres:16-alpine", color: "#2f6fed" },
  { name: "Redis", image: "redis:7-alpine", color: "#e2504c" },
  { name: "Traefik", image: "traefik:v3.1", color: "#14b8c4" },
  { name: "Grafana", image: "grafana/grafana:latest", color: "#e0a020" },
  { name: "Prometheus", image: "prom/prometheus:latest", color: "#d9468f" },
  { name: "Uptime Kuma", image: "louislam/uptime-kuma:1", color: "#7a5cf0" },
  { name: "Vaultwarden", image: "vaultwarden/server:latest", color: "#5f6675" },
];

type Job = { id: string; name: string; hostId: string; hostName: string };

export function ImageFlow({ initialHost, initialImage = "" }: { initialHost: string; initialImage?: string }) {
  // ?image=… (e.g. "Deploy" on a registry tag) skips straight to configuring it.
  const [step, setStep] = useState(initialImage ? 1 : 0);
  const [image, setImage] = useState(initialImage);
  const [job, setJob] = useState<Job | null>(null);
  return (
    <>
      <DeployStepper current={step} />
      {step === 0 && (
        <ImagePicker
          value={image}
          onChange={setImage}
          onNext={(img) => {
            setImage(img);
            setStep(1);
          }}
        />
      )}
      {step === 1 && (
        <ImageConfigure
          key={image}
          image={withTag(image)}
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
          target="container"
          onBack={() => setStep(1)}
          onAnother={() => {
            setJob(null);
            setImage("");
            setStep(0);
          }}
        />
      )}
    </>
  );
}

// ─── Step 1 ────────────────────────────────────────────────────────────────

type HubHit = { name: string; description: string; stars: number; pulls: number; official: boolean; private?: boolean };

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function ImagePicker({ value, onChange, onNext }: { value: string; onChange: (v: string) => void; onNext: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const containers = useApi<Container[]>("/api/containers");
  const settings = useApi<Settings>("/api/settings");
  const regOn = !!settings.data?.registry?.enabled;
  const regInfo = useApi<RegistryInfo>(regOn ? "/api/registry" : null, { revalidateOnFocus: false });
  const regRepos = useApi<RegistryRepo[]>(regOn && regInfo.data?.reachable ? "/api/registry/repos" : null, { revalidateOnFocus: false });
  const regAddr = regInfo.data?.address ?? "";
  const registries = regAddr ? [{ id: "dockhand" as const, label: "Dockhand", prefix: regAddr }, ...REGISTRIES] : REGISTRIES;

  // Docker Hub search: plain terms without a registry host or tag ("postgres", "grafana/graf").
  const term = value.trim();
  const searchable = term.length >= 2 && !/[:@]/.test(term) && !splitRegistry(term)[0];
  const [dq, setDq] = useState("");
  const [menu, setMenu] = useState(false);
  const [hi, setHi] = useState(-1);
  useEffect(() => {
    const t = setTimeout(() => setDq(searchable ? term : ""), 300);
    return () => clearTimeout(t);
  }, [term, searchable]);
  const hub = useApi<HubHit[]>(dq ? `/api/images/search?q=${encodeURIComponent(dq)}` : null, { revalidateOnFocus: false, keepPreviousData: false });
  const hits = searchable && dq === term ? (hub.data ?? []) : [];
  const searching = searchable && (dq !== term || (!hub.data && !hub.error));
  const showMenu = menu && searchable && (searching || hits.length > 0 || !!hub.data);
  useOutside(wrap, () => setMenu(false), menu);
  useEffect(() => setHi(-1), [dq]);
  const [reg, rest] = splitRegistry(value.trim());
  const active = reg === "" ? "hub" : regAddr && reg === regAddr ? "dockhand" : reg === "ghcr.io" ? "ghcr" : reg === "quay.io" ? "quay" : "custom";

  const presets = useMemo(() => {
    const counts = new Map<string, { image: string; n: number }>();
    for (const c of containers.data ?? []) {
      const repo = repoOf(c.image);
      if (!repo || c.image.startsWith("sha256:")) continue;
      const cur = counts.get(repo);
      counts.set(repo, { image: cur?.image ?? c.image, n: (cur?.n ?? 0) + 1 });
    }
    const staticRepos = new Set(PRESETS.map((p) => repoOf(p.image)));
    const used = Array.from(counts.entries())
      .filter(([repo]) => !staticRepos.has(repo))
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 4)
      .map(([repo, v]) => ({ name: repo.split("/").pop() ?? repo, image: v.image, color: hashColor(repo, AVATAR_COLORS) }));
    const popularStatic = [...PRESETS].sort((a, b) => (counts.get(repoOf(b.image))?.n ?? 0) - (counts.get(repoOf(a.image))?.n ?? 0));
    return [...used, ...popularStatic];
  }, [containers.data]);

  const pickRegistry = (id: (typeof registries)[number]["id"]) => {
    const r = registries.find((x) => x.id === id)!;
    const next = r.prefix ? `${r.prefix}/${rest}` : rest;
    onChange(next);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      if (id === "custom") el.setSelectionRange(0, r.prefix.length);
      else el.setSelectionRange(next.length, next.length);
    });
  };

  return (
    <>
      <Card style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Image</span>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (showMenu && hi >= 0 && hits[hi]) return onNext(hits[hi].name);
            if (value.trim()) onNext(value.trim());
          }}
        >
          <div ref={wrap} className="input-wrap">
            <span className="input-icon"><Icon name="search" size={16} /></span>
            <input
              ref={input}
              autoFocus
              className="input mono with-icon"
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                setMenu(true);
              }}
              onFocus={() => setMenu(true)}
              onKeyDown={(e) => {
                if (!showMenu || !hits.length) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHi((h) => (h + 1) % hits.length);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => (h <= 0 ? hits.length - 1 : h - 1));
                } else if (e.key === "Escape") {
                  setMenu(false);
                }
              }}
              placeholder="nginx:1.27, ghcr.io/org/app:tag, or search Docker Hub…"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={showMenu}
              style={{ height: 46, fontSize: 13.5 }}
            />
            {showMenu && (
              <div className="menu" role="listbox" style={{ left: 0, right: 0, top: 52, maxHeight: 360, overflow: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px 4px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-3)" }}>
                  {hits.some((h) => h.private) ? "Your registry & Docker Hub" : "Docker Hub"}
                  {searching && <span className="spinner" style={{ width: 10, height: 10, marginLeft: "auto" }} />}
                </div>
                {!searching && !hits.length && <div style={{ padding: "8px 10px", fontSize: 12.5, color: "var(--ink-3)" }}>No images match “{term}” — press Enter to use it as typed.</div>}
                {hits.map((h, i) => (
                  <button
                    key={h.name}
                    type="button"
                    role="option"
                    aria-selected={i === hi}
                    className={`menu-item ${i === hi ? "active" : ""}`}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => onNext(h.name)}
                    style={{ height: "auto", minHeight: 44, padding: "7px 10px", alignItems: "center", flex: "none" }}
                  >
                    <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span className="mono ellipsis" style={{ fontSize: 12.5 }}>{h.name}</span>
                        {h.official && <span className="tag blue" style={{ fontSize: 9.5, padding: "1px 6px" }}>official</span>}
                        {h.private && <span className="tag ok" style={{ fontSize: 9.5, padding: "1px 6px" }}>your registry</span>}
                      </span>
                      {h.description && <span className="ellipsis" style={{ fontSize: 11.5, fontWeight: 400, color: "var(--ink-3)" }}>{h.description}</span>}
                    </span>
                    {!h.private && (
                      <span className="mono" style={{ fontSize: 10.5, fontWeight: 400, color: "var(--ink-3)", whiteSpace: "nowrap", textAlign: "right" }}>
                        ★ {compact(h.stars)}
                        <br />
                        {compact(h.pulls)} pulls
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Registry</span>
          {registries.map((r) => (
            <ChipButton key={r.id} on={active === r.id} onClick={() => pickRegistry(r.id)}>
              {r.label}
            </ChipButton>
          ))}
          {value.trim() && (
            <button type="button" className="btn xs" style={{ marginLeft: "auto" }} onClick={() => onNext(value.trim())}>
              Continue
              <Icon name="chevronRight" size={13} />
            </button>
          )}
        </div>
      </Card>
      {regAddr && (regRepos.data?.length ?? 0) > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>In your registry</span>
            <span style={{ flex: 1, height: 1, background: "var(--line-2)" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,220px),1fr))", gap: 12 }}>
            {regRepos.data!.slice(0, 8).map((r) => {
              const img = `${regAddr}/${r.name}:${r.latest || "latest"}`;
              return (
                <button key={r.name} type="button" className="dh-lift" onClick={() => onNext(img)} style={{ textAlign: "left", border: 0, borderRadius: 18, background: "var(--surface)", boxShadow: "var(--card-shadow)", padding: "14px 16px", cursor: "pointer", color: "var(--ink)", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 38, height: 38, borderRadius: 12, background: "var(--btn)", color: "var(--btn-ink)", display: "grid", placeItems: "center", flex: "none" }}>
                    <Icon name="layers" size={17} />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span className="ellipsis" style={{ fontSize: 14, fontWeight: 700 }}>{r.name.split("/").pop()}</span>
                    <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                      {r.name}:{r.latest} · {r.tags} tag{r.tags === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>Popular on your hosts</span>
        <span style={{ flex: 1, height: 1, background: "var(--line-2)" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,220px),1fr))", gap: 12 }}>
        {presets.map((p) => (
          <button key={p.image} type="button" className="dh-lift" onClick={() => onNext(p.image)} style={{ textAlign: "left", border: 0, borderRadius: 18, background: "var(--surface)", boxShadow: "var(--card-shadow)", padding: "14px 16px", cursor: "pointer", color: "var(--ink)", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 38, height: 38, borderRadius: 12, background: p.color, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 15, flex: "none" }}>{(p.name[0] ?? "?").toUpperCase()}</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span className="ellipsis" style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</span>
              <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{p.image}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// ─── Step 2 ────────────────────────────────────────────────────────────────

type Restart = RunContainerInput["restart"];

function shellQuote(s: string) {
  return /^[A-Za-z0-9_@%+=:,./-]*$/.test(s) && s !== "" ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function ImageConfigure({ image, initialHost, onBack, onStarted }: { image: string; initialHost: string; onBack: () => void; onStarted: (j: Job) => void }) {
  const { toast } = useShell();
  const [name, setName] = useState(defaultName(image));
  const [restart, setRestart] = useState<Restart>("unless-stopped");
  const [hostId, setHostId] = useState(initialHost);
  const [ports, setPorts] = useState<Pair[]>([]);
  const [vols, setVols] = useState<Pair[]>([]);
  const [env, setEnv] = useState<Pair[]>([]);
  const [network, setNetwork] = useState("bridge");
  const [traefik, setTraefik] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  const hostsQ = useApi<Host[]>("/api/hosts");
  const hosts = useMemo(() => (hostsQ.data ?? []).filter((h) => h.status === "online" || h.status === "degraded"), [hostsQ.data]);
  const inspect = useApi<{ size: number; exposedPorts: string[]; volumes: string[]; env: KV[] }>(`/api/images/inspect?image=${encodeURIComponent(image)}`);
  const nets = useApi<Network[]>(hostId ? `/api/hosts/${hostId}/networks` : null);
  const settings = useApi<Settings>("/api/settings");

  useEffect(() => {
    if (!hosts.length) return;
    if (!hosts.some((h) => h.id === hostId)) setHostId(hosts[0].id);
  }, [hosts, hostId]);

  useEffect(() => {
    if (!inspect.data || seeded.current) return;
    seeded.current = true;
    const d = inspect.data;
    setPorts((d.exposedPorts ?? []).map((p) => {
      const n = p.split("/")[0];
      return { a: n, b: p.endsWith("/udp") ? p : n };
    }));
    setVols((d.volumes ?? []).map((v) => ({ a: `${defaultName(image)}_${v.split("/").filter(Boolean).pop() ?? "data"}`, b: v })));
    setEnv((d.env ?? []).filter((e) => e.k !== "PATH").map((e) => ({ a: e.k, b: e.v })));
  }, [inspect.data, image]);

  const netOptions = useMemo(() => {
    const custom = (nets.data ?? []).filter((n) => !n.system && n.driver !== "null").map((n) => n.name);
    return Array.from(new Set(["bridge", "host", ...custom]));
  }, [nets.data]);
  useEffect(() => {
    if (nets.data && !netOptions.includes(network)) setNetwork("bridge");
  }, [nets.data, netOptions, network]);

  const host = hosts.find((h) => h.id === hostId);
  const domain = settings.data?.general.domain || "";
  const cleanPorts = ports.filter((p) => p.b.trim());
  const cleanVols = vols.filter((v) => v.a.trim() && v.b.trim());
  const cleanEnv = env.filter((e) => e.a.trim());
  const cname = name.trim() || defaultName(image);

  const cmd = useMemo(() => {
    const parts = ["docker run -d", `--name ${shellQuote(cname)}`];
    if (restart !== "no") parts.push(`--restart ${restart}`);
    if (network !== "host") for (const p of cleanPorts) parts.push(`-p ${p.a.trim() ? `${p.a.trim()}:` : ""}${p.b.trim()}`);
    for (const v of cleanVols) parts.push(`-v ${shellQuote(`${v.a.trim()}:${v.b.trim()}`)}`);
    for (const e of cleanEnv) parts.push(`-e ${shellQuote(`${e.a.trim()}=${e.b}`)}`);
    if (network !== "bridge") parts.push(`--network ${shellQuote(network)}`);
    if (traefik) {
      parts.push("-l traefik.enable=true");
      parts.push(`-l ${shellQuote(`traefik.http.routers.${cname}.rule=Host(\`${cname}.${domain || "<domain>"}\`)`)}`);
    }
    parts.push(shellQuote(image));
    return parts.join(" \\\n  ");
  }, [cname, restart, network, cleanPorts, cleanVols, cleanEnv, traefik, domain, image]);

  const setEnvVars = (vars: KV[]) => setEnv((cur) => mergeKV(cur.filter((e) => e.a.trim() || e.b.trim()), vars, (e) => e.a, (_, kv) => ({ a: kv.k, b: kv.v })));
  const mergeEnv = (vars: KV[]) => {
    setEnvVars(vars);
    toast({ kind: "ok", title: `Imported ${vars.length} variable${vars.length === 1 ? "" : "s"}` });
  };

  const portList = network === "host" ? [] : cleanPorts.map((p) => ({ host: p.a.trim(), container: p.b.trim() }));
  const envList = cleanEnv.map((e) => ({ k: e.a.trim(), v: e.b }));
  const body = (): RunContainerInput => ({
    hostId: host?.id ?? "",
    image,
    name: cname,
    restart,
    ports: portList,
    volumes: cleanVols.map((v) => ({ src: v.a.trim(), dst: v.b.trim() })),
    env: envList,
    network,
    traefik,
  });

  const checkInput: DeployCheckInput | null = host ? { kind: "image", hostId: host.id, name: cname, image, ports: portList, env: envList } : null;
  const check = useDeployCheck(checkInput);
  const canFix = (i: DeployIssue) => !!(i.fix?.patch.name || i.fix?.patch.ports?.length || i.fix?.patch.env?.length);
  const applyFix = (i: DeployIssue) => {
    const p = i.fix?.patch;
    if (!p) return;
    if (p.name) setName(p.name);
    if (p.ports?.length) setPorts((cur) => cur.map((r) => {
      const m = p.ports!.find((x) => x.from === r.a.trim());
      return m ? { ...r, a: m.to } : r;
    }));
    if (p.env?.length) setEnvVars(p.env);
    toast({ kind: "ok", title: i.fix!.label, text: i.field });
  };

  const run = async () => {
    if (!host) return toast({ kind: "warn", title: "Pick a host to run on" });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(cname)) return toast({ kind: "warn", title: "Invalid container name", text: "Use letters, digits, “_”, “.” and “-”." });
    setBusy(true);
    try {
      const r = await post<JobRef>("/api/containers/run", body());
      onStarted({ id: r.jobId, name: cname, hostId: host.id, hostName: host.name });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't start the container", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const portsSummary = network === "host" ? "host network" : cleanPorts.length ? cleanPorts.map((p) => (p.a.trim() ? `${p.a.trim()}→${p.b.trim()}` : `${p.b.trim()} (internal)`)).join(", ") : "none";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))", gap: 18, alignItems: "start", animation: "rise .3s ease both" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <Card style={{ ...cardStyle, gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <BackButton onClick={onBack} />
            <span className="mono ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>{image}</span>
            {inspect.data ? (
              inspect.data.size > 0 && <span className="tag ok">{bytes(inspect.data.size)}</span>
            ) : inspect.error ? (
              <span className="tag muted" title={errMsg(inspect.error)}>size unknown</span>
            ) : (
              <span className="tag muted">inspecting…</span>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
            <label className="field">
              Container name
              <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName(image)} />
            </label>
            <div className="field">
              Restart policy
              <Seg<Restart>
                value={restart}
                onChange={setRestart}
                options={[
                  { value: "unless-stopped", label: "Unless stopped" },
                  { value: "always", label: "Always" },
                  { value: "no", label: "Never" },
                ]}
                style={{ flexWrap: "nowrap" }}
              />
            </div>
          </div>
          <div className="field" style={{ gap: 8 }}>
            Deploy to
            {hostsQ.data && !hosts.length ? <span className="field-hint">No online hosts — add or reconnect a host first.</span> : <div className="dh-targets"><HostTargets hosts={hosts} value={hostId} onChange={setHostId} /></div>}
          </div>
        </Card>

        <Card style={{ ...cardStyle, gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Ports</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{network === "host" ? "ignored on the host network" : "host → container"}</span>
            </div>
            <PairRows rows={ports} onChange={setPorts} sep="→" phA="8080" phB="80" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Volumes</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>host path or volume → container path</span>
            </div>
            <PairRows rows={vols} onChange={setVols} sep="→" phA="/opt/data/app" phB="/data" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Environment</span>
              <button type="button" className="btn2 sm" style={{ marginLeft: "auto" }} onClick={() => setImporting((v) => !v)}>Paste .env</button>
            </div>
            {importing && <EnvImport onMerge={mergeEnv} onClose={() => setImporting(false)} />}
            <PairRows rows={env} onChange={setEnv} sep="=" phA="KEY" phB="value" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Network</span>
            <div className="seg" style={{ flexWrap: "wrap" }}>
              {netOptions.map((n) => (
                <button key={n} type="button" className={n === network ? "on" : ""} onClick={() => setNetwork(n)} style={{ height: 30, fontSize: 12, fontFamily: "var(--mono)", flex: "none" }}>
                  {n}
                </button>
              ))}
            </div>
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--ink-4)" }}>
              Expose via Traefik <Toggle on={traefik} onChange={setTraefik} />
            </span>
          </div>
        </Card>
      </div>

      <div className="dh-sticky" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Card style={{ ...cardStyle, gap: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Summary</span>
          <div>
            <SummaryRow k="Image" v={image} />
            <SummaryRow k="Container" v={cname} />
            <SummaryRow k="Host" v={host?.name ?? "—"} />
            <SummaryRow k="Restart" v={restart} />
            <SummaryRow k="Ports" v={portsSummary} />
            <SummaryRow k="Volumes" v={cleanVols.length ? cleanVols.map((v) => v.b.trim()).join(", ") : "none"} />
            <SummaryRow k="Network" v={network} />
            {traefik && <SummaryRow k="URL" v={`https://${cname}.${domain || "<domain>"}`} />}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Equivalent command</span>
            <code style={{ fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.6, color: "var(--ink-4)", background: "var(--fill-1)", padding: "10px 12px", borderRadius: 10, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{cmd}</code>
          </div>
        </Card>
        <IssuesPanel issues={check.issues} crit={check.crit} warn={check.warn} canFix={canFix} onFix={applyFix} />
        <BigButton onClick={run} busy={busy} disabled={!host} blocked={check.crit > 0}>
          {deployBtnLabel(check.crit, check.warn, host?.name)}
        </BigButton>
        <DryRunButton label="Dry run · preview config" title="Dry run" sub={`${cname} · ${image}`} disabled={!host} run={() => post<DryRunResult>("/api/containers/run/dry-run", body())} />
      </div>
    </div>
  );
}
