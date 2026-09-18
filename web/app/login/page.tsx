"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import { Toggle, copyText } from "@/components/ui";
import { errMsg, invalidate, post, useApi } from "@/lib/api";
import type { AuthState, User } from "@/lib/types";

export default function LoginPage() {
  const router = useRouter();
  const { data: state } = useApi<AuthState>("/api/auth/state", { revalidateOnFocus: false });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [setupNote, setSetupNote] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!state) return;
    if (state.setupRequired) router.replace("/setup");
    else if (state.user) router.replace("/");
  }, [state, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!username.trim() || !password) return setErr("Enter your username and password.");
    setBusy(true);
    try {
      await post<User>("/api/auth/login", { username: username.trim(), password, remember });
      await invalidate("/api/auth/state");
      router.replace("/");
    } catch (e2) {
      setErr(errMsg(e2) || "Sign-in failed.");
      setBusy(false);
    }
  };

  const resetCmd = `docker compose exec api dockhand reset-password ${username.trim() || "<user>"}`;

  return (
    <AuthCard width={400} gap={24} title="Welcome back" sub="Sign in to Dockhand">
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label className="field">
            Username
            <span className="input-wrap">
              <span className="input-icon"><Icon name="user" size={16} /></span>
              <input className="input lg with-icon" type="text" autoComplete="username" autoCapitalize="off" spellCheck={false} autoFocus placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </span>
          </label>
          <label className="field">
            Password
            <span className="input-wrap">
              <span className="input-icon"><Icon name="lock" size={16} /></span>
              <input className="input lg with-icon" type="password" autoComplete="current-password" placeholder="••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
            </span>
          </label>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, color: "var(--ink-2)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Toggle small on={remember} onChange={setRemember} />
              Stay signed in
            </span>
            <button type="button" className="btn-link" style={{ fontSize: 12.5 }} onClick={() => setForgot(!forgot)}>Forgot password?</button>
          </div>
          {forgot && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5, animation: "rise .25s ease both" }}>
              Reset it from the machine running Dockhand:
              <span style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                <code className="term-block" style={{ flex: 1, padding: "8px 10px", fontSize: 11 }}>{resetCmd}</code>
                <button
                  type="button"
                  className="btn2 sm"
                  style={{ height: "auto" }}
                  onClick={() =>
                    copyText(resetCmd).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    })
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </div>
          )}
          {err && <FormError>{err}</FormError>}
          <button type="submit" className="btn lg" style={{ marginTop: 4 }} disabled={busy}>
            {busy && <span className="spinner" />}
            Sign in
          </button>
        </form>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--ink-3)", display: "flex", justifyContent: "center", gap: 6, alignItems: "center" }}>
            First time here?
            <button
              type="button"
              className="btn-link"
              style={{ fontSize: 12.5 }}
              onClick={() => (state?.setupRequired ? router.push("/setup") : setSetupNote(!setupNote))}
            >
              Set up Dockhand
            </button>
          </div>
          {setupNote && (
            <span style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center", lineHeight: 1.5, animation: "rise .25s ease both" }}>
              This Dockhand is already set up. Sign in with the admin account created during setup — or reset its password with the command under “Forgot password?”.
            </span>
          )}
        </div>
    </AuthCard>
  );
}
