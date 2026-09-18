"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { Avatar, KeyCallout, ProgressList, Seg, copyText, shortKey } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post, useApi } from "@/lib/api";
import { AVATAR_COLORS, hostStatusColor, plural } from "@/lib/format";
import type { Host, HostInput, HostTestResult, JobStep, SshKeyInfo } from "@/lib/types";
import { cardStyle, twoCol } from "./common";
import { parseSshConfig, pendingSteps, resultSteps } from "./hosts-lib";

type Method = HostInput["method"];

const emptyForm = { name: "", address: "", port: "22", user: "", password: "" };

export function HostsTab() {
  const { data: hosts } = useApi<Host[]>("/api/hosts");
  return (
    <div style={{ ...twoCol(360), alignItems: "start" }}>
      <AddHostCard hosts={hosts ?? []} />
      <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
        <ConnectedHosts hosts={hosts} />
        <ImportSshConfig hosts={hosts ?? []} />
      </div>
    </div>
  );
}

function AddHostCard({ hosts }: { hosts: Host[] }) {
  const shell = useShell();
  const { data: key } = useApi<SshKeyInfo>("/api/ssh-key");
  const [method, setMethod] = useState<Method>("key");
  const [f, setF] = useState(emptyForm);
  const [steps, setSteps] = useState<JobStep[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const input = (): HostInput => ({
    name: f.name.trim() || (method === "local" ? "local" : f.address.trim()),
    address: method === "local" ? "unix:///var/run/docker.sock" : f.address.trim(),
    port: method === "local" ? 0 : parseInt(f.port, 10) || 22,
    user: method === "local" ? "" : f.user.trim() || "root",
    method,
    ...(method === "password" ? { password: f.password } : {}),
    color: AVATAR_COLORS[hosts.length % AVATAR_COLORS.length],
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (method !== "local" && !f.address.trim()) return setErr("Enter the host's address.");
    if (method === "password" && !f.password) return setErr("Enter the SSH password, or switch to key authentication.");
    const body = input();
    if (hosts.some((h) => h.name.toLowerCase() === body.name.toLowerCase())) return setErr(`A host called “${body.name}” already exists.`);
    // Hand over to the host wizard, which runs the connection test and saves the host.
    shell.openDialog({ type: "host", prefill: body });
    setF(emptyForm);
  };

  return (
    <form className="glass-card" style={cardStyle(18, 26)} onSubmit={submit}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>Add a host</h1>
        <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>Point Dockhand at any machine running Docker. Nothing to install — we connect over SSH.</p>
      </div>
      <Seg<Method>
        size="lg"
        options={[{ value: "key", label: "SSH key" }, { value: "password", label: "Password" }, { value: "local", label: "Local socket" }]}
        value={method}
        onChange={(v) => {
          setMethod(v);
          setErr("");
          setSteps(null);
        }}
      />
      <label className="field">
        Name
        <input className="input" placeholder={method === "local" ? "e.g. this-machine" : "e.g. homelab-01"} value={f.name} onChange={set("name")} />
      </label>
      {method === "local" ? (
        <div style={{ display: "flex", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          <span style={{ display: "flex", color: "var(--ink-3)", marginTop: 1 }}><Icon name="box" size={16} /></span>
          <span>
            Talks to Docker on the machine Dockhand runs on through <code className="mono" style={{ fontSize: 11.5 }}>/var/run/docker.sock</code>. Mount the socket into the Dockhand container for this to work.
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 100px", gap: 10 }}>
            <label className="field">
              Address
              <input className="input mono" placeholder="10.0.0.12 or host.tail-net.ts" value={f.address} onChange={set("address")} style={{ fontSize: 14 }} />
            </label>
            <label className="field">
              Port
              <input className="input mono" inputMode="numeric" value={f.port} onChange={set("port")} style={{ fontSize: 14 }} />
            </label>
          </div>
          <label className="field">
            User
            <input className="input mono" placeholder="root" value={f.user} onChange={set("user")} style={{ fontSize: 14 }} autoCapitalize="off" />
          </label>
          {method === "key" ? (
            <div className="field">
              Authentication
              <KeyCallout
                title="Dockhand's SSH key"
                value={key ? shortKey(key.publicKey) : ""}
                onCopy={() => key && copyText(key.publicKey).then(() => shell.toast({ kind: "ok", title: "Public key copied", text: "Paste it into ~/.ssh/authorized_keys on the host." }))}
              />
              <span className="field-hint">
                Add this key to <code className="mono">~/.ssh/authorized_keys</code> on the host, or switch to password.
              </span>
            </div>
          ) : (
            <label className="field">
              Password
              <input className="input" type="password" placeholder="SSH password" value={f.password} onChange={set("password")} autoComplete="new-password" />
              <span className="field-hint">Stored encrypted. Keys are safer — Dockhand can install its key for you after connecting.</span>
            </label>
          )}
        </>
      )}
      {steps && (
        <div style={{ padding: 6, borderRadius: 14, background: "var(--fill-1)" }}>
          <ProgressList steps={steps} />
        </div>
      )}
      {err && (
        <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", fontSize: 12.5, color: "var(--crit-ink)", lineHeight: 1.5 }}>{err}</div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
        <button type="submit" className="btn" disabled={busy} style={{ fontWeight: 600 }}>
          {busy && <span className="spinner" />}
          {busy ? "Testing…" : "Test & connect"}
        </button>
        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Takes about 5 seconds</span>
      </div>
    </form>
  );
}

function ConnectedHosts({ hosts }: { hosts?: Host[] }) {
  const shell = useShell();
  return (
    <div className="glass-card" style={cardStyle(12, "22px 24px")}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>Connected hosts</span>
        {hosts && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{plural(hosts.length, "host")}</span>}
      </div>
      {!hosts && [0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 54, borderRadius: 14 }} />)}
      {hosts && !hosts.length && <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>No hosts yet. Add your first one on the left — it takes a few seconds.</span>}
      {hosts?.map((h) => (
        <div key={h.id} className="row-item hover" style={{ padding: "10px 12px" }}>
          <Avatar name={h.name} color={h.color} size={32} radius={10} fontSize={13} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>{h.name}</span>
            <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {h.method === "local" ? "local socket" : `${h.address} · ssh`}
              {h.os ? ` · ${h.os}` : ""}
            </span>
          </span>
          <span className="dot" title={h.status} style={{ background: hostStatusColor(h.status) }} />
          <button type="button" className="btn2 sm set-outline" onClick={() => shell.openDialog({ type: "host", hostId: h.id })}>Edit</button>
        </div>
      ))}
    </div>
  );
}

function ImportSshConfig({ hosts }: { hosts: Host[] }) {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const entries = useMemo(() => parseSshConfig(text), [text]);
  const existing = new Set(hosts.map((h) => h.name.toLowerCase()));
  const fresh = entries.filter((e) => !existing.has(e.name.toLowerCase()));

  const run = async () => {
    setBusy(true);
    const ok: string[] = [];
    const failed: string[] = [];
    let i = hosts.length;
    for (const e of fresh) {
      try {
        await post<Host>("/api/hosts", { name: e.name, address: e.address, port: e.port, user: e.user, method: "key", color: AVATAR_COLORS[i++ % AVATAR_COLORS.length] } satisfies HostInput);
        ok.push(e.name);
      } catch (err) {
        failed.push(`${e.name}: ${errMsg(err)}`);
      }
    }
    setBusy(false);
    invalidate("/api/hosts");
    invalidate("/api/overview");
    if (ok.length) shell.toast({ kind: failed.length ? "warn" : "ok", title: `Imported ${plural(ok.length, "host")}`, text: failed.length ? `${failed.length} failed — ${failed[0]}` : "Add Dockhand's key to each host so it can connect." });
    else shell.toast({ kind: "error", title: "Nothing imported", text: failed[0] ?? "No new hosts found." });
    if (ok.length) {
      setText("");
      setOpen(false);
    }
  };

  return (
    <div className="glass-card" style={cardStyle(12, "22px 24px")}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Import from SSH config</span>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Paste your <code className="mono">~/.ssh/config</code> to add many hosts at once.</span>
        </span>
        <button type="button" className="btn2 sm" onClick={() => setOpen(!open)}>{open ? "Cancel" : "Paste config"}</button>
      </div>
      {open && (
        <>
          <textarea
            className="input mono"
            rows={8}
            autoFocus
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Host nas\n  HostName 10.0.0.12\n  User robin\n\nHost pi\n  HostName pi.tail-net.ts\n  Port 2222"}
            style={{ fontSize: 12, minHeight: 150 }}
          />
          {entries.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflow: "auto" }}>
              {entries.map((e) => {
                const dup = existing.has(e.name.toLowerCase());
                return (
                  <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, padding: "6px 10px", borderRadius: 10, background: "var(--fill-1)", opacity: dup ? 0.55 : 1 }}>
                    <span style={{ fontWeight: 700 }}>{e.name}</span>
                    <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)", flex: 1, minWidth: 0 }}>{e.user}@{e.address}:{e.port}</span>
                    {dup && <span className="tag muted" style={{ fontSize: 10 }}>exists</span>}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" className="btn sm" disabled={busy || !fresh.length} onClick={run}>
              {busy && <span className="spinner" />}
              {fresh.length ? `Import ${plural(fresh.length, "host")}` : "Import"}
            </button>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{text && !entries.length ? "No concrete Host entries found (wildcards are skipped)." : "Wildcard entries are skipped. Hosts use Dockhand's SSH key."}</span>
          </div>
        </>
      )}
    </div>
  );
}
