"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";
import { AuthCard, FormError } from "@/components/auth/AuthCard";
import { KeyCallout, ProgressList, Stepper, copyText, shortKey } from "@/components/ui";
import { pendingSteps, resultSteps } from "@/components/settings/hosts-lib";
import { errMsg, get, post, useApi } from "@/lib/api";
import { AVATAR_COLORS } from "@/lib/format";
import type { AuthState, Host, HostInput, HostTestResult, JobStep, SshKeyInfo, User } from "@/lib/types";

const STEPS = ["Account", "First host", "Done"];
const TITLES = [
  { title: "Welcome to Dockhand", sub: "Create the admin account to get started." },
  { title: "Add your first host", sub: "Point Dockhand at any machine running Docker." },
  { title: "You're all set", sub: "Dockhand is ready. Here's what we set up." },
];

/** 0–4 from length and character classes. */
function strength(pw: string): number {
  if (!pw) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (classes >= 2 && pw.length >= 10) s++;
  if ((classes >= 3 && pw.length >= 14) || pw.length >= 20) s++;
  return Math.max(1, s);
}
const STRENGTH = [
  { label: "", color: "var(--line-2)" },
  { label: "Weak", color: "#e2504c" },
  { label: "Fair", color: "#e0a020" },
  { label: "Good", color: "#22a06b" },
  { label: "Strong", color: "#22a06b" },
];

function IconInput({ icon, mono, ...rest }: { icon: IconName; mono?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="input-wrap">
      <span className="input-icon"><Icon name={icon} size={16} /></span>
      <input className={`input lg with-icon ${mono ? "mono" : ""}`} style={mono ? { fontSize: 14 } : undefined} {...rest} />
    </span>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const { data: state } = useApi<AuthState>("/api/auth/state", { revalidateOnFocus: false, revalidateIfStale: false });
  const [step, setStep] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [host, setHost] = useState<Host | null>(null);
  const checked = useRef(false);

  // Decide once, on first load, whether onboarding applies at all.
  useEffect(() => {
    if (!state || checked.current) return;
    checked.current = true;
    if (!state.setupRequired) router.replace(state.user ? "/" : "/login");
  }, [state, router]);

  if (!state || (!state.setupRequired && !user)) return null;

  return (
    <AuthCard width={540} gap={26} title={TITLES[step].title} sub={TITLES[step].sub}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Stepper steps={STEPS} current={step} />
      </div>
      {step === 0 && (
        <AccountStep
          onDone={(u) => {
            setUser(u);
            setStep(1);
          }}
        />
      )}
      {step === 1 && (
        <HostStep
          onDone={(h) => {
            setHost(h);
            setStep(2);
          }}
        />
      )}
      {step === 2 && <DoneStep user={user} host={host} onOpen={() => (window.location.href = "/")} />}
    </AuthCard>
  );
}

function AccountStep({ onDone }: { onDone: (u: User) => void }) {
  const [f, setF] = useState({ name: "", username: "", password: "", confirm: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: e.target.value });
    setErr("");
  };
  const score = strength(f.password);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) return setErr("Tell us your name.");
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(f.username.trim())) return setErr("Usernames are 2–32 letters, numbers, dots, dashes or underscores.");
    if (f.password.length < 12) return setErr("Use at least 12 characters for the password.");
    if (f.password !== f.confirm) return setErr("The passwords don't match.");
    setBusy(true);
    try {
      const u = await post<User>("/api/auth/setup", { name: f.name.trim(), username: f.username.trim(), password: f.password });
      onDone(u);
    } catch (e2) {
      setErr(errMsg(e2));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label className="field">
        Your name
        <IconInput icon="user" type="text" autoComplete="name" autoFocus placeholder="Your full name" value={f.name} onChange={set("name")} />
      </label>
      <label className="field">
        Username
        <IconInput icon="user" type="text" autoComplete="username" autoCapitalize="off" spellCheck={false} placeholder="e.g. admin" value={f.username} onChange={set("username")} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
        <label className="field">
          Password
          <IconInput icon="lock" type="password" autoComplete="new-password" placeholder="at least 12 characters" value={f.password} onChange={set("password")} />
        </label>
        <label className="field">
          Confirm
          <IconInput icon="lock" type="password" autoComplete="new-password" placeholder="repeat it" value={f.confirm} onChange={set("confirm")} />
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--ink-3)" }}>
        <span style={{ flex: 1, height: 4, display: "flex", gap: 3 }}>
          {[1, 2, 3, 4].map((i) => (
            <span key={i} style={{ flex: 1, borderRadius: 2, background: i <= score ? STRENGTH[score].color : "var(--line-2)", transition: "background .2s" }} />
          ))}
        </span>
        <span style={{ minWidth: 42, textAlign: "right", color: score ? STRENGTH[score].color : undefined, fontWeight: score ? 600 : 400 }}>{f.password ? STRENGTH[score].label : "—"}</span>
      </div>
      {err && <FormError>{err}</FormError>}
      <button type="submit" className="btn lg" style={{ marginTop: 6 }} disabled={busy}>
        {busy && <span className="spinner" />}
        Create admin account
      </button>
      <span style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center", lineHeight: 1.5 }}>This is the only account for now. You can invite others later from Settings.</span>
    </form>
  );
}

