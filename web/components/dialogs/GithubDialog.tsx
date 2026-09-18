"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogHeader, Seg, Skel, Stepper, Toggle, copyText } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { errMsg, get, invalidate, patch, post, useApi } from "@/lib/api";
import type { DeviceFlowStart, GitAccount, GitAccountInput, Repo, Settings } from "@/lib/types";
import { Actions, Callout, Field, GithubTokenLinks, Group } from "./common";

type Kind = GitAccountInput["kind"];
type Method = GitAccountInput["method"];

const KINDS: { value: Kind; label: string; sub: string; icon: IconName }[] = [
  { value: "user", label: "Personal account", sub: "Your repos and ones you collaborate on", icon: "user" },
  { value: "org", label: "Organization", sub: "Repos owned by a team or company org", icon: "org" },
  { value: "enterprise", label: "Enterprise server", sub: "Self-hosted GitHub Enterprise", icon: "building" },
];

export function GithubDialog({ onClose, initialMethod }: { onClose: () => void; initialMethod?: Method }) {
  const { toast } = useShell();
  const router = useRouter();
  const settings = useApi<Settings>("/api/settings");
  const gh = settings.data?.github;
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind>("user");
  const [method, setMethod] = useState<Method>(initialMethod ?? "pat");
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<DeviceFlowStart | null>(null);
  const [waitingApp, setWaitingApp] = useState(false);
  const [account, setAccount] = useState<GitAccount | null>(null);

  // step 2 state
  const [access, setAccess] = useState<"all" | "selected">("all");
  const [picked, setPicked] = useState<string[]>([]);
  const [webhook, setWebhook] = useState(true);

  const enterprise = kind === "enterprise";

  const connected = (a: GitAccount) => {
    setAccount(a);
    setAccess(a.repoAccess);
    setPicked(a.selectedRepos);
    setDevice(null);
    setWaitingApp(false);
    setStep(1);
    invalidate("/api/github");
    toast({ kind: "ok", title: `Connected @${a.login}` });
  };

  // OAuth device flow polling
  useEffect(() => {
    if (!device) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + device.expiresIn * 1000;
    let interval = Math.max(2, device.interval) * 1000;
    const tick = async () => {
      try {
        const r = await post<{ status: "pending" | "ok" | "expired" | "denied" | "slow_down"; account?: GitAccount }>("/api/github/oauth/poll", { deviceCode: device.deviceCode });
        if (!alive) return;
        if (r.status === "ok" && r.account) return connected(r.account);
        if (r.status === "expired" || r.status === "denied") {
          setDevice(null);
          setErr(r.status === "expired" ? "The code expired before it was approved. Try again." : "Access was denied on GitHub.");
          return;
        }
        if (r.status === "slow_down") interval += 5000;
      } catch (e) {
        if (!alive) return;
        setDevice(null);
        setErr(errMsg(e));
        return;
      }
      if (Date.now() > deadline) {
        setDevice(null);
        setErr("The code expired before it was approved. Try again.");
        return;
      }
      timer = setTimeout(tick, interval);
    };
    timer = setTimeout(tick, interval);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  // GitHub App: wait for the callback to register a new account
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!waitingApp) return;
    let alive = true;
    const iv = setInterval(async () => {
      try {
        const list = await get<GitAccount[]>("/api/github/accounts");
        if (!alive) return;
        const fresh = list.find((a) => !known.current?.has(a.id));
        if (fresh) connected(fresh);
      } catch {
        /* keep waiting */
      }
    }, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingApp]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (enterprise && !/^https?:\/\/.+/.test(serverUrl.trim())) return setErr("Enter the server URL, e.g. https://github.acme.internal");
    const server = enterprise ? serverUrl.trim().replace(/\/+$/, "") : undefined;
    setBusy(true);
    try {
      if (method === "pat") {
        if (!token.trim()) return setErr("Paste a personal access token.");
        const a = await post<GitAccount>("/api/github/accounts", { kind, method: "pat", token: token.trim(), serverUrl: server } satisfies GitAccountInput);
        connected(a);
      } else if (method === "oauth") {
        const d = await post<DeviceFlowStart>("/api/github/oauth/device", server ? { serverUrl: server } : {});
        setDevice(d);
      } else {
        if (!gh?.appConfigured || !gh.appInstallUrl) return;
        const list = await get<GitAccount[]>("/api/github/accounts").catch(() => [] as GitAccount[]);
        known.current = new Set(list.map((a) => a.id));
        window.open(gh.appInstallUrl, "_blank", "noopener");
        setWaitingApp(true);
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!account) return;
    setBusy(true);
    try {
      const a = await patch<GitAccount>(`/api/github/accounts/${account.id}`, { repoAccess: access, selectedRepos: access === "selected" ? picked : [], webhook });
      setAccount(a);
      invalidate("/api/github");
      setStep(2);
    } catch (e) {
      toast({ kind: "error", title: "Couldn't save repository access", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const nextLabel = method === "pat" ? "Connect" : method === "oauth" ? "Continue with GitHub" : "Install GitHub App ↗";
  const methodBlocked = (method === "app" && !gh?.appConfigured) || (method === "oauth" && gh && !gh.oauthConfigured);

  return (
    <Dialog onClose={onClose} width={540}>
      <DialogHeader icon="branch" title="Connect GitHub" sub="Each account or organization is its own connection — add as many as you need." onClose={onClose} />
      <Stepper steps={["Connect", "Access", "Done"]} current={step === 2 ? 3 : step} />

      {step === 0 && !device && !waitingApp && (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Group label="What are you connecting?">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8 }}>
              {KINDS.map((k) => {
                const on = kind === k.value;
                return (
                  <button key={k.value} type="button" onClick={() => setKind(k.value)} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 14px", borderRadius: 14, border: `1.5px solid ${on ? "var(--blue)" : "var(--line-2)"}`, background: on ? "rgba(47,111,237,.08)" : "transparent", cursor: "pointer", textAlign: "left", color: "var(--ink)", transition: "all .15s" }}>
                    <span style={{ display: "flex", color: on ? "var(--blue)" : "var(--ink-2)" }}><Icon name={k.icon} size={18} /></span>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{k.label}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 400, color: "var(--ink-3)", lineHeight: 1.4 }}>{k.sub}</span>
                  </button>
                );
              })}
            </div>
          </Group>
          {enterprise && (
            <Field label="Server URL">
              <input className="input mono" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://github.acme.internal" autoCapitalize="off" />
            </Field>
          )}
          <Group label="Authentication">
            <Seg<Method>
              fit
              value={method}
              onChange={(m) => {
                setMethod(m);
                setErr("");
              }}
              options={[
                { value: "app", label: "GitHub App" },
                { value: "oauth", label: "OAuth" },
                { value: "pat", label: "Token" },
              ]}
            />
          </Group>
          {method === "pat" && (
            <Field label="Personal access token" hint={<GithubTokenLinks serverUrl={enterprise ? serverUrl : undefined} />}>
              <input className="input mono" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_… or ghp_…" autoComplete="off" />
            </Field>
          )}
          {method === "oauth" && (
            gh && !gh.oauthConfigured ? (
              <Callout kind="warn">
                <Icon name="alert" size={15} style={{ marginTop: 2 }} />
                <span>OAuth needs a GitHub OAuth app. Set <code>GITHUB_OAUTH_CLIENT_ID</code> on the Dockhand server and restart, or use a token instead.</span>
              </Callout>
            ) : (
              <span className="field-hint">You&apos;ll get a one-time code to approve on GitHub — no redirect URL needed.</span>
            )
          )}
          {method === "app" && (
            gh?.appConfigured ? (
              <span className="field-hint">Opens GitHub in a new tab to install the Dockhand app on the account or org. When you&apos;re done, GitHub sends you back to Dockhand and the connection appears here.</span>
            ) : (
              <Callout kind="warn">
                <Icon name="alert" size={15} style={{ marginTop: 2 }} />
                <span>
                  The GitHub App isn&apos;t configured. Set <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code> and <code>GITHUB_APP_SLUG</code> on the Dockhand server and restart, or connect with a token.
                </span>
              </Callout>
            )
          )}
          {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
          <Actions style={{ marginTop: 4 }}>
            <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy || !!methodBlocked || (method !== "pat" && !gh)}>
              {busy && <span className="spinner" />}
              {nextLabel}
            </button>
          </Actions>
        </form>
      )}

      {step === 0 && device && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, alignItems: "stretch" }}>
          <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>Enter this code on GitHub to authorize Dockhand:</span>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "18px 16px", borderRadius: 16, background: "var(--fill-1)" }}>
            <span className="mono" style={{ fontSize: 30, fontWeight: 600, letterSpacing: "0.12em", userSelect: "all" }}>{device.userCode}</span>
            <button
              type="button"
              className="btn2 sm"
              onClick={() => {
                copyText(device.userCode);
                toast({ kind: "ok", title: "Code copied" });
              }}
            >
              <Icon name="copy" size={13} />
              Copy
            </button>
          </div>
          <a className="btn" href={device.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--btn-ink)" }}>
            Open {device.verificationUri.replace(/^https?:\/\//, "")} ↗
          </a>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12.5, color: "var(--ink-3)" }}>
            <span className="spinner" style={{ width: 12, height: 12 }} />
            Waiting for you to approve on GitHub…
          </span>
          <Actions>
            <button type="button" className="btn2 lg" onClick={() => setDevice(null)}>Back</button>
          </Actions>
        </div>
      )}

      {step === 0 && waitingApp && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Callout kind="info">
            <Icon name="external" size={15} color="#2f6fed" style={{ marginTop: 2 }} />
            <span>Finish installing the app in the GitHub tab. GitHub redirects back to Dockhand&apos;s callback, which stores the installation — this dialog continues automatically.</span>
          </Callout>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12.5, color: "var(--ink-3)" }}>
            <span className="spinner" style={{ width: 12, height: 12 }} />
            Waiting for the installation…
          </span>
          <Actions>
            <button type="button" className="btn2 lg" onClick={() => setWaitingApp(false)}>Back</button>
            {gh?.appInstallUrl && (
              <a className="btn" href={gh.appInstallUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--btn-ink)" }}>
                Open GitHub again ↗
              </a>
            )}
          </Actions>
        </div>
      )}

      {step === 1 && account && (
        <AccessStep account={account} access={access} setAccess={setAccess} picked={picked} setPicked={setPicked} webhook={webhook} setWebhook={setWebhook} busy={busy} onFinish={finish} onSkip={onClose} />
      )}

      {step === 2 && account && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { title: `Connected @${account.login}`, sub: `${account.method === "pat" ? "token" : account.method === "oauth" ? "oauth" : "github app"} · ${account.kind === "user" ? "personal" : account.kind}${account.serverUrl ? ` · ${account.serverUrl}` : ""}` },
            { title: account.repoAccess === "all" ? "All repositories" : `${account.selectedRepos.length} selected repositor${account.selectedRepos.length === 1 ? "y" : "ies"}`, sub: account.status === "syncing" ? "syncing repositories…" : `${account.repoCount} repos · ${account.composeRepoCount} with compose` },
            { title: account.webhook ? "Webhooks installed" : "Webhooks off", sub: account.webhook ? "pushes trigger auto-deploy on stacks that opt in" : "you can enable auto-deploy per stack later" },
          ].map((d) => (
            <div key={d.title} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", animation: "rise .3s ease both" }}>
              <span style={{ width: 26, height: 26, borderRadius: "50%", background: "#22a06b", color: "#fff", display: "grid", placeItems: "center", flex: "none" }}>
                <Icon name="check" size={14} strokeWidth={2.6} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{d.title}</span>
                <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>{d.sub}</span>
              </span>
            </div>
          ))}
          <Actions style={{ marginTop: 6 }}>
            <button type="button" className="btn2 lg" onClick={onClose}>Done</button>
            <button
              type="button"
              className="btn"
              autoFocus
              onClick={() => {
                onClose();
                router.push("/deploy?mode=git");
              }}
            >
              Deploy something
            </button>
          </Actions>
        </div>
      )}
    </Dialog>
  );
}

