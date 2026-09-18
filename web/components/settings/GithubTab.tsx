"use client";

import { useState } from "react";
import useSWR from "swr";
import { Icon } from "@/components/icons";
import { Dialog, DialogHeader, Seg, Toggle, copyText, shortKey } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { del, errMsg, get, invalidate, patch, post, useApi } from "@/lib/api";
import { C, ago, avatarBg, initial, plural, shortSha } from "@/lib/format";
import type { GitAccount, Host, SshKeyInfo, Stack } from "@/lib/types";
import { GithubTokenLinks } from "@/components/dialogs/common";
import { GithubDialog } from "@/components/dialogs/GithubDialog";
import { INK_PILL, InkHead, Portal, SetToggle, StatusPill, cardStyle, colStack, mask, rowStyle, twoCol, useSettings } from "./common";

type GitStack = Stack & { hostName: string };

/** Git-sourced stacks across every host. Keyed under /api/hosts so invalidate("/api/hosts") refreshes it. */
export function useGitStacks() {
  const { data: hosts } = useApi<Host[]>("/api/hosts");
  return useSWR<GitStack[]>(hosts ? `/api/hosts#git-stacks:${hosts.map((h) => h.id).join(",")}` : null, async () => {
    const lists = await Promise.all(
      (hosts ?? []).map((h) =>
        get<Stack[]>(`/api/hosts/${h.id}/stacks`)
          .then((ss) => ss.filter((s) => s.source === "git").map((s) => ({ ...s, hostName: h.name })))
          .catch(() => [] as GitStack[]),
      ),
    );
    return lists.flat();
  });
}

export function GithubTab() {
  return (
    <div style={twoCol(380)}>
      <div style={colStack}>
        <GithubCard />
        <AutoDeployCard />
      </div>
      <div style={colStack}>
        <DeployKeyCard />
        <LinkedCard />
      </div>
    </div>
  );
}