function HostStep({ onDone }: { onDone: (h: Host | null) => void }) {
  const { data: key } = useApi<SshKeyInfo>("/api/ssh-key");
  const [f, setF] = useState({ name: "", address: "", port: "22", user: "" });
  const [steps, setSteps] = useState<JobStep[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: e.target.value });
    setErr("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.address.trim()) return setErr("Enter the host's address.");
    const body: HostInput = { name: f.name.trim() || f.address.trim(), address: f.address.trim(), port: parseInt(f.port, 10) || 22, user: f.user.trim() || "root", method: "key", color: AVATAR_COLORS[0] };
    setBusy(true);
    setErr("");
    setSteps(pendingSteps("key"));
    try {
      const r = await post<HostTestResult>("/api/hosts/test", body);
      setSteps(resultSteps(r));
      if (!r.ok) {
        setErr(r.error || "The connection test failed. Check the address and that the key is in authorized_keys.");
        setBusy(false);
        return;
      }
      const h = await post<Host>("/api/hosts", body);
      setTimeout(() => onDone(r.host ? { ...h, ...r.host, id: h.id } : h), 700);
    } catch (e2) {
      setErr(errMsg(e2));
      setSteps((s) => s?.map((x) => (x.status === "running" ? { ...x, status: "failed" } : x)) ?? null);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <label className="field">
        Host name
        <IconInput icon="server" type="text" autoFocus placeholder="e.g. nas" value={f.name} onChange={set("name")} />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px", gap: 12 }}>
        <label className="field">
          Address
          <IconInput icon="globe" mono type="text" autoCapitalize="off" spellCheck={false} placeholder="10.0.0.12" value={f.address} onChange={set("address")} />
        </label>
        <label className="field">
          Port
          <input className="input lg mono" style={{ fontSize: 14 }} inputMode="numeric" value={f.port} onChange={set("port")} />
        </label>
      </div>
      <label className="field">
        SSH user
        <IconInput icon="user" type="text" autoCapitalize="off" spellCheck={false} placeholder="root" value={f.user} onChange={set("user")} />
      </label>
      <KeyCallout
        title={copied ? "Copied — now paste it on the host" : "Dockhand's SSH key"}
        value={key ? shortKey(key.publicKey) : ""}
        onCopy={() =>
          key &&
          copyText(key.publicKey).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          })
        }
      />
      <span style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>
        Paste the key into <code className="mono">~/.ssh/authorized_keys</code> on the host. Dockhand only ever connects over SSH — nothing to install.
      </span>
      {steps && (
        <div style={{ padding: 6, borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent" }}>
          <ProgressList steps={steps} />
        </div>
      )}
      {err && <FormError>{err}</FormError>}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button type="submit" className="btn lg" style={{ flex: 1 }} disabled={busy}>
          {busy && <span className="spinner" />}
          {busy ? "Testing…" : "Test & connect"}
        </button>
        <button type="button" className="btn2" style={{ height: 46, padding: "0 16px", borderRadius: 12 }} disabled={busy} onClick={() => onDone(null)}>
          Skip for now
        </button>
      </div>
    </form>
  );
}

function DoneStep({ user, host, onOpen }: { user: User | null; host: Host | null; onOpen: () => void }) {
  const [key, setKey] = useState<SshKeyInfo | null>(null);
  useEffect(() => {
    get<SshKeyInfo>("/api/ssh-key").then(setKey).catch(() => {});
  }, []);
  const items: { title: string; sub: string; ok: boolean }[] = [
    { title: "Admin account created", sub: user ? `${user.name} · ${user.username}` : "signed in", ok: true },
    host ? { title: "Host connected", sub: `${host.name} · ${host.address}${host.os ? ` · ${host.os}` : ""}`, ok: true } : { title: "No host yet", sub: "Add one any time from Settings → Hosts", ok: false },
    { title: "SSH key generated", sub: key?.fingerprint ?? "SHA256:…", ok: true },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map((d) => (
        <div key={d.title} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent" }}>
          <span style={{ width: 26, height: 26, borderRadius: "50%", background: d.ok ? "#22a06b" : "var(--fill-2)", color: d.ok ? "#fff" : "var(--ink-3)", display: "grid", placeItems: "center", flex: "none" }}>
            {d.ok ? <Icon name="check" size={14} strokeWidth={2.6} /> : <Icon name="plus" size={14} strokeWidth={2.2} />}
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{d.title}</span>
            <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>{d.sub}</span>
          </span>
        </div>
      ))}
      <button type="button" className="btn lg" style={{ marginTop: 10 }} onClick={onOpen}>Open Dockhand</button>
    </div>
  );
}
