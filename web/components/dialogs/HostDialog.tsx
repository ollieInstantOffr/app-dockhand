"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog, DialogHeader, KeyCallout, ProgressList, Seg, Stepper, copyText, shortKey } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { del, errMsg, invalidate, patch, post, useApi } from "@/lib/api";
import type { Host, HostInput, HostMethod, HostTestResult, JobStep, SshKeyInfo } from "@/lib/types";
import { Actions, Field, Group } from "./common";

const TEST_LABELS = ["Resolving address", "Opening SSH connection", "Authenticating", "Checking Docker", "Reading host info"];

type Form = { name: string; method: HostMethod; address: string; port: string; user: string; password: string };
const EMPTY: Form = { name: "", method: "key", address: "", port: "22", user: "", password: "" };

export function HostDialog({ hostId, prefill, onClose }: { hostId?: string; prefill?: HostInput; onClose: () => void }) {
  const { toast, confirm } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const editing = !!hostId;
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(() =>
    prefill
      ? { ...EMPTY, name: prefill.name, method: prefill.method, address: prefill.method === "local" ? "" : prefill.address, port: String(prefill.port || 22), user: prefill.user, password: prefill.password ?? "" }
      : EMPTY,
  );
  const [err, setErr] = useState("");
  const loaded = useRef(false);

  // test state
  const [result, setResult] = useState<HostTestResult | null>(null);
  const [shown, setShown] = useState(0);
  const [saved, setSaved] = useState<Host | null>(null);
  const [saveErr, setSaveErr] = useState("");
  const runId = useRef(0);

  const existing = useApi<Host>(hostId ? `/api/hosts/${hostId}` : null);
  const key = useApi<SshKeyInfo>("/api/ssh-key");

  useEffect(() => {
    const h = existing.data;
    if (!h || loaded.current) return;
    loaded.current = true;
    setForm({ name: h.name, method: h.method, address: h.address, port: String(h.port || 22), user: h.user, password: "" });
  }, [existing.data]);

  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const local = form.method === "local";

  const input = (): HostInput => ({
    name: form.name.trim(),
    method: form.method,
    address: local ? "" : form.address.trim(),
    port: local ? 0 : parseInt(form.port, 10) || 22,
    user: local ? "" : form.user.trim(),
    ...(form.method === "password" && form.password ? { password: form.password } : {}),
  });

  const test = async () => {
    const id = ++runId.current;
    setStep(2);
    setResult(null);
    setShown(0);
    setSaved(null);
    setSaveErr("");
    let r: HostTestResult;
    try {
      r = editing && form.method === "password" && !form.password
        ? await post<HostTestResult>(`/api/hosts/${hostId}/test`) // keep the stored password
        : await post<HostTestResult>("/api/hosts/test", input());
    } catch (e) {
      r = { ok: false, steps: [], error: errMsg(e) };
    }
    if (id !== runId.current) return;
    setResult(r);
    // reveal the steps one by one
    for (let i = 1; i <= r.steps.length; i++) {
      await new Promise((res) => setTimeout(res, 350));
      if (id !== runId.current) return;
      setShown(i);
    }
    if (!r.ok) return;
    try {
      let h: Host;
      if (editing) {
        h = await patch<Host>(`/api/hosts/${hostId}`, input());
        const t = await post<HostTestResult>(`/api/hosts/${hostId}/test`);
        if (t.host) h = t.host;
      } else {
        h = await post<Host>("/api/hosts", input());
      }
      if (id !== runId.current) return;
      setSaved(h);
      invalidate("/api/hosts");
      invalidate("/api/overview");
      invalidate("/api/uptime");
      toast({ kind: "ok", title: editing ? `${h.name} updated` : `${h.name} added`, text: "Dockhand is now watching this host." });
    } catch (e) {
      if (id === runId.current) setSaveErr(errMsg(e));
    }
  };

  // Opened from Settings → Hosts "Test & connect": skip the form and run the test.
  const autoTested = useRef(false);
  useEffect(() => {
    if (!prefill || autoTested.current) return;
    autoTested.current = true;
    void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!form.name.trim()) return setErr("Give the host a name.");
    if (!local && !form.address.trim()) return setErr("Enter the host's address.");
    if (!local && !form.user.trim()) return setErr("Enter the SSH user.");
    if (!local && !(parseInt(form.port, 10) > 0)) return setErr("Enter a valid port.");
    if (form.method === "password" && !form.password && !editing) return setErr("Enter the SSH password.");
    if (form.method === "key") setStep(1);
    else test();
  };

  const remove = async () => {
    if (!hostId) return;
    const name = existing.data?.name ?? form.name;
    const ok = await confirm({
      title: `Remove ${name}?`,
      text: "Dockhand stops monitoring this host and forgets its stacks and history. Containers on the host keep running.",
      confirmLabel: "Remove host",
      danger: true,
      icon: "trash",
      typeToConfirm: name,
    });
    if (!ok) return;
    try {
      await del(`/api/hosts/${hostId}`);
      invalidate("/api/hosts");
      invalidate("/api/overview");
      invalidate("/api/uptime");
      toast({ kind: "ok", title: `${name} removed` });
      onClose();
      if (pathname.startsWith(`/hosts/${hostId}`)) router.push("/");
    } catch (e) {
      toast({ kind: "error", title: "Couldn't remove host", text: errMsg(e) });
    }
  };

  const again = () => {
    runId.current++;
    setForm(EMPTY);
    setResult(null);
    setSaved(null);
    setStep(0);
  };

  const steps: JobStep[] = (() => {
    const src = result?.steps.length ? result.steps.map((s) => s.label) : TEST_LABELS;
    return src.map((label, i) => {
      const real = result?.steps[i];
      if (real && i < shown) return { label: real.label, sub: real.sub, status: real.status, t: real.ms ? `${real.ms} ms` : "" };
      const running = (!result && i === 0) || (!!result && i === shown && i < result.steps.length);
      return { label, sub: "", status: running ? "running" : "pending", t: "" };
    });
  })();
  const revealed = !!result && shown >= result.steps.length;
  const failed = revealed && !result!.ok;
  const failedStep = result?.steps.find((s) => s.status === "failed");
  const pubKey = key.data?.publicKey ?? "";

  return (
    <Dialog onClose={onClose} width={520}>
      <DialogHeader icon="server" title={editing ? "Edit host" : "Add a host"} sub={editing ? `Update how Dockhand connects to ${existing.data?.name ?? "this host"}.` : "Any machine running Docker. Dockhand connects over SSH — nothing to install."} onClose={onClose} />
      <Stepper steps={["Details", "Authorize", "Connect"]} current={step === 2 && saved ? 3 : step} />

      {step === 0 && (
        <form onSubmit={next} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
            <Field label="Name">
              <input className="input" autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. pi-garage" />
            </Field>
            <Group label="Connect via">
              <Seg<HostMethod>
                value={form.method}
                onChange={(m) => set({ method: m })}
                options={[
                  { value: "key", label: "SSH key" },
                  { value: "password", label: "Password" },
                  { value: "local", label: "Local socket" },
                ]}
              />
            </Group>
          </div>
          {local ? (
            <div style={{ display: "flex", gap: 10, padding: "10px 12px", borderRadius: 12, background: "var(--fill-1)", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ flex: "none", marginTop: 2 }} aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
              <span>
                Talks to <code style={{ color: "var(--ink)" }}>/var/run/docker.sock</code> on the machine running Dockhand. Mount the socket into the Dockhand container to use this.
              </span>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px", gap: 12 }}>
                <Field label="Address">
                  <input className="input mono" value={form.address} onChange={(e) => set({ address: e.target.value })} placeholder="10.0.0.44 or host.tail-net.ts" />
                </Field>
                <Field label="Port">
                  <input className="input mono" inputMode="numeric" value={form.port} onChange={(e) => set({ port: e.target.value.replace(/[^0-9]/g, "") })} />
                </Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: form.method === "password" ? "repeat(auto-fit,minmax(180px,1fr))" : "1fr", gap: 12 }}>
                <Field label="SSH user">
                  <input className="input mono" value={form.user} onChange={(e) => set({ user: e.target.value })} placeholder="root" autoCapitalize="off" />
                </Field>
                {form.method === "password" && (
                  <Field label="Password">
                    <input className="input mono" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} placeholder={editing ? "unchanged" : "••••••••"} autoComplete="new-password" />
                  </Field>
                )}
              </div>
            </>
          )}
          {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
          <Actions style={{ marginTop: 4 }}>
            {editing && (
              <button type="button" className="btn2 lg danger" style={{ marginRight: "auto" }} onClick={remove}>
                <Icon name="trash" size={14} />
                Remove host
              </button>
            )}
            <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn">{form.method === "key" ? "Continue" : "Test connection"}</button>
          </Actions>
        </form>
      )}

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <KeyCallout
            title="Dockhand's public key"
            value={pubKey ? shortKey(pubKey) : ""}
            onCopy={() => {
              if (!pubKey) return;
              copyText(pubKey);
              toast({ kind: "ok", title: "Public key copied" });
            }}
          />
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.7, display: "flex", flexDirection: "column", gap: 4 }}>
            <li>SSH into the host as <code style={{ color: "var(--ink)" }}>{form.user || "the user you entered"}</code>.</li>
            <li>
              Append the key to <code style={{ color: "var(--ink)" }}>~/.ssh/authorized_keys</code>.
            </li>
            <li>
              Make sure that user can run <code style={{ color: "var(--ink)" }}>docker ps</code> without sudo.
            </li>
          </ol>
          <div className="term-block" style={{ position: "relative", padding: "12px 14px", borderRadius: 12 }}>
            {`echo "${pubKey || "<loading key…>"}" >> ~/.ssh/authorized_keys\nsudo usermod -aG docker $USER`}
            <button
              type="button"
              aria-label="Copy commands"
              onClick={() => {
                copyText(`echo "${pubKey}" >> ~/.ssh/authorized_keys\nsudo usermod -aG docker $USER`);
                toast({ kind: "ok", title: "Commands copied" });
              }}
              style={{ position: "absolute", top: 8, right: 8, width: 26, height: 26, borderRadius: 8, border: 0, background: "rgba(255,255,255,.1)", color: "#fff", cursor: "pointer", display: "grid", placeItems: "center" }}
            >
              <Icon name="copy" size={13} />
            </button>
          </div>
          <Actions style={{ marginTop: 4 }}>
            <button type="button" className="btn2 lg" style={{ marginRight: "auto" }} onClick={() => setStep(0)}>Back</button>
            <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
            <button type="button" className="btn" onClick={test} autoFocus>I&apos;ve added it — test connection</button>
          </Actions>
        </div>
      )}

      {step === 2 && (
        <>
          <ProgressList steps={steps} />
          {saved && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14, background: "rgba(34,160,107,.1)", border: "1px solid rgba(34,160,107,.3)", animation: "rise .3s ease both" }}>
                <span style={{ width: 28, height: 28, borderRadius: "50%", background: "#22a06b", display: "grid", placeItems: "center", flex: "none", color: "#fff" }}>
                  <Icon name="check" size={15} strokeWidth={2.6} />
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ok-ink)" }}>Connected — Dockhand is now watching this host.</span>
              </div>
              <Actions>
                {!editing && <button type="button" className="btn2 lg" onClick={again}>Add another</button>}
                <button
                  type="button"
                  className="btn"
                  autoFocus
                  onClick={() => {
                    onClose();
                    router.push(`/hosts/${saved.id}`);
                  }}
                >
                  Open host
                </button>
              </Actions>
            </>
          )}
          {(failed || saveErr) && (
            <>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--crit-bg)", border: "1px solid rgba(226,80,76,.3)", animation: "rise .3s ease both" }}>
                <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--crit)", display: "grid", placeItems: "center", flex: "none", color: "#fff" }}>
                  <Icon name="x" size={14} strokeWidth={2.6} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--crit-ink)" }}>{saveErr ? "Connected, but couldn't save the host" : failedStep ? `${failedStep.label} failed` : "Connection failed"}</span>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)", wordBreak: "break-word" }}>{saveErr || failedStep?.sub || result?.error}</span>
                  {!saveErr && result?.error && failedStep?.sub && result.error !== failedStep.sub && <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", wordBreak: "break-word" }}>{result.error}</span>}
                </span>
              </div>
              <Actions>
                <button type="button" className="btn2 lg" onClick={() => setStep(form.method === "key" ? 1 : 0)}>Back</button>
                <button type="button" className="btn" onClick={test}>
                  <Icon name="restart" size={14} />
                  Retry
                </button>
              </Actions>
            </>
          )}
          {!saved && !failed && !saveErr && (
            <Actions>
              <button
                type="button"
                className="btn2 lg"
                onClick={() => {
                  runId.current++;
                  onClose();
                }}
              >
                Cancel
              </button>
            </Actions>
          )}
        </>
      )}
    </Dialog>
  );
}
