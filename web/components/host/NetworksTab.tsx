"use client";

import { useEffect, useState } from "react";
import { del, errMsg, get, invalidate, post } from "@/lib/api";
import { C, containerColor, halo, plural } from "@/lib/format";
import type { Network } from "@/lib/types";
import { Dialog, DialogHeader, EmptyState, Skel, copyText } from "../ui";
import { Icon } from "../icons";
import { useShell } from "../shell/context";
import { act } from "./jobs";

function driverColor(n: Network): string {
  if (n.name === "none" || n.driver === "null") return "#9aa1ad";
  switch (n.driver) {
    case "bridge":
      return C.blue;
    case "overlay":
      return C.violet;
    case "host":
      return C.ok;
    case "macvlan":
    case "ipvlan":
      return C.warn;
    default:
      return "#14b8c4";
  }
}

export function NetworksTab({ hostId, networks }: { hostId: string; networks: Network[] | undefined }) {
  const shell = useShell();
  const [inspect, setInspect] = useState<Network | null>(null);

  if (!networks) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Skel w={220} h={14} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,340px),1fr))", gap: 14 }}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="glass-card" style={{ borderRadius: 22, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <Skel w={36} h={36} r={11} style={{ flex: "none" }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                  <Skel w="45%" h={13} />
                  <Skel w="60%" h={10} />
                </span>
              </div>
              <Skel w="70%" h={28} r={9} />
              <Skel w="100%" h={30} r={10} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const custom = networks.filter((n) => !n.system);
  const unused = custom.filter((n) => n.members.length === 0);

  const prune = async () => {
    const ok = await shell.confirm({
      title: "Remove unused networks?",
      text: "Custom networks with no containers attached are deleted. System networks (bridge, host, none) are never touched.",
      confirmLabel: "Remove unused",
      danger: true,
      icon: "network",
      details: unused.slice(0, 5).map((n) => ({ k: n.name, v: n.driver })),
    });
    if (!ok) return;
    await act(shell, () => post<{ removed: string[] }>(`/api/hosts/${hostId}/networks/prune`), (r) => ({ title: `Removed ${plural(r?.removed?.length ?? 0, "network")}`, text: r?.removed?.join(", ") || undefined }), "Couldn't remove networks");
    invalidate(`/api/hosts/${hostId}/networks`);
  };

  const remove = async (n: Network) => {
    const ok = await shell.confirm({ title: `Remove ${n.name}?`, text: "This network has no containers attached. It will be deleted from the host.", confirmLabel: "Remove", danger: true, icon: "trash", details: [{ k: "Driver", v: n.driver }, ...(n.subnet ? [{ k: "Subnet", v: n.subnet }] : [])] });
    if (!ok) return;
    await act(shell, () => del(`/api/hosts/${hostId}/networks/${n.id}`), { title: `Removed ${n.name}` }, `Couldn't remove ${n.name}`);
    invalidate(`/api/hosts/${hostId}/networks`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {plural(networks.length, "network")} · {custom.length} custom · {unused.length} unused
        </span>
        <button className="btn2" style={{ marginLeft: "auto" }} disabled={!unused.length} onClick={prune}>
          Remove unused
        </button>
        <button className="btn sm" onClick={() => shell.openDialog({ type: "network", hostId })}>
          <Icon name="plus" size={15} />
          Create network
        </button>
      </div>
      {networks.length === 0 ? (
        <EmptyState icon="network" title="No networks" text="Docker hasn't reported any networks for this host yet." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,340px),1fr))", gap: 14 }}>
          {networks.map((n) => {
            const color = driverColor(n);
            const used = n.members.length > 0;
            const attachable = n.name !== "host" && n.name !== "none";
            return (
              <div key={n.id} className="glass-card" style={{ borderRadius: 22, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 36, height: 36, borderRadius: 11, background: halo(color, 0.12), color, display: "grid", placeItems: "center", flex: "none" }}>
                    <Icon name="network" size={17} />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className="mono ellipsis" style={{ fontSize: 14, fontWeight: 600 }}>{n.name}</span>
                      {n.system && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: "var(--fill-1)", color: "var(--ink-3)", flex: "none" }}>system</span>}
                      {n.internal && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 6, background: "var(--fill-1)", color: "var(--ink-3)", flex: "none" }}>internal</span>}
                    </span>
                    <span className="mono ellipsis" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {n.driver} · {n.subnet || "no subnet"}
                    </span>
                  </span>
                  <span className={`tag ${used ? "ok" : "muted"}`}>{used ? plural(n.members.length, "container") : "unused"}</span>
                </div>
                {used ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {n.members.map((m) => (
                      <button key={m.id} className="chip-hover mono" onClick={() => shell.openContainer(hostId, m.id)} style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px 0 8px", borderRadius: 9, border: "1px solid transparent", background: "var(--fill-1)", fontSize: 11.5, color: "var(--ink)", cursor: "pointer", maxWidth: "100%" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: containerColor(m.state), flex: "none" }} />
                        <span className="ellipsis">{m.name}</span>
                        {m.ip && <span style={{ color: "var(--ink-3)" }}>{m.ip.replace(/\/\d+$/, "")}</span>}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, border: "1px dashed var(--line-3)", fontSize: 12.5, color: "var(--ink-3)" }}>
                    {n.system ? "No containers attached." : "No containers attached — safe to remove."}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, paddingTop: 4, borderTop: "1px solid var(--line-1)" }}>
                  <button className="btn-fill" style={{ flex: 1 }} onClick={() => setInspect(n)}>
                    Inspect
                  </button>
                  {attachable && (
                    <button className="btn-fill" style={{ flex: 1 }} onClick={() => shell.openDialog({ type: "attachNetwork", hostId, networkId: n.id, networkName: n.name })}>
                      Attach container
                    </button>
                  )}
                  {!n.system && !used && (
                    <button className="btn-fill danger-fill" style={{ padding: "0 10px", color: "var(--crit-ink)" }} onClick={() => remove(n)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {inspect && <InspectDialog hostId={hostId} net={inspect} onClose={() => setInspect(null)} />}
    </div>
  );
}

function InspectDialog({ hostId, net, onClose }: { hostId: string; net: Network; onClose: () => void }) {
  const { toast } = useShell();
  const [json, setJson] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    get<unknown>(`/api/hosts/${hostId}/networks/${net.id}`)
      .then((d) => alive && setJson(JSON.stringify(d, null, 2)))
      .catch((e) => alive && setErr(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [hostId, net.id]);
  return (
    <Dialog onClose={onClose} width={680} label="Network details">
      <DialogHeader icon="network" title={net.name} sub={`docker network inspect ${net.id.slice(0, 12)}`} monoSub onClose={onClose} />
      <div className="term-block" style={{ maxHeight: "60vh", overflow: "auto", whiteSpace: "pre", wordBreak: "normal", minHeight: 160 }}>
        {err ? <span style={{ color: "#ff8a85" }}>{err}</span> : json ?? <span style={{ color: "#6b7280" }}>Loading…</span>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          className="btn2 lg"
          disabled={!json}
          onClick={() => {
            if (!json) return;
            copyText(json);
            toast({ kind: "ok", title: "Copied inspect JSON" });
          }}
        >
          <Icon name="copy" size={14} />
          Copy
        </button>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
