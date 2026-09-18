"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { DotsMenu, Toggle } from "@/components/ui";
import { ChannelDialog } from "@/components/dialogs/ChannelDialog";
import { useShell } from "@/components/shell/context";
import { del, errMsg, patch, post, useApi } from "@/lib/api";
import type { NotificationChannel, Settings } from "@/lib/types";
import { CardHead, Portal, SetToggle, cardStyle, rowStyle, twoCol, useSettings } from "./common";

const PREFS: { key: keyof Settings["notifications"]; label: string; sub: string }[] = [
  { key: "hostDown", label: "Host goes offline", sub: "SSH unreachable after the retry window" },
  { key: "containerCrash", label: "Container crashes", sub: "Exits unexpectedly or keeps restarting" },
  { key: "unhealthy", label: "Health check fails", sub: "A container reports unhealthy" },
  { key: "updates", label: "Image updates available", sub: "Daily check for newer tags" },
  { key: "diskSpace", label: "Disk space low", sub: "Any host above 90% disk" },
  { key: "deploys", label: "Deploy finished or failed", sub: "Git, compose and image deploys" },
  { key: "digest", label: "Daily digest", sub: "One summary every morning" },
];

const TYPES: { type: NotificationChannel["type"]; label: string; icon: IconName; sub: string }[] = [
  { type: "email", label: "Email", icon: "mail", sub: "SMTP — any provider" },
  { type: "slack", label: "Slack", icon: "chat", sub: "Incoming webhook" },
  { type: "ntfy", label: "ntfy", icon: "bell", sub: "Push to your phone" },
  { type: "webhook", label: "Webhook", icon: "webhook", sub: "POST JSON anywhere" },
];

function channelSummary(c: NotificationChannel): string {
  const k = c.config ?? {};
  switch (c.type) {
    case "email":
      return `${k.from || k.username || "smtp"} → ${k.to || "?"}`;
    case "ntfy":
      return `${(k.url || "https://ntfy.sh").replace(/\/+$/, "")}/${k.topic || ""}`;
    default:
      return k.url || "no URL";
  }
}

export function NotificationsTab() {
  const { settings, save } = useSettings();
  return (
    <div style={twoCol(360)}>
      <div className="glass-card" style={cardStyle(14, "22px 24px")}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Notifications</div>
        {!settings && [0, 1, 2, 3].map((i) => <span key={i} className="skel" style={{ height: 34 }} />)}
        {settings &&
          PREFS.map((p) => (
            <SetToggle key={p.key} label={p.label} sub={p.sub} on={!!settings.notifications[p.key]} onChange={(v) => save({ notifications: { [p.key]: v } })} />
          ))}
      </div>
      <ChannelsCard />
    </div>
  );
}

function ChannelsCard() {
  const shell = useShell();
  const { data: channels, mutate } = useApi<NotificationChannel[]>("/api/notifications/channels");
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);

  const setEnabled = async (c: NotificationChannel, enabled: boolean) => {
    const prev = channels;
    mutate(channels?.map((x) => (x.id === c.id ? { ...x, enabled } : x)), { revalidate: false });
    try {
      await patch(`/api/notifications/channels/${c.id}`, { enabled });
    } catch (e) {
      mutate(prev, { revalidate: false });
      shell.toast({ kind: "error", title: `Couldn't update ${c.name}`, text: errMsg(e) });
    }
  };

  const test = async (c: NotificationChannel) => {
    setTesting(c.id);
    try {
      const r = await post<{ ok: boolean; error: string }>(`/api/notifications/channels/${c.id}/test`);
      shell.toast(r.ok ? { kind: "ok", title: "Test notification sent", text: `Check ${c.name}.` } : { kind: "error", title: `${c.name} didn't accept the test`, text: r.error });
    } catch (e) {
      shell.toast({ kind: "error", title: "Test failed", text: errMsg(e) });
    } finally {
      setTesting(null);
    }
  };

  const remove = async (c: NotificationChannel) => {
    const ok = await shell.confirm({ title: `Remove ${c.name}?`, text: "Dockhand stops sending notifications to this channel.", confirmLabel: "Remove channel", danger: true, icon: "trash" });
    if (!ok) return;
    const prev = channels;
    mutate(channels?.filter((x) => x.id !== c.id), { revalidate: false });
    try {
      await del(`/api/notifications/channels/${c.id}`);
      shell.toast({ kind: "ok", title: `Removed ${c.name}` });
      mutate();
    } catch (e) {
      mutate(prev, { revalidate: false });
      shell.toast({ kind: "error", title: "Couldn't remove channel", text: errMsg(e) });
    }
  };

  const unconnected = TYPES.filter((t) => !channels?.some((c) => c.type === t.type));
  const row = (icon: IconName) => (
    <span style={{ width: 32, height: 32, borderRadius: 10, background: "var(--fill-1)", display: "grid", placeItems: "center", flex: "none", color: "var(--ink-2)" }}>
      <Icon name={icon} size={16} />
    </span>
  );

  return (
    <div className="glass-card" style={cardStyle(12, "22px 24px")}>
      <CardHead title="Channels" sub={channels?.length ? `${channels.filter((c) => c.enabled).length} active` : undefined}>
        {!!channels?.length && (
          <button type="button" className="btn2 sm" onClick={() => shell.openDialog({ type: "channel" })}>
            <Icon name="plus" size={13} />
            Add channel
          </button>
        )}
      </CardHead>
      {!channels && [0, 1, 2].map((i) => <span key={i} className="skel" style={{ height: 58, borderRadius: 14 }} />)}
      {channels && !channels.length && <span style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>Alerts only show up in Dockhand until you connect a channel.</span>}
      {channels?.map((c) => {
        const t = TYPES.find((x) => x.type === c.type);
        return (
          <div key={c.id} style={rowStyle(false, { opacity: c.enabled ? 1 : 0.65 })}>
            {row(t?.icon ?? "bell")}
            <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
              <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 700 }}>
                {c.name} <span style={{ fontWeight: 500, color: "var(--ink-3)" }}>· {c.enabled ? t?.label ?? c.type : "paused"}</span>
              </span>
              <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>{channelSummary(c)}</span>
            </span>
            <button type="button" className="btn2 sm" disabled={testing === c.id || !c.enabled} onClick={() => test(c)} title={c.enabled ? "Send a test notification" : "Resume the channel to test it"}>
              {testing === c.id && <span className="spinner" style={{ width: 11, height: 11 }} />}
              Test
            </button>
            <Toggle small on={c.enabled} onChange={(v) => setEnabled(c, v)} title={c.enabled ? "Pause this channel" : "Resume this channel"} />
            <DotsMenu
              items={[
                { label: "Edit", icon: "edit", onClick: () => setEditing(c) },
                { label: "Remove", icon: "trash", danger: true, onClick: () => remove(c) },
              ]}
            />
          </div>
        );
      })}
      {channels && unconnected.length > 0 && (
        <>
          {channels.length > 0 && <div className="section-label" style={{ padding: "6px 4px 0" }}>More channels</div>}
          {unconnected.map((t) => (
            <div key={t.type} style={rowStyle()}>
              {row(t.icon)}
              <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{t.label}</span>
                <span className="ellipsis" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{t.sub}</span>
              </span>
              <button type="button" className="btn2 sm" onClick={() => shell.openDialog({ type: "channel", channelType: t.type })}>Connect</button>
            </div>
          ))}
        </>
      )}
      {editing && (
        <Portal>
          <ChannelDialog
            channel={editing}
            onClose={() => {
              setEditing(null);
              mutate();
            }}
          />
        </Portal>
      )}
    </div>
  );
}
