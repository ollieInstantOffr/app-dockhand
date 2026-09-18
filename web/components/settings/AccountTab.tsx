"use client";

import { useEffect, useState } from "react";
import { Seg } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { del, errMsg, invalidate, patch, post, useApi } from "@/lib/api";
import { ago, initial, since } from "@/lib/format";
import type { Account, SessionInfo, Theme, User } from "@/lib/types";
import { cardStyle, rowStyle, twoCol } from "./common";

export function AccountTab() {
  const shell = useShell();
  const { data, mutate } = useApi<Account>("/api/account");
  const user = data?.user ?? shell.user;
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    setName(data.user.name);
    setUsername(data.user.username);
  }, [data?.user.name, data?.user.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    const body: Record<string, string> = {};
    if (name.trim() !== user.name) body.name = name.trim();
    if (username.trim() !== user.username) body.username = username.trim();
    if (!name.trim()) return setErr("Your name can't be empty.");
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username.trim())) return setErr("Usernames are 2–32 letters, numbers, dots, dashes or underscores.");
    if (next || cur) {
      if (!cur) return setErr("Enter your current password to set a new one.");
      if (next.length < 12) return setErr("The new password needs at least 12 characters.");
      body.currentPassword = cur;
      body.newPassword = next;
    }
    if (!Object.keys(body).length) {
      shell.toast({ kind: "info", title: "Nothing to save" });
      return;
    }
    setBusy(true);
    try {
      const u = await patch<User>("/api/account", body);
      shell.setUser(u);
      setCur("");
      setNext("");
      mutate();
      invalidate("/api/auth/state");
      shell.toast({ kind: "ok", title: "Account saved", text: body.newPassword ? "Password changed. Other sessions stay signed in until you revoke them." : undefined });
    } catch (e2) {
      setErr(errMsg(e2));
    } finally {
      setBusy(false);
    }
  };

  const joined = new Date(user.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  const role = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : "Administrator";

  return (
    <div style={twoCol(360)}>
      <form className="glass-card" style={cardStyle(14)} onSubmit={save}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ width: 52, height: 52, borderRadius: 16, background: "linear-gradient(145deg,#7a5cf0,#2f6fed)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 20, flex: "none" }}>{initial(user.name || user.username)}</span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span className="ellipsis" style={{ fontSize: 17, fontWeight: 700 }}>{user.name || user.username}</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{role === "Admin" ? "Administrator" : role} · joined {joined}</span>
          </span>
        </div>
        <label className="field">
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="field">
          Username
          <input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} />
        </label>
        <div className="field">
          Appearance
          <Seg<Theme> options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }]} value={shell.theme} onChange={shell.setTheme} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          <label className="field">
            Current password
            <input className="input" type="password" placeholder="••••••••" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="field">
            New password
            <input className="input" type="password" placeholder="at least 12 characters" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        {err && <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", fontSize: 12.5, color: "var(--crit-ink)" }}>{err}</div>}
        <button type="submit" className="btn" style={{ alignSelf: "flex-start", fontWeight: 600 }} disabled={busy}>
          {busy && <span className="spinner" />}
          Save changes
        </button>
      </form>
      <SessionsCard sessions={data?.sessions} onChange={() => mutate()} />
    </div>
  );
}

function SessionsCard({ sessions, onChange }: { sessions?: SessionInfo[]; onChange: () => void }) {
  const shell = useShell();
  const [out, setOut] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const revoke = async (s: SessionInfo) => {
    const ok = await shell.confirm({ title: "Revoke this session?", text: `${s.device} will be signed out the next time it talks to Dockhand.`, confirmLabel: "Revoke", danger: true, icon: "logout", details: [{ k: "IP", v: s.ip }, { k: "Last active", v: ago(s.lastSeenAt) }] });
    if (!ok) return;
    setRevoking(s.id);
    try {
      await del(`/api/account/sessions/${s.id}`);
      shell.toast({ kind: "ok", title: "Session revoked", text: s.device });
      onChange();
    } catch (e) {
      shell.toast({ kind: "error", title: "Couldn't revoke session", text: errMsg(e) });
    } finally {
      setRevoking(null);
    }
  };

  const signOut = async () => {
    setOut(true);
    try {
      await post("/api/auth/logout");
    } catch {
      /* the cookie is cleared either way */
    }
    window.location.href = "/login";
  };

  const sorted = [...(sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || +new Date(b.lastSeenAt) - +new Date(a.lastSeenAt));

  return (
    <div className="glass-card" style={cardStyle(12)}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>Sessions</div>
      {!sessions && [0, 1].map((i) => <span key={i} className="skel" style={{ height: 58, borderRadius: 14 }} />)}
      {sessions && !sorted.length && <span style={{ fontSize: 13, color: "var(--ink-3)" }}>No active sessions.</span>}
      {sorted.map((s) => (
        <div key={s.id} style={rowStyle()}>
          <span className="dot" title={s.current ? "This device" : undefined} style={{ background: s.current ? "#22a06b" : since(s.lastSeenAt) < 86400 ? "#2f6fed" : "var(--muted)", flex: "none" }} />
          <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
            <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>
              {s.device || "Unknown device"}
              {s.current && <span style={{ fontWeight: 500, color: "var(--ink-3)" }}> · this device</span>}
            </span>
            <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {s.ip} · {s.current ? "active now" : `active ${ago(s.lastSeenAt)}`}
            </span>
          </span>
          {s.current ? (
            <button type="button" className="btn2 sm" onClick={signOut} disabled={out}>Sign out</button>
          ) : (
            <button type="button" className="btn2 sm" onClick={() => revoke(s)} disabled={revoking === s.id}>
              {revoking === s.id && <span className="spinner" style={{ width: 11, height: 11 }} />}
              Revoke
            </button>
          )}
        </div>
      ))}
      <button type="button" className="btn2 danger" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={signOut} disabled={out}>
        {out && <span className="spinner" style={{ width: 12, height: 12 }} />}
        Sign out
      </button>
    </div>
  );
}
