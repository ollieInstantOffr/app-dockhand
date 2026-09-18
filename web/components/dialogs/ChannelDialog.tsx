"use client";

import { useState } from "react";
import { Dialog, DialogHeader, Seg } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, patch, post } from "@/lib/api";
import type { NotificationChannel } from "@/lib/types";
import { Actions, Field, Group } from "./common";

type CType = NotificationChannel["type"];
type Def = { key: string; label: string; placeholder: string; secret?: boolean; mono?: boolean; optional?: boolean; half?: boolean };

const FIELDS: Record<CType, Def[]> = {
  email: [
    { key: "host", label: "SMTP host", placeholder: "smtp.fastmail.com", mono: true, half: true },
    { key: "port", label: "Port", placeholder: "587", mono: true, half: true },
    { key: "username", label: "Username", placeholder: "alerts@example.com", mono: true, half: true, optional: true },
    { key: "password", label: "Password", placeholder: "••••••••", secret: true, half: true, optional: true },
    { key: "from", label: "From", placeholder: "Dockhand <alerts@example.com>", half: true },
    { key: "to", label: "To", placeholder: "you@example.com", half: true },
  ],
  slack: [{ key: "url", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…", mono: true, secret: true }],
  discord: [{ key: "url", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", mono: true, secret: true }],
  ntfy: [
    { key: "url", label: "Server", placeholder: "https://ntfy.sh", mono: true, half: true },
    { key: "topic", label: "Topic", placeholder: "dockhand-alerts", mono: true, half: true },
    { key: "token", label: "Access token", placeholder: "tk_…", mono: true, secret: true, optional: true },
  ],
  webhook: [{ key: "url", label: "URL", placeholder: "https://example.com/hooks/dockhand", mono: true }],
};

const DEFAULTS: Partial<Record<CType, Record<string, string>>> = { email: { port: "587" }, ntfy: { url: "https://ntfy.sh" } };
const LABEL: Record<CType, string> = { email: "Email", slack: "Slack", discord: "Discord", ntfy: "ntfy", webhook: "Webhook" };
const HINT: Record<CType, string> = {
  email: "Sent over SMTP with STARTTLS when the server offers it.",
  slack: "Create an Incoming Webhook in your Slack workspace and paste its URL.",
  discord: "Channel settings → Integrations → Webhooks → New webhook → Copy URL.",
  ntfy: "Subscribe to the same topic in the ntfy app to get push notifications.",
  webhook: "Dockhand POSTs a JSON body {title, text, severity, host, url} to this URL.",
};

function isType(t: string | undefined): t is CType {
  return !!t && t in FIELDS;
}

/** Add a channel, or edit `channel` (secrets arrive masked; unchanged masked values keep the stored secret). */
export function ChannelDialog({ channelType, channel, onClose }: { channelType?: string; channel?: NotificationChannel; onClose: () => void }) {
  const { toast } = useShell();
  const editing = !!channel;
  const [type, setType] = useState<CType>(channel ? channel.type : isType(channelType) ? channelType : "email");
  const [name, setName] = useState(channel?.name ?? "");
  const [config, setConfig] = useState<Record<string, string>>(channel ? { ...channel.config } : DEFAULTS[type] ?? {});
  const [saved, setSaved] = useState<NotificationChannel | null>(channel ?? null);
  const [dirty, setDirty] = useState(!channel);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string } | null>(null);

  const fields = FIELDS[type];

  const validate = () => {
    for (const f of fields) {
      const v = (config[f.key] ?? "").trim();
      if (!f.optional && !v) return `${f.label} is required.`;
      if (f.key === "url" && v && !v.startsWith("••••") && !/^https?:\/\/\S+$/i.test(v)) return `${f.label} must start with http:// or https://`;
      if (f.key === "port" && v && !/^\d{1,5}$/.test(v)) return "Port must be a number.";
    }
    return "";
  };

  /** Create (or update) the channel; returns it. */
  const persist = async (): Promise<NotificationChannel | null> => {
    const v = validate();
    if (v) {
      setErr(v);
      return null;
    }
    const body = { type, name: name.trim() || LABEL[type], config: Object.fromEntries(fields.map((f) => [f.key, (config[f.key] ?? "").trim()])), enabled: saved?.enabled ?? true };
    const ch = saved ? (dirty ? await patch<NotificationChannel>(`/api/notifications/channels/${saved.id}`, body) : saved) : await post<NotificationChannel>("/api/notifications/channels", body);
    setSaved(ch);
    setDirty(false);
    invalidate("/api/notifications");
    return ch;
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy("save");
    try {
      const ch = await persist();
      if (!ch) return;
      toast(editing ? { kind: "ok", title: `${ch.name} saved` } : { kind: "ok", title: `${ch.name} added`, text: "Alerts will be delivered to this channel." });
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setErr("");
    setTestResult(null);
    setBusy("test");
    try {
      const ch = await persist();
      if (!ch) return;
      const r = await post<{ ok: boolean; error: string }>(`/api/notifications/channels/${ch.id}/test`);
      setTestResult(r);
      toast(r.ok ? { kind: "ok", title: "Test notification sent", text: `Check ${ch.name}.` } : { kind: "error", title: "Test failed", text: r.error });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy("");
    }
  };

  const setField = (k: string, v: string) => {
    setConfig((c) => ({ ...c, [k]: v }));
    setDirty(true);
    setTestResult(null);
  };

  return (
    <Dialog onClose={onClose} width={540}>
      <DialogHeader icon="bell" title={saved ? `Edit ${saved.name}` : "Add notification channel"} sub="Where Dockhand sends alerts when something needs you." onClose={onClose} />
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!saved && (
          <Group label="Type">
            <Seg<CType>
              value={type}
              onChange={(t) => {
                setType(t);
                setConfig(DEFAULTS[t] ?? {});
                setErr("");
                setTestResult(null);
              }}
              options={(Object.keys(FIELDS) as CType[]).map((t) => ({ value: t, label: LABEL[t] }))}
            />
          </Group>
        )}
        <Field label="Name">
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder={type === "email" ? "e.g. My inbox" : type === "slack" ? "e.g. #homelab" : `e.g. ${LABEL[type]}`}
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
          {fields.map((f) => (
            <Field key={`${type}-${f.key}`} label={f.optional ? <span>{f.label} <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· optional</span></span> : f.label} style={f.half ? undefined : { gridColumn: "1 / -1" }}>
              <input
                className={`input ${f.mono ? "mono" : ""}`}
                type={f.secret && f.key !== "url" ? "password" : "text"}
                value={config[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                autoComplete="off"
                autoCapitalize="off"
                inputMode={f.key === "port" ? "numeric" : f.key === "url" ? "url" : undefined}
              />
            </Field>
          ))}
        </div>
        <span className="field-hint" style={{ marginTop: -4 }}>{HINT[type]}</span>
        {testResult && (
          <div style={{ padding: "10px 12px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.5, ...(testResult.ok ? { background: "rgba(34,160,107,.1)", color: "var(--ok-ink)" } : { background: "var(--crit-bg)", color: "var(--crit-ink)" }) }}>
            {testResult.ok ? "✓ Test notification delivered." : `✕ ${testResult.error || "Delivery failed."}`}
          </div>
        )}
        {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
        <Actions style={{ marginTop: 4 }}>
          <button type="button" className="btn2 lg" style={{ marginRight: "auto" }} onClick={test} disabled={!!busy}>
            {busy === "test" && <span className="spinner" />}
            Send test
          </button>
          <button type="button" className="btn2 lg" onClick={onClose}>{saved ? "Close" : "Cancel"}</button>
          <button type="submit" className="btn" disabled={!!busy}>
            {busy === "save" && <span className="spinner" />}
            Save
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}
