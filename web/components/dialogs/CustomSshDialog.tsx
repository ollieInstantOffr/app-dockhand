"use client";

import { useState } from "react";
import { Dialog, DialogHeader, Seg } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { useApi } from "@/lib/api";
import type { SshKeyInfo } from "@/lib/types";
import { forgetHostKey, forgetRecentSsh, knownHostKey, parseDest, recentSsh, rememberSsh, sshDest, type CustomSshConn, type SshAuth, type SshRecent } from "@/lib/customSsh";
import { Actions, Field, Group } from "./common";

/** "Custom SSH": open a terminal to any address, not just a Dockhand host. */
export function CustomSshDialog({ onClose }: { onClose: () => void }) {
  const { openTerminal } = useShell();
  const key = useApi<SshKeyInfo>("/api/ssh-key");
  const [recent, setRecent] = useState<SshRecent[]>(() => recentSsh());
  const first = recent[0];
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState(first?.user ?? "root");
  const [auth, setAuth] = useState<SshAuth>("key");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [err, setErr] = useState("");
  const [, setTick] = useState(0);

  const portNum = Number(port) || 22;
  const known = address.trim() ? knownHostKey({ address: address.trim(), port: portNum }) : "";

  // "user@host:port" or "ssh user@host -p 22" in the address field fills every field (on paste, blur or connect).
  const splitAddress = (v: string): { address: string; user: string; port: number } => {
    const t = v.trim();
    const d = /[@\s]/.test(t) || /^[^:]+:\d+$/.test(t) || /^\[.+\]:\d+$/.test(t) ? parseDest(t) : { address: t };
    const out = { address: d.address ?? "", user: d.user ?? user, port: d.port ?? (Number(port) || 22) };
    setAddress(out.address);
    setUser(out.user);
    setPort(String(out.port));
    return out;
  };

  const pick = (r: SshRecent) => {
    setAddress(r.address);
    setPort(String(r.port || 22));
    setUser(r.user);
    setAuth(r.auth);
    setErr("");
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    const d = splitAddress(address);
    const a = d.address;
    if (!a) return setErr("Enter an address.");
    if (!/^[a-zA-Z0-9._:%\-[\]]+$/.test(a)) return setErr("That doesn't look like a hostname or IP address.");
    if (!d.user.trim()) return setErr("Enter a user.");
    if (!(d.port > 0 && d.port < 65536)) return setErr("Port must be 1–65535.");
    if (auth === "password" && !password) return setErr("Enter the password.");
    if (auth === "privateKey" && !privateKey.trim()) return setErr("Paste a private key.");
    const conn: CustomSshConn = { address: a, port: d.port, user: d.user.trim(), auth };
    if (auth === "password") conn.password = password;
    if (auth === "privateKey") {
      conn.privateKey = privateKey;
      conn.passphrase = passphrase;
    }
    rememberSsh(conn);
    openTerminal({ kind: "ssh", id: `ssh-${Date.now().toString(36)}`, conn });
    onClose();
  };

  return (
    <Dialog onClose={onClose} width={520}>
      <DialogHeader icon="terminal" title="Custom SSH" sub="Open a terminal to any SSH server" onClose={onClose} />
      <form onSubmit={connect} style={{ display: "flex", flexDirection: "column", gap: 14 }} autoComplete="off">
        {recent.length > 0 && (
          <Group label="Recent">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {recent.map((r) => (
                <span key={sshDest(r)} className="chip mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "0 4px 0 10px", height: 28, borderRadius: 9, background: "var(--fill-1)", fontSize: 12 }}>
                  <button type="button" onClick={() => pick(r)} style={{ border: 0, background: "transparent", color: "var(--ink)", cursor: "pointer", font: "inherit", padding: 0 }}>
                    {sshDest(r)}
                  </button>
                  <button
                    type="button"
                    aria-label={`Forget ${sshDest(r)}`}
                    title="Forget"
                    onClick={() => {
                      forgetRecentSsh(r);
                      setRecent(recentSsh());
                    }}
                    style={{ border: 0, background: "transparent", color: "var(--ink-3)", cursor: "pointer", display: "grid", placeItems: "center", width: 20, height: 20, padding: 0 }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          </Group>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px", gap: 12 }}>
          <Field label="Address" hint="Hostname or IP — or paste user@host:port">
            <input className="input mono" autoFocus value={address} onChange={(e) => setAddress(e.target.value)}
              onBlur={(e) => splitAddress(e.target.value)}
              onPaste={(e) => {
                e.preventDefault();
                splitAddress(e.clipboardData.getData("text"));
              }} placeholder="192.168.1.20" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="Port">
            <input className="input mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
          </Field>
        </div>
        <Field label="User">
          <input className="input mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" autoCapitalize="off" spellCheck={false} />
        </Field>
        <Group label="Authentication">
          <Seg<SshAuth>
            value={auth}
            onChange={setAuth}
            options={[
              { value: "key", label: "Dockhand key" },
              { value: "password", label: "Password" },
              { value: "privateKey", label: "Private key" },
            ]}
          />
          {auth === "key" && (
            <span className="field-hint">
              Dockhand&apos;s public key must be in <span className="mono">~/.ssh/authorized_keys</span> for this user.
              {key.data?.publicKey && (
                <span className="mono" style={{ display: "block", marginTop: 6, padding: "6px 8px", borderRadius: 8, background: "var(--fill-1)", fontSize: 11, wordBreak: "break-all", userSelect: "all" }}>
                  {key.data.publicKey}
                </span>
              )}
            </span>
          )}
        </Group>
        {auth === "password" && (
          <Field label="Password" hint="Sent once to open the session; never stored.">
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        {auth === "privateKey" && (
          <>
            <Field label="Private key" hint="OpenSSH or PEM. Used for this session only; never stored.">
              <textarea className="input mono" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={5} spellCheck={false} style={{ height: "auto", padding: "10px 12px", fontSize: 11.5, resize: "vertical" }} />
            </Field>
            <Field label={<span>Passphrase <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· if the key is encrypted</span></span>}>
              <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
            </Field>
          </>
        )}
        {known && (
          <span className="field-hint" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Icon name="lock" size={12} />
            Saved host key <span className="mono">{known}</span>
            <button
              type="button"
              className="link"
              onClick={() => {
                forgetHostKey({ address: address.trim(), port: portNum });
                setTick((n) => n + 1);
              }}
              style={{ border: 0, background: "transparent", color: "var(--accent-ink, #2f6fed)", cursor: "pointer", padding: 0, fontSize: "inherit", fontWeight: 600 }}
            >
              Forget
            </button>
          </span>
        )}
        {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
        <Actions style={{ marginTop: 4 }}>
          <button type="button" className="btn2 lg" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn">
            <Icon name="terminal" size={14} strokeWidth={2.2} />
            Connect
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}
