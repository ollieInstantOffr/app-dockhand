"use client";

import { HostChips, Seg } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { SetToggle, useSettings } from "@/components/settings/common";
import { invalidate } from "@/lib/api";
import type { Host, Settings } from "@/lib/types";

export function ConfigurePanel({ hosts }: { hosts: Host[] }) {
  const shell = useShell();
  const { settings, save } = useSettings();
  if (!settings) {
    return (
      <div className="glass-card" style={{ padding: "22px 24px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))", gap: 24, animation: "rise .3s ease both" }}>
        {[0, 1, 2, 3].map((i) => <span key={i} className="skel" style={{ height: 70, borderRadius: 14 }} />)}
      </div>
    );
  }
  const u = settings.uptime;
  // Host selection / auto-monitor change which monitors exist — refetch the overview after saving.
  const saveUp = async (p: Partial<Settings["uptime"]>) => {
    if (await save({ uptime: p })) invalidate("/api/uptime");
  };
  const selected = u.hostIds.length ? u.hostIds.filter((id) => hosts.some((h) => h.id === id)) : hosts.map((h) => h.id);
  const toggleHost = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    if (!next.length) {
      shell.toast({ kind: "warn", title: "Keep at least one host", text: "Dockhand needs a host to monitor." });
      return;
    }
    saveUp({ hostIds: next.length === hosts.length ? [] : next });
  };
  const base = settings.general.publicUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const statusUrl = `${base.replace(/\/+$/, "")}/status`;
  const statusLabel = statusUrl.replace(/^https?:\/\//, "");

  return (
    <div className="glass-card" style={{ padding: "22px 24px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))", gap: 24, animation: "rise .3s ease both", position: "relative", zIndex: 1 }}>
      <div className="field">
        Check interval
        <Seg
          fit
          options={[{ value: "30", label: "30s" }, { value: "60", label: "1m" }, { value: "300", label: "5m" }]}
          value={String(u.intervalSec)}
          onChange={(v) => saveUp({ intervalSec: Number(v) as Settings["uptime"]["intervalSec"] })}
        />
        <span className="field-hint">Applies to host reachability and Docker health checks.</span>
      </div>
      <div className="field">
        Mark down after
        <Seg
          fit
          options={[{ value: "1", label: "1 failure" }, { value: "2", label: "2 failures" }, { value: "3", label: "3 failures" }]}
          value={String(u.retries)}
          onChange={(v) => saveUp({ retries: Number(v) as Settings["uptime"]["retries"] })}
        />
        <span className="field-hint">Consecutive failures before an alert fires.</span>
      </div>
      <div className="field">
        Hosts to monitor
        {hosts.length ? <HostChips hosts={hosts} selected={selected} onToggle={toggleHost} /> : <span className="field-hint">No hosts yet.</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <SetToggle label="Auto-monitor new containers" sub="Docker health for anything that starts" on={u.autoMonitor} onChange={(v) => saveUp({ autoMonitor: v })} />
        <SetToggle label="Notify on state change" sub="Down and recovered" on={u.notify} onChange={(v) => saveUp({ notify: v })} />
        <SetToggle
          label="Public status page"
          sub={
            u.publicStatus ? (
              <a href={statusUrl} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11 }}>{statusLabel}</a>
            ) : (
              <span className="mono" style={{ fontSize: 11 }}>{statusLabel}</span>
            )
          }
          on={u.publicStatus}
          onChange={(v) => saveUp({ publicStatus: v })}
        />
      </div>
    </div>
  );
}