function AccessStep({ account, access, setAccess, picked, setPicked, webhook, setWebhook, busy, onFinish, onSkip }: { account: GitAccount; access: "all" | "selected"; setAccess: (v: "all" | "selected") => void; picked: string[]; setPicked: (v: string[]) => void; webhook: boolean; setWebhook: (v: boolean) => void; busy: boolean; onFinish: () => void; onSkip: () => void }) {
  const repos = useApi<Repo[]>(`/api/github/account-repos?accountId=${encodeURIComponent(account.id)}`);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)" }}>
        <span style={{ width: 36, height: 36, borderRadius: "50%", background: account.color ? `linear-gradient(145deg, ${account.color}, #2f6fed)` : "linear-gradient(145deg,#7a5cf0,#2f6fed)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, flex: "none" }}>
          {(account.login[0] ?? "?").toUpperCase()}
        </span>
        <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700 }}>@{account.login}</span>
          <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Authorized · read-only · revocable from GitHub</span>
        </span>
        <span style={{ display: "flex", color: "#22a06b" }}><Icon name="check" size={16} strokeWidth={2.4} /></span>
      </div>
      <Group label="Repository access">
        <Seg<"all" | "selected">
          fit
          value={access}
          onChange={setAccess}
          options={[
            { value: "all", label: "All repositories" },
            { value: "selected", label: "Only select" },
          ]}
        />
      </Group>
      {access === "selected" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto", paddingRight: 4 }}>
          {!repos.data && !repos.error && [0, 1, 2, 3].map((i) => <Skel key={i} h={48} r={14} />)}
          {repos.error && <span style={{ fontSize: 12.5, color: "var(--crit-ink)" }}>Couldn&apos;t list repositories: {errMsg(repos.error)}</span>}
          {repos.data?.length === 0 && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No repositories visible to this account.</span>}
          {repos.data?.map((r) => {
            const on = picked.includes(r.fullName);
            return (
              <button key={r.fullName} type="button" onClick={() => setPicked(on ? picked.filter((x) => x !== r.fullName) : [...picked, r.fullName])} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", borderRadius: 14, background: on ? "rgba(47,111,237,.08)" : "var(--fill-1)", border: `1px solid ${on ? "rgba(47,111,237,.45)" : "transparent"}`, cursor: "pointer", textAlign: "left", color: "var(--ink)", flex: "none" }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, border: `1.5px solid ${on ? "var(--blue)" : "var(--line-3)"}`, background: on ? "var(--blue)" : "transparent", display: "grid", placeItems: "center", flex: "none", color: "#fff" }}>
                  {on && <Icon name="check" size={11} strokeWidth={3} />}
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                  <span className="ellipsis" style={{ fontSize: 13, fontWeight: 700 }}>{r.name}</span>
                  <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{r.owner} · {r.private ? "private" : "public"}{r.defaultBranch ? ` · ${r.defaultBranch}` : ""}</span>
                </span>
                {r.composeFiles.length > 0 && <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: 7, background: "rgba(47,111,237,.1)", color: "#2f6fed", whiteSpace: "nowrap" }}>compose</span>}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>Install webhook for auto-deploy</span>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Dockhand adds one webhook per selected repo</span>
        </span>
        <Toggle on={webhook} onChange={setWebhook} />
      </div>
      <Actions style={{ marginTop: 4 }}>
        <button type="button" className="btn2 lg" onClick={onSkip} disabled={busy} title="Keep the defaults — change access later in Settings → GitHub">
          Skip for now
        </button>
        <button type="button" className="btn" onClick={onFinish} disabled={busy || (access === "selected" && picked.length === 0)}>
          {busy && <span className="spinner" />}
          Finish
        </button>
      </Actions>
    </div>
  );
}