function GithubCard() {
  const shell = useShell();
  const { settings, save } = useSettings();
  const { data: accounts, mutate } = useApi<GitAccount[]>("/api/github/accounts");
  const connected = !!accounts?.length;
  const anyError = accounts?.some((a) => a.status === "error");
  const pill = !accounts ? { ...INK_PILL.muted, label: "Checking…" } : !connected ? { ...INK_PILL.muted, label: "Not connected" } : anyError ? { ...INK_PILL.warn, label: "Needs attention" } : { ...INK_PILL.ok, label: "Connected" };

  const resync = async (a: GitAccount) => {
    mutate(accounts?.map((x) => (x.id === a.id ? { ...x, status: "syncing" as const } : x)), { revalidate: false });
    try {
      const r = await post<GitAccount>(`/api/github/accounts/${a.id}/sync`);
      shell.toast({ kind: r.status === "error" ? "error" : "ok", title: r.status === "error" ? `Sync failed for ${a.login}` : `Re-synced ${a.login}`, text: r.status === "error" ? r.lastError : `${plural(r.repoCount, "repo")} · ${r.composeRepoCount} with compose` });
    } catch (e) {
      shell.toast({ kind: "error", title: `Couldn't sync ${a.login}`, text: errMsg(e) });
    }
    invalidate("/api/github");
  };

  const disconnect = async (a: GitAccount) => {
    const ok = await shell.confirm({
      title: `Disconnect ${a.login}?`,
      text: "Dockhand forgets the token and its repo list. Stacks already deployed keep running, but auto-deploy from these repos stops.",
      confirmLabel: "Disconnect",
      danger: true,
      icon: "branch",
    });
    if (!ok) return;
    try {
      await del(`/api/github/accounts/${a.id}`);
      shell.toast({ kind: "ok", title: `Disconnected ${a.login}` });
      invalidate("/api/github");
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't disconnect", text: errMsg(e) });
    }
  };

  const setEnabled = async (a: GitAccount, enabled: boolean) => {
    const prev = accounts;
    mutate(accounts?.map((x) => (x.id === a.id ? { ...x, enabled } : x)), { revalidate: false });
    try {
      await patch(`/api/github/accounts/${a.id}`, { enabled });
      invalidate("/api/github");
    } catch (e) {
      mutate(prev, { revalidate: false });
      shell.toast({ kind: "error", title: "Couldn't update access", text: errMsg(e) });
    }
  };

  return (
    <div className="glass-card" style={cardStyle(18)}>
      <InkHead icon="branch" title="GitHub" sub="Deploy compose files straight from your repos.">
        <StatusPill bg={pill.bg} color={pill.color}>{pill.label}</StatusPill>
      </InkHead>

      {!accounts && <span className="skel" style={{ height: 64, borderRadius: 14 }} />}

      {connected && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>Connected accounts</span>
              <button type="button" className="btn2 sm" style={{ marginLeft: "auto", borderRadius: 12 }} onClick={() => shell.openDialog({ type: "github" })}>
                <Icon name="plus" size={13} />
                Add account
              </button>
            </div>
            {accounts!.map((a) => (
              <div key={a.id} style={{ ...rowStyle(true), flexWrap: "wrap" }}>
                <span style={{ width: 36, height: 36, borderRadius: "50%", background: avatarBg(a.color || C.violet), color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14, flex: "none" }}>{initial(a.login)}</span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                    {a.login} <span style={{ fontWeight: 500, color: "var(--ink-3)" }}>· {a.kind}</span>
                  </span>
                  <span className="mono ellipsis" style={{ fontSize: 11, color: a.status === "error" ? "var(--crit-ink)" : "var(--ink-3)" }} title={a.lastError || undefined}>
                    {a.status === "error" ? a.lastError || "Sync failed" : a.status === "syncing" ? `syncing… · ${plural(a.repoCount, "repo")}` : `${plural(a.repoCount, "repo")} · ${a.composeRepoCount} with compose · synced ${ago(a.lastSyncAt)}`}
                  </span>
                </span>
                <span className="dot" style={{ background: a.status === "ok" ? C.ok : a.status === "error" ? C.crit : C.warn }} />
                <span style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="btn2 xs" disabled={a.status === "syncing"} onClick={() => resync(a)}>
                    {a.status === "syncing" && <span className="spinner" style={{ width: 11, height: 11 }} />}
                    Re-sync
                  </button>
                  <button type="button" className="btn2 xs danger" onClick={() => disconnect(a)}>Disconnect</button>
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>Repository access</span>
            {accounts!.map((a) => (
              <div key={a.id} style={rowStyle()}>
                <span style={{ width: 30, height: 30, borderRadius: 9, background: avatarBg(a.color || C.violet), color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12, flex: "none" }}>{initial(a.login)}</span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                  <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>{a.login}</span>
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {!a.enabled ? "Hidden from deploy pickers" : a.repoAccess === "all" ? `All repositories · ${a.repoCount}` : `${plural(a.selectedRepos.length, "selected repository", "selected repositories")}`}
                    {a.webhook ? " · webhook on" : ""}
                  </span>
                </span>
                <Toggle on={a.enabled} onChange={(v) => setEnabled(a, v)} />
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 14px" }}>
              <span style={{ flex: 1, fontSize: 13, color: "var(--ink-4)" }}>Only show repos that contain a compose file</span>
              <Toggle on={!!settings?.github.onlyCompose} disabled={!settings} onChange={(v) => save({ github: { onlyCompose: v } })} />
            </div>
          </div>
        </>
      )}

      {accounts && !connected && <ConnectOptions />}
    </div>
  );
}

type ConnMethod = "app" | "pat" | "oauth";

function ConnectOptions() {
  const shell = useShell();
  const [m, setM] = useState<ConnMethod>("app");
  const [wizard, setWizard] = useState<ConnMethod | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const saveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      const a = await post<GitAccount>("/api/github/accounts", { kind: "user", method: "pat", token: token.trim() });
      shell.toast({ kind: "ok", title: `Connected ${a.login}`, text: "Syncing repositories in the background." });
      setToken("");
      invalidate("/api/github");
    } catch (err) {
      shell.toast({ kind: "error", title: "Token rejected", text: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  const primary = { alignSelf: "flex-start" as const, fontWeight: 600 };
  return (
    <>
      <div className="field" style={{ gap: 8 }}>
        Connect with
        <Seg<ConnMethod> size="lg" options={[{ value: "app", label: "GitHub App" }, { value: "pat", label: "Access token" }, { value: "oauth", label: "OAuth" }]} value={m} onChange={setM} />
      </div>
      {m === "app" && (
        <>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>Recommended. Installs a Dockhand app on your account or org — fine-grained, read-only, revocable from GitHub at any time.</p>
          <button type="button" className="btn" style={primary} onClick={() => setWizard("app")}>
            <Icon name="branch" size={16} />
            Install GitHub App
          </button>
        </>
      )}
      {m === "pat" && (
        <form onSubmit={saveToken} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label className="field">
            Personal access token
            <input className="input mono" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
            Needs <code className="mono">repo:read</code> and <code className="mono">admin:repo_hook</code> for auto-deploy.
          </span>
          <GithubTokenLinks />
          <button type="submit" className="btn" style={primary} disabled={busy || !token.trim()}>
            {busy && <span className="spinner" />}
            Save token
          </button>
        </form>
      )}
      {m === "oauth" && (
        <>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>Sign in with your GitHub account. Grants access to everything you can see — simplest for personal use.</p>
          <button type="button" className="btn" style={primary} onClick={() => setWizard("oauth")}>Continue with GitHub</button>
        </>
      )}
      {wizard && (
        <Portal>
          <GithubDialog initialMethod={wizard} onClose={() => setWizard(null)} />
        </Portal>
      )}
    </>
  );
}

function AutoDeployCard() {
  const shell = useShell();
  const { settings, save } = useSettings();
  const { data: stacks, mutate } = useGitStacks();
  const [secret, setSecret] = useState<string | null>(null);
  const on = (stacks ?? []).filter((s) => s.autoDeploy).length;

  const setAuto = async (targets: GitStack[], v: boolean) => {
    const ids = new Set(targets.map((s) => `${s.hostId}/${s.name}`));
    const prev = stacks;
    mutate(stacks?.map((s) => (ids.has(`${s.hostId}/${s.name}`) ? { ...s, autoDeploy: v } : s)), { revalidate: false });
    const failed: string[] = [];
    for (const s of targets) {
      try {
        await patch(`/api/hosts/${s.hostId}/stacks/${encodeURIComponent(s.name)}`, { autoDeploy: v });
      } catch (e) {
        failed.push(`${s.name}: ${errMsg(e)}`);
      }
    }
    if (failed.length) {
      mutate(prev, { revalidate: false });
      shell.toast({ kind: "error", title: "Couldn't change auto-deploy", text: failed[0] });
    }
    mutate();
  };

  const rotate = async () => {
    const ok = await shell.confirm({
      title: "Rotate webhook secret?",
      text: "Existing GitHub webhooks stop verifying until you update them with the new secret (Dockhand updates webhooks it installed itself).",
      confirmLabel: "Rotate secret",
      danger: true,
      icon: "key",
    });
    if (!ok) return;
    try {
      const r = await post<{ secret: string }>("/api/settings/github/rotate-secret");
      setSecret(r.secret);
      invalidate("/api/settings");
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't rotate secret", text: errMsg(e) });
    }
  };

  const gh = settings?.github;
  const copy = (v: string, what: string) => copyText(v).then(() => shell.toast({ kind: "ok", title: `${what} copied` }));

  return (
    <div className="glass-card" style={cardStyle(14)}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>Auto-deploy</div>
      <SetToggle label="Redeploy on push" sub="When the default branch of a deployed repo changes" on={!!gh?.autoDeploy} disabled={!gh} onChange={(v) => save({ github: { autoDeploy: v } })} />
      <SetToggle label="Wait for checks to pass" sub="Skip the deploy if CI on that commit is red" on={!!gh?.waitChecks} disabled={!gh} onChange={(v) => save({ github: { waitChecks: v } })} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-2)" }}>Per stack</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{stacks ? (stacks.length ? `${on} of ${stacks.length} on` : "no git stacks yet") : "loading…"}</span>
          {!!stacks?.length && (
            <>
              <button type="button" className="btn-link" style={{ marginLeft: "auto" }} onClick={() => setAuto(stacks.filter((s) => !s.autoDeploy), true)}>All on</button>
              <button type="button" className="btn-link" onClick={() => setAuto(stacks.filter((s) => s.autoDeploy), false)}>All off</button>
            </>
          )}
        </div>
        {!stacks && [0, 1].map((i) => <span key={i} className="skel" style={{ height: 50, borderRadius: 14 }} />)}
        {stacks?.map((s) => (
          <div key={`${s.hostId}/${s.name}`} style={rowStyle(true, { padding: "9px 12px", opacity: gh?.autoDeploy === false ? 0.6 : 1 })}>
            <span className="dot" style={{ background: s.status === "running" ? C.ok : s.status === "partial" ? C.warn : "var(--muted)" }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
              <span className="ellipsis" style={{ fontSize: 13, fontWeight: 700 }}>
                {s.name} <span style={{ fontWeight: 500, color: "var(--ink-3)" }}>on {s.hostName}</span>
              </span>
              <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{s.repo} · {s.branch}</span>
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{s.autoDeploy ? "on push" : "manual"}</span>
            <Toggle on={s.autoDeploy} onChange={(v) => setAuto([s], v)} />
          </div>
        ))}
      </div>
      <label className="field">
        Webhook URL
        <span style={{ display: "flex", gap: 8 }}>
          <input className="input mono" readOnly value={gh?.webhookUrl ?? ""} style={{ color: "var(--ink-2)" }} onFocus={(e) => e.target.select()} />
          <button type="button" className="btn2 lg" disabled={!gh?.webhookUrl} onClick={() => gh && copy(gh.webhookUrl, "Webhook URL")}>Copy</button>
        </span>
      </label>
      <label className="field">
        Webhook secret
        <span style={{ display: "flex", gap: 8 }}>
          <input className="input mono" readOnly value={mask(gh?.webhookSecret ?? "")} style={{ color: "var(--ink-2)" }} />
          <button type="button" className="btn2 lg" onClick={rotate}>Rotate</button>
        </span>
      </label>
      {secret && (
        <Portal>
        <Dialog onClose={() => setSecret(null)} width={480}>
          <DialogHeader icon="key" title="New webhook secret" sub="Shown once — copy it now." onClose={() => setSecret(null)} />
          <div className="term-block" style={{ fontSize: 12.5 }}>{secret}</div>
          <span className="field-hint">Paste it into the Secret field of any webhook you created by hand in GitHub (Settings → Webhooks).</span>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn2 lg" onClick={() => copy(secret, "Secret")}>
              <Icon name="copy" size={14} />
              Copy
            </button>
            <button type="button" className="btn" onClick={() => setSecret(null)}>Done</button>
          </div>
        </Dialog>
        </Portal>
      )}
    </div>
  );
}

function DeployKeyCard() {
  const shell = useShell();
  const { data: key } = useApi<SshKeyInfo>("/api/deploy-key");
  return (
    <div className="glass-card" style={cardStyle(14)}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>Deploy key</div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>Hosts clone private repos with this read-only key. Add it as a deploy key on repos the GitHub App can&apos;t reach.</p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, border: "1px solid rgba(47,111,237,.35)", background: "rgba(47,111,237,.06)" }}>
        <span style={{ width: 34, height: 34, flex: "none", borderRadius: 10, background: "var(--blue)", color: "#fff", display: "grid", placeItems: "center" }}>
          <Icon name="key" size={17} />
        </span>
        <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-4)", flex: 1, minWidth: 0 }} title={key?.fingerprint}>{key ? shortKey(key.publicKey) : "loading…"}</span>
        <button type="button" className="btn2 sm" disabled={!key} onClick={() => key && copyText(key.publicKey).then(() => shell.toast({ kind: "ok", title: "Deploy key copied", text: "Add it under the repo's Settings → Deploy keys." }))}>Copy</button>
      </div>
    </div>
  );
}

function LinkedCard() {
  const { data: stacks } = useGitStacks();
  return (
    <div className="glass-card" style={cardStyle(12)}>
      <InkHead title="Linked deployments" sub={stacks ? plural(stacks.length, "stack") : undefined} />
      {!stacks && [0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 54, borderRadius: 14 }} />)}
      {stacks && !stacks.length && <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>Nothing deployed from GitHub yet. Pick a repo under Deploy → From GitHub.</span>}
      {stacks?.map((s) => (
        <div key={`${s.hostId}/${s.name}`} style={rowStyle()}>
          <span className="dot" style={{ background: s.status === "running" ? C.ok : s.status === "partial" ? C.warn : C.crit }} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>
              {s.name} <span style={{ fontWeight: 500, color: "var(--ink-3)" }}>on {s.hostName}</span>
            </span>
            <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {s.repo} @ {shortSha(s.sha) || s.branch} · {s.lastDeployAt ? ago(s.lastDeployAt) : "never deployed"}
            </span>
          </span>
          {s.autoDeploy && <span className="tag blue">auto</span>}
        </div>
      ))}
    </div>
  );
}
