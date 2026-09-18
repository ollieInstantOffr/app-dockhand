"use client";

import { useState } from "react";
import { Dialog, DialogHeader, Dropdown, Seg, ToggleRow } from "@/components/ui";
import { useShell } from "@/components/shell/context";
import { errMsg, invalidate, post, useApi } from "@/lib/api";
import { containerColor } from "@/lib/format";
import type { Container, Network, NetworkInput } from "@/lib/types";
import { Actions, Field, Group } from "./common";

type Driver = NetworkInput["driver"];

export function NetworkDialog({ hostId, onClose }: { hostId: string; onClose: () => void }) {
  const { toast } = useShell();
  const host = useApi<{ name: string }>(`/api/hosts/${hostId}`);
  const [f, setF] = useState<NetworkInput>({ name: "", driver: "bridge", subnet: "", gateway: "", internal: false, attachable: true });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<NetworkInput>) => setF((x) => ({ ...x, ...p }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    const name = f.name.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) return setErr("Network names use letters, digits, “_”, “.” and “-”.");
    if (f.subnet.trim() && !/^[0-9a-f.:]+\/\d{1,3}$/i.test(f.subnet.trim())) return setErr("Subnet must be CIDR, e.g. 172.28.0.0/16");
    if (f.gateway.trim() && !f.subnet.trim()) return setErr("A gateway needs a subnet.");
    if (f.gateway.trim() && !/^[0-9a-f.:]+$/i.test(f.gateway.trim())) return setErr("Gateway must be an IP address.");
    setBusy(true);
    try {
      const n = await post<Network>(`/api/hosts/${hostId}/networks`, { ...f, name, subnet: f.subnet.trim(), gateway: f.gateway.trim() });
      invalidate(`/api/hosts/${hostId}/networks`);
      toast({ kind: "ok", title: `Network ${n.name} created`, text: n.subnet || undefined });
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} width={500}>
      <DialogHeader icon="network" title="Create network" sub={host.data ? `On ${host.data.name}` : "Docker network on this host"} onClose={onClose} />
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Name">
          <input className="input mono" autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. proxy" autoCapitalize="off" />
        </Field>
        <Group label="Driver">
          <Seg<Driver>
            mono
            value={f.driver}
            onChange={(d) => set({ driver: d })}
            options={[
              { value: "bridge", label: "bridge" },
              { value: "overlay", label: "overlay" },
              { value: "macvlan", label: "macvlan" },
              { value: "ipvlan", label: "ipvlan" },
            ]}
          />
          {f.driver === "overlay" && <span className="field-hint">Overlay networks need the host to be a Swarm manager.</span>}
          {(f.driver === "macvlan" || f.driver === "ipvlan") && <span className="field-hint">Containers get addresses on your LAN — set a subnet and gateway that match it.</span>}
        </Group>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
          <Field label={<span>Subnet <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· optional</span></span>}>
            <input className="input mono" value={f.subnet} onChange={(e) => set({ subnet: e.target.value })} placeholder="172.28.0.0/16" />
          </Field>
          <Field label={<span>Gateway <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· optional</span></span>}>
            <input className="input mono" value={f.gateway} onChange={(e) => set({ gateway: e.target.value })} placeholder="172.28.0.1" />
          </Field>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "12px 14px", borderRadius: 14, background: "var(--fill-1)" }}>
          <ToggleRow label="Internal" sub="No outbound internet access for attached containers" on={f.internal} onChange={(v) => set({ internal: v })} />
          <ToggleRow label="Attachable" sub="Standalone containers can join (not just services)" on={f.attachable} onChange={(v) => set({ attachable: v })} />
        </div>
        {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
        <Actions style={{ marginTop: 4 }}>
          <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy}>
            {busy && <span className="spinner" />}
            Create network
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}

export function AttachNetworkDialog({ hostId, networkId, networkName, onClose }: { hostId: string; networkId: string; networkName: string; onClose: () => void }) {
  const { toast } = useShell();
  const containers = useApi<Container[]>(`/api/hosts/${hostId}/containers`);
  const net = useApi<Network[]>(`/api/hosts/${hostId}/networks`);
  const members = new Set((net.data?.find((n) => n.id === networkId || n.name === networkName)?.members ?? []).map((m) => m.id));
  const options = (containers.data ?? [])
    .filter((c) => !members.has(c.id) && !members.has(c.shortId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.id, label: c.name, sub: c.stack || undefined, dot: containerColor(c.state, c.health) }));
  const [cid, setCid] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!cid) return setErr("Pick a container.");
    setBusy(true);
    try {
      await post(`/api/hosts/${hostId}/networks/${encodeURIComponent(networkId)}/connect`, { container: cid });
      const c = containers.data?.find((x) => x.id === cid);
      invalidate(`/api/hosts/${hostId}/networks`);
      invalidate(`/api/hosts/${hostId}/containers`);
      toast({ kind: "ok", title: `${c?.name ?? "Container"} joined ${networkName}` });
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} width={460}>
      <DialogHeader icon="network" title="Attach container" sub={networkName} monoSub onClose={onClose} />
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Group label="Container">
          <Dropdown value={cid} onChange={setCid} options={options} placeholder={containers.isLoading ? "Loading containers…" : options.length ? "Pick a container" : "Every container is already attached"} />
          <span className="field-hint">The container joins the network live — no restart needed.</span>
        </Group>
        {err && <span style={{ fontSize: 12.5, color: "var(--crit-ink)", fontWeight: 600 }}>{err}</span>}
        <Actions style={{ marginTop: 4 }}>
          <button type="button" className="btn2 lg" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !cid}>
            {busy && <span className="spinner" />}
            Attach
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}
