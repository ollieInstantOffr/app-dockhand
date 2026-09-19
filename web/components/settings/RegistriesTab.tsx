"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { Seg, Toggle, copyText } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { trackJob } from "@/components/host/jobs";
import { del, errMsg, invalidate, post, useApi } from "@/lib/api";
import { C, ago, bytes, plural } from "@/lib/format";
import type { JobRef, RegistryCredential, RegistryInfo, RegistryRepo, RegistryTag, RegistryToken } from "@/lib/types";
import { Field, InkButton, InkHead, PILL, StatusPill, cardStyle, colStack, rowStyle, twoCol, useSettings } from "./common";

// Settings → Registries: Dockhand's built-in registry (push/pull at /v2/ on
// Dockhand's own port) and saved logins for every other registry.

export function RegistriesTab() {
  return (
    <div style={twoCol(420)}>
      <div style={colStack}>
        <RegistryCard />
        <ReposCard />
      </div>
      <div style={colStack}>
        <TokensCard />
        <CredentialsCard />
      </div>
    </div>
  );
}

function CopyBlock({ text, label = "Copied" }: { text: string; label?: string }) {
  const shell = useShell();
  return (
    <div style={{ position: "relative" }}>
      <code className="term-block" style={{ display: "block", paddingRight: 70, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{text}</code>
      <button
        type="button"
        onClick={() => copyText(text).then(() => shell.toast({ kind: "ok", title: label }))}
        style={{ position: "absolute", top: 10, right: 10, height: 26, padding: "0 10px", borderRadius: 8, border: 0, background: "rgba(255,255,255,.12)", color: "#fff", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}
      >
        Copy
      </button>
    </div>
  );
}

// ─── Built-in registry ─────────────────────────────────────────────────────

function RegistryCard() {
  const { settings, save } = useSettings();
  const on = !!settings?.registry?.enabled;
  const { data: info } = useApi<RegistryInfo>("/api/registry", { refresh: on ? 30000 : 0 });
  const [addr, setAddr] = useState<string | null>(null);
  const [how, setHow] = useState<"push" | "trust">("push");
  const address = info?.address || "dockhand.lan:5773";
  const addrVal = addr ?? settings?.registry?.address ?? "";

  const toggle = async (v: boolean) => {
    if (await save({ registry: { enabled: v } })) invalidate("/api/registry");
  };

  return (
    <div className="glass-card" style={cardStyle(16)}>
      <InkHead icon="layers" title="Dockhand registry" sub="Push your own images to Dockhand and deploy them to any host.">
        <Toggle on={on} disabled={!settings} onChange={toggle} title={on ? "Turn the registry off" : "Turn the registry on"} />
      </InkHead>
      {!settings && <span className="skel" style={{ height: 46, borderRadius: 14 }} />}
      {settings && !on && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
          Off. Turn it on to use Dockhand as a private Docker registry: <span className="mono">docker push</span> images to it with your Dockhand login or an access token, and every host pulls them without any extra setup.
        </p>
      )}
      {settings && on && (
        <>
          {info && !info.reachable ? (
            <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", fontSize: 12.5, color: "var(--crit-ink)", lineHeight: 1.5 }}>
              {info.error ?? "The registry service isn't answering."} Run <span className="mono">docker compose up -d</span> in Dockhand&apos;s folder to start it.
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 14, background: "rgba(34,160,107,.08)", border: "1px solid rgba(34,160,107,.25)", fontSize: 13, color: "var(--ok-ink)", flexWrap: "wrap" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.ok, boxShadow: "0 0 0 4px rgba(34,160,107,.18)", flex: "none" }} />
              <span style={{ fontWeight: 600 }}>Serving</span>
              <span className="mono ellipsis" style={{ fontSize: 12, color: "var(--ink-4)" }}>{info?.address ?? "…"}</span>
              <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
                {info ? `${plural(info.repos, "repository", "repositories")}${info.size >= 0 ? ` · ${bytes(info.size)}` : ""}` : ""}
              </span>
            </div>
          )}
          <Field label="Registry address" hint="The name you tag images with. Leave empty to use the host and port of Dockhand's public URL.">
            <input
              className="input mono"
              value={addrVal}
              placeholder={info?.address || "dockhand.lan:5773"}
              onChange={(e) => setAddr(e.target.value)}
              onBlur={async () => {
                if (addr == null || addr === (settings.registry?.address ?? "")) return;
                if (await save({ registry: { address: addr.trim() } })) {
                  setAddr(null);
                  invalidate("/api/registry");
                }
              }}
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <Seg<"push" | "trust"> fit value={how} onChange={setHow} options={[{ value: "push", label: "Push an image" }, { value: "trust", label: info?.secure ? "Hosts" : "Allow HTTP on hosts" }]} />
          {how === "push" ? (
            <>
              <CopyBlock label="Commands copied" text={`docker login ${address}\ndocker tag myapp:latest ${address}/myapp:1.0\ndocker push ${address}/myapp:1.0`} />
              <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
                Log in with your Dockhand username and password, or any username plus an access token (below) for CI. Deploy pushed images from Deploy → Run a container; Dockhand gives every host its own read-only access automatically.
              </span>
            </>
          ) : info?.secure ? (
            <span style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>Dockhand is served over HTTPS, so hosts and your machine can push and pull without extra configuration.</span>
          ) : (
            <>
              <span style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
                Dockhand is served over plain HTTP. Docker only talks to HTTP registries it has been told to trust (except on <span className="mono">localhost</span>), so add this to <span className="mono">/etc/docker/daemon.json</span> on each host and on your own machine, then restart Docker:
              </span>
              <CopyBlock label="daemon.json copied" text={JSON.stringify({ "insecure-registries": [address] }, null, 2)} />
              <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
                Restarting Docker restarts its containers. Better: put Dockhand behind HTTPS (Caddy, Traefik or a Cloudflare tunnel) and set its public URL to the https address — then nothing needs changing on the hosts.
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ReposCard() {
  const shell = useShell();
  const { settings } = useSettings();
  const on = !!settings?.registry?.enabled;
  const { data: info } = useApi<RegistryInfo>(on ? "/api/registry" : null);
  const { data: repos, error, mutate } = useApi<RegistryRepo[]>(on && info?.reachable ? "/api/registry/repos" : null, { refresh: 30000 });
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  if (!on || !info?.reachable) return null;
  const shown = (repos ?? []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));

  const gc = async () => {
    const ok = await shell.confirm({
      title: "Reclaim space?",
      text: "Deletes image layers no tag points to any more — what's left behind after deleting tags or re-pushing a tag. Avoid pushing while it runs.",
      confirmLabel: "Reclaim space",
      icon: "clean",
      details: info.size >= 0 ? [{ k: "Registry size", v: bytes(info.size) }] : undefined,
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>("/api/registry/gc"), { title: "Reclaiming registry space", done: "Registry space reclaimed", invalidate: ["/api/registry"] });
  };

  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Repositories" sub={repos ? plural(repos.length, "image", "images") : undefined}>
        <InkButton onClick={gc} title="Delete layers that no tag uses any more">
          <Icon name="clean" size={14} />
          Reclaim space
        </InkButton>
      </InkHead>
      {repos && repos.length > 6 && <input className="filter-input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}
      {!repos && !error && [0, 1].map((i) => <span key={i} className="skel" style={{ height: 50, borderRadius: 14 }} />)}
      {error && <span style={{ fontSize: 12.5, color: "var(--crit-ink)" }}>{error.message}</span>}
      {repos && !repos.length && (
        <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>
          Nothing pushed yet. Tag an image as <span className="mono">{info.address}/name:tag</span> and <span className="mono">docker push</span> it.
        </span>
      )}
      {shown.map((r) => (
        <RepoRow key={r.name} repo={r} address={info.address} open={open === r.name} onToggle={() => setOpen(open === r.name ? null : r.name)} onChanged={() => { mutate(); invalidate("/api/registry"); }} />
      ))}
    </div>
  );
}

function RepoRow({ repo, address, open, onToggle, onChanged }: { repo: RegistryRepo; address: string; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const shell = useShell();
  const router = useRouter();
  const { data: tags, mutate } = useApi<RegistryTag[]>(open ? `/api/registry/tags?repo=${encodeURIComponent(repo.name)}` : null);

  const remove = async (t: RegistryTag) => {
    const same = (tags ?? []).filter((x) => x.digest && x.digest === t.digest && x.tag !== t.tag).map((x) => x.tag);
    const ok = await shell.confirm({
      title: `Delete ${repo.name}:${t.tag}?`,
      text: same.length
        ? `This image is also tagged ${same.map((x) => `“${x}”`).join(", ")} — those tags are deleted with it. Hosts keep any copy they already pulled.`
        : "Hosts keep any copy they already pulled. Reclaim space afterwards to free the disk.",
      confirmLabel: "Delete",
      danger: true,
      icon: "trash",
      details: [{ k: "Digest", v: t.digest.slice(7, 19) }, { k: "Size", v: bytes(t.size) }],
    });
    if (!ok) return;
    try {
      await del(`/api/registry/tags?repo=${encodeURIComponent(repo.name)}&tag=${encodeURIComponent(t.tag)}`);
      shell.toast({ kind: "ok", title: `Deleted ${repo.name}:${t.tag}` });
      mutate();
      onChanged();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't delete tag", text: errMsg(e) });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 4, borderRadius: 16, background: open ? "var(--fill-1)" : undefined }}>
      <button type="button" onClick={onToggle} aria-expanded={open} style={{ ...rowStyle(), border: 0, cursor: "pointer", textAlign: "left", color: "var(--ink)", font: "inherit", width: "100%" }}>
        <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s", color: "var(--ink-3)" }}>
          <Icon name="chevronRight" size={13} />
        </span>
        <Icon name="box" size={15} />
        <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{repo.name}</span>
        <span style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{plural(repo.tags, "tag")}</span>
      </button>
      {open && !tags && <span className="skel" style={{ height: 40, borderRadius: 12, margin: "0 8px 6px" }} />}
      {open &&
        tags?.map((t) => {
          const ref = `${address}/${repo.name}:${t.tag}`;
          return (
            <div key={t.tag} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 12, background: "var(--surface)", flexWrap: "wrap" }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: "1 1 160px", minWidth: 0 }}>
                <span className="mono ellipsis" style={{ fontSize: 12.5, fontWeight: 700 }}>{t.tag}</span>
                <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {[t.digest ? t.digest.slice(7, 19) : "", t.size ? bytes(t.size) : "", t.platforms.join(", "), t.createdAt ? `built ${ago(t.createdAt)}` : ""].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span style={{ display: "flex", gap: 6, flex: "none" }}>
                <button type="button" className="btn2 sm" onClick={() => router.push(`/deploy?mode=image&image=${encodeURIComponent(ref)}`)}>
                  <Icon name="rocket" size={13} />
                  Deploy
                </button>
                <button type="button" className="btn2 sm" title="Copy docker pull command" onClick={() => copyText(`docker pull ${ref}`).then(() => shell.toast({ kind: "ok", title: "Pull command copied", text: ref }))}>
                  <Icon name="copy" size={13} />
                </button>
                <button type="button" className="btn2 sm danger" title="Delete this tag" onClick={() => remove(t)}>
                  <Icon name="trash" size={13} />
                </button>
              </span>
            </div>
          );
        })}
    </div>
  );
}

// ─── Access tokens ─────────────────────────────────────────────────────────

function TokensCard() {
  const shell = useShell();
  const { settings } = useSettings();
  const on = !!settings?.registry?.enabled;
  const { data: tokens, mutate } = useApi<RegistryToken[]>(on ? "/api/registry/tokens" : null);
  const { data: info } = useApi<RegistryInfo>(on ? "/api/registry" : null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"pull" | "push">("push");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<RegistryToken | null>(null);
  if (!on) return null;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await post<RegistryToken>("/api/registry/tokens", { name, scope });
      setFresh(t);
      setName("");
      mutate();
    } catch (err) {
      shell.toast({ kind: "error", title: "Couldn't create token", text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: RegistryToken) => {
    const ok = await shell.confirm({ title: `Revoke “${t.name}”?`, text: "Anything logged in with this token loses access immediately.", confirmLabel: "Revoke", danger: true, icon: "key", details: [{ k: "Token", v: `${t.prefix}…` }, { k: "Last used", v: t.lastUsedAt ? ago(t.lastUsedAt) : "never" }] });
    if (!ok) return;
    try {
      await del(`/api/registry/tokens/${t.id}`);
      shell.toast({ kind: "ok", title: `Revoked ${t.name}` });
      mutate();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't revoke token", text: errMsg(e) });
    }
  };

  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Access tokens" sub="for CI and scripts" />
      {fresh?.token && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 14, background: "rgba(34,160,107,.08)", border: "1px solid rgba(34,160,107,.25)" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ok-ink)" }}>Copy “{fresh.name}” now — it won&apos;t be shown again.</span>
          <CopyBlock label="Token copied" text={fresh.token} />
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Log in with any username:</span>
          <CopyBlock label="Login command copied" text={`echo '${fresh.token}' | docker login ${info?.address ?? "<registry>"} -u ci --password-stdin`} />
          <button type="button" className="btn2 sm" style={{ alignSelf: "flex-start" }} onClick={() => setFresh(null)}>Done</button>
        </div>
      )}
      <form onSubmit={create} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="input" style={{ flex: "1 1 160px", height: 38 }} placeholder="Token name, e.g. GitHub Actions" value={name} onChange={(e) => setName(e.target.value)} />
        <Seg<"pull" | "push"> value={scope} onChange={setScope} options={[{ value: "push", label: "Push + pull" }, { value: "pull", label: "Pull only" }]} />
        <button type="submit" className="btn" style={{ height: 38 }} disabled={busy || !name.trim()}>
          {busy && <span className="spinner" style={{ width: 12, height: 12 }} />}
          Create
        </button>
      </form>
      {!tokens && <span className="skel" style={{ height: 50, borderRadius: 14 }} />}
      {tokens?.map((t) => (
        <div key={t.id} style={rowStyle()}>
          <span className="dot" style={{ background: t.lastUsedAt ? C.ok : "var(--muted)" }} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>{t.name}</span>
            <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {t.system ? "used by Dockhand to pull on your hosts" : `${t.prefix}… · ${t.scope === "push" ? "push + pull" : "pull only"}`} · {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : "never used"}
            </span>
          </span>
          {t.system ? <StatusPill {...PILL.muted}>built in</StatusPill> : <button type="button" className="btn2 sm danger" onClick={() => revoke(t)}>Revoke</button>}
        </div>
      ))}
    </div>
  );
}

// ─── Credentials for other registries ──────────────────────────────────────

const PRESETS = [
  { id: "docker.io", label: "Docker Hub", user: "Docker Hub username", pass: "Personal access token", tokenUrl: "https://app.docker.com/settings/personal-access-tokens", hint: "A read-only personal access token is enough for pulls." },
  { id: "ghcr.io", label: "GitHub", user: "GitHub username", pass: "Personal access token (classic)", tokenUrl: "https://github.com/settings/tokens/new?scopes=read:packages&description=Dockhand", hint: "Needs the read:packages scope." },
  { id: "registry.gitlab.com", label: "GitLab", user: "GitLab username or deploy token user", pass: "Token", tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens?name=Dockhand&scopes=read_registry", hint: "Needs read_registry." },
  { id: "quay.io", label: "Quay", user: "Robot account or username", pass: "Password or robot token", tokenUrl: "", hint: "" },
  { id: "", label: "Other", user: "Username", pass: "Password or token", tokenUrl: "", hint: "Any registry: self-hosted, Harbor, Gitea, AWS ECR (username AWS + a token from aws ecr get-login-password; it expires after 12 hours)…" },
] as const;

function CredentialsCard() {
  const shell = useShell();
  const { data: creds, mutate } = useApi<RegistryCredential[]>("/api/registries/credentials");
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const test = async (c: RegistryCredential) => {
    setTesting(c.id);
    try {
      const r = await post<{ ok: boolean; error?: string }>(`/api/registries/credentials/test?id=${c.id}`);
      if (r.ok) shell.toast({ kind: "ok", title: `Logged in to ${c.server}` });
      else shell.toast({ kind: "error", title: `${c.server} refused the login`, text: r.error });
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't test", text: errMsg(e) });
    } finally {
      setTesting(null);
    }
  };

  const remove = async (c: RegistryCredential) => {
    const ok = await shell.confirm({ title: `Remove the login for ${c.server}?`, text: "Private images from this registry can't be pulled or updated until you add it again. Containers that are already running keep running.", confirmLabel: "Remove", danger: true, icon: "key", details: [{ k: "User", v: c.username }] });
    if (!ok) return;
    try {
      await del(`/api/registries/credentials/${c.id}`);
      shell.toast({ kind: "ok", title: `Removed ${c.server}` });
      mutate();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't remove", text: errMsg(e) });
    }
  };

  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Private registries" sub="logins Dockhand uses on every host">
        {!adding && (
          <button type="button" className="set-ink-btn solid" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} />
            Add
          </button>
        )}
      </InkHead>
      <span style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5 }}>
        Used for pulls, compose deploys and update checks. Hosts are never logged in: each command gets a temporary Docker config that&apos;s deleted when it finishes.
      </span>
      {adding && (
        <AddCredential
          onDone={(saved) => {
            setAdding(false);
            if (saved) mutate();
          }}
        />
      )}
      {!creds && <span className="skel" style={{ height: 50, borderRadius: 14 }} />}
      {creds && !creds.length && !adding && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>No private registries yet. Public images work without one.</span>}
      {creds?.map((c) => (
        <div key={c.id} style={rowStyle()}>
          <Icon name="lock" size={15} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 700 }}>{c.server}</span>
            <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
              {c.username} · {c.lastUsedAt ? `used ${ago(c.lastUsedAt)}` : "not used yet"}
            </span>
          </span>
          <button type="button" className="btn2 sm" onClick={() => test(c)} disabled={testing === c.id}>
            {testing === c.id && <span className="spinner" style={{ width: 11, height: 11 }} />}
            Test
          </button>
          <button type="button" className="btn2 sm danger" onClick={() => remove(c)} aria-label={`Remove ${c.server}`}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function AddCredential({ onDone }: { onDone: (saved: boolean) => void }) {
  const shell = useShell();
  const [preset, setPreset] = useState<string>("ghcr.io");
  const [server, setServer] = useState("ghcr.io");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[PRESETS.length - 1];
  useEffect(() => {
    setErr("");
    setFailed(false);
  }, [server, username, password]);

  const save = async (skipTest: boolean) => {
    setErr("");
    if (!server.trim() || !username.trim() || !password) return setErr("Fill in the registry, username and password.");
    setBusy(true);
    try {
      const body = { server: server.trim(), username: username.trim(), password };
      if (!skipTest) {
        const r = await post<{ ok: boolean; error?: string }>("/api/registries/credentials/test", body);
        if (!r.ok) {
          setErr(r.error ?? "The registry refused the login.");
          setFailed(true);
          return;
        }
      }
      const c = await post<RegistryCredential>("/api/registries/credentials", body);
      shell.toast({ kind: "ok", title: `Saved login for ${c.server}`, text: skipTest ? "Saved without testing." : "Login tested and works." });
      onDone(true);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, borderRadius: 16, background: "var(--fill-1)" }}
      autoComplete="off"
    >
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PRESETS.map((x) => (
          <button
            key={x.label}
            type="button"
            onClick={() => {
              setPreset(x.id);
              setServer(x.id);
            }}
            aria-pressed={preset === x.id}
            style={{ height: 30, padding: "0 12px", borderRadius: 10, border: 0, background: preset === x.id ? "var(--btn)" : "var(--surface)", color: preset === x.id ? "var(--btn-ink)" : "var(--ink)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
          >
            {x.label}
          </button>
        ))}
      </div>
      {!p.id && (
        <Field label="Registry" hint="Host and optional port, e.g. registry.example.com or 10.0.0.5:5000">
          <input className="input mono" value={server} onChange={(e) => setServer(e.target.value)} placeholder="registry.example.com" autoCapitalize="off" spellCheck={false} autoFocus />
        </Field>
      )}
      <Field label={p.user}>
        <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="off" spellCheck={false} autoFocus={!!p.id} />
      </Field>
      <Field
        label={p.pass}
        hint={
          <>
            {p.hint}{" "}
            {p.tokenUrl && (
              <a href={p.tokenUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                Create one ↗
              </a>
            )}
          </>
        }
      >
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button type="button" className="btn2" onClick={() => onDone(false)}>Cancel</button>
        {failed && (
          <button type="button" className="btn2" onClick={() => save(true)} disabled={busy}>
            Save anyway
          </button>
        )}
        <button type="submit" className="btn" disabled={busy}>
          {busy && <span className="spinner" style={{ width: 12, height: 12 }} />}
          Test &amp; save
        </button>
      </div>
    </form>
  );
}
