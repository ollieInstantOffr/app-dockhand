"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogHeader, Dropdown, HostChips, Seg } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post, useApi } from "@/lib/api";
import { containerColor } from "@/lib/format";
import type { Container, MonitorInput, MonitorView } from "@/lib/types";
import { Actions, Field, Group, useHosts } from "./common";

type MType = MonitorInput["type"];

export function MonitorDialog({ hostId: initialHost, onClose }: { hostId?: string; onClose: () => void }) {
  const { toast } = useShell();
  const hosts = useHosts();
  const [type, setType] = useState<MType>("docker");
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState<string | null>(initialHost ?? null);
  const [container, setContainer] = useState("");
  const [url, setUrl] = useState("");
  const [expect, setExpect] = useState("200");
  const [tcp, setTcp] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hostId && type === "docker" && hosts.length) setHostId(hosts[0].id);
  }, [hosts, hostId, type]);

  const all = useApi<Container[]>(type === "docker" ? "/api/containers" : null);
  const containers = useMemo(() => (all.data ?? []).filter((c) => c.hostId === hostId).sort((a, b) => a.name.localeCompare(b.name)), [all.data, hostId]);
  useEffect(() => {
    if (container && !containers.some((c) => c.name === container)) setContainer("");
  }, [containers, container]);

  const defaultName = () => {
    if (type === "docker") return container;
    if (type === "http") {
      try {
        return new URL(url.trim()).host;
      } catch {
        return url.trim();
      }
    }
    return tcp.trim();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    let target = "";
    if (type === "docker") {
      if (!hostId) return setErr("Pick the host the container runs on.");
      if (!container) return setErr("Pick a container.");
      target = container;
    } else if (type === "http") {
      const u = url.trim();
      if (!/^https?:\/\/[^\s]+$/i.test(u)) return setErr("Enter a full URL, e.g. https://cloud.example.com/status");
      if (expect.trim() && !/^[1-5]\d\d(\s*-\s*[1-5]\d\d)?$/.test(expect.trim())) return setErr("Expected status is a code like 200 or a range like 200-399.");
      target = u;
    } else {
      const t = tcp.trim();
      if (!/^[^\s:]+:\d{1,5}$/.test(t) && !/^\[[0-9a-f:]+\]:\d{1,5}$/i.test(t)) return setErr("Use host:port, e.g. 10.0.0.12:5432");
      target = t;
    }
    setBusy(true);
    try {
      const body: MonitorInput = { name: name.trim() || defaultName(), type, hostId: hostId || null, target, ...(type === "http" ? { expect: expect.trim() || "200" } : {}) };
      const m = await post<MonitorView>("/api/monitors", body);
      invalidate("/api/uptime");
      toast({ kind: "ok", title: `Monitoring ${m.name}`, text: "The first check runs now." });
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} width={520}>
      <DialogHeader icon="pulse" title="Add monitor" sub="Watch a container's health, an HTTP endpoint, or a TCP port." onClose={onClose} />
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Group label="Type">
          <Seg<MType>
            fit
            value={type}
            onChange={(t) => {
              setType(t);
              setErr("");
            }}
            options={[
              { value: "docker", label: "Container health" },
              { value: "http", label: "HTTP" },
              { value: "tcp", label: "TCP port" },
            ]}
          />
        </Group>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
          <Field label="Name">
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName() || "e.g. Nextcloud"} />
          </Field>
          <Group label={type === "docker" ? "Host" : <span>Host <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· optional</span></span>}>
            <HostChips hosts={hosts} selected={hostId ? [hostId] : []} onToggle={(id) => setHostId(id === hostId && type !== "docker" ? null : id)} />
          </Group>
        </div>
        {type === "docker" && (
          <Group label="Container">
            <Dropdown
              value={container}
              placeholder={all.isLoading ? "Loading containers…" : containers.length ? "Pick a container" : "No containers on this host"}
              onChange={setContainer}
              options={containers.map((c) => ({ value: c.name, label: c.name, sub: c.stack || c.image.split("/").pop(), dot: containerColor(c.state, c.health) }))}
            />
            <span className="field-hint">Down when the container stops or reports unhealthy. Tracked by name, so it survives recreates.</span>
          </Group>
        )}
        {type === "http" && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px", gap: 12 }}>
            <Field label="URL">
              <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://cloud.example.com/status" autoCapitalize="off" inputMode="url" />
            </Field>
            <Field label="Expect status">
              <input className="input mono" value={expect} onChange={(e) => setExpect(e.target.value)} placeholder="200" />
            </Field>
          </div>
        )}
        {type === "tcp" && (
          <Field label="Host and port" hint="Checked from the Dockhand server — reachable hosts only.">
            <input className="input mono" value={tcp} onChange={(e) => setTcp(e.target.value)} placeholder="10.0.0.12:5432" autoCapitalize="off" />
          </Field>
        )}
        {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
        <Actions style={{ marginTop: 4 }}>
          <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>
            {busy && <span className="spinner" />}
            Add monitor
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}
