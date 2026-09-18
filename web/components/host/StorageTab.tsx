"use client";

import { useMemo, useRef, useState } from "react";
import { invalidate, post, useApi } from "@/lib/api";
import { C, ago, bytes, halo, plural } from "@/lib/format";
import type { DiskUsage, Host, Image, JobRef, Volume } from "@/lib/types";
import { Skel } from "../ui";
import { Icon } from "../icons";
import { useShell } from "../shell/context";
import { DiskTreemap } from "../charts/DiskTreemap";
import type { DiskTreemapDatum } from "../charts/DiskTreemap.types";
import { act, trackJob } from "./jobs";
import { confirmPrune } from "./HostHeader";

const CARD: React.CSSProperties = { borderRadius: 22, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 };
const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 14, background: "var(--fill-1)", border: "1px solid transparent", minWidth: 0 };

function RowsSkeleton({ n }: { n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={ROW}>
          <Skel w={32} h={32} r={10} style={{ flex: "none" }} />
          <span style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
            <Skel w="50%" h={12} />
            <Skel w="35%" h={9} />
          </span>
          <Skel w={48} h={12} />
        </div>
      ))}
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: "18px 12px", borderRadius: 12, border: "1px dashed var(--line-3)", fontSize: 12.5, color: "var(--ink-3)", textAlign: "center" }}>{text}</div>;
}

export function StorageTab({ hostId, host, images, volumes }: { hostId: string; host: Host | undefined; images: Image[] | undefined; volumes: Volume[] | undefined }) {
  const shell = useShell();
  const imagesRef = useRef<HTMLDivElement>(null);
  const volumesRef = useRef<HTMLDivElement>(null);

  const imgSize = (images ?? []).reduce((a, i) => a + i.size, 0);
  const unusedImgs = (images ?? []).filter((i) => i.containers === 0);
  const volSize = (volumes ?? []).reduce((a, v) => a + (v.size > 0 ? v.size : 0), 0);

  const pruneImages = async () => {
    const ok = await shell.confirm({
      title: "Remove unused images?",
      text: "Every image that no container uses is deleted — not just dangling layers. They'll be pulled again if you deploy them later.",
      confirmLabel: "Remove unused",
      danger: true,
      icon: "clean",
      details: [
        { k: "Unused images", v: String(unusedImgs.length) },
        { k: "Space", v: bytes(unusedImgs.reduce((a, i) => a + i.size, 0)) },
      ],
    });
    if (!ok) return;
    await act(shell, () => post<{ count: number; reclaimed: number }>(`/api/hosts/${hostId}/images/prune`), (r) => ({ title: `Removed ${plural(r?.count ?? 0, "image")}`, text: `${bytes(r?.reclaimed ?? 0)} reclaimed` }), "Couldn't remove images");
    invalidate(`/api/hosts/${hostId}`);
  };

  const backupAll = () => {
    trackJob(shell, post<JobRef>(`/api/hosts/${hostId}/volumes/backup`, {}), { title: "Backing up volumes", done: "Volumes backed up", invalidate: [`/api/hosts/${hostId}/volumes`] });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <DiskCard
      hostId={hostId}
      host={host}
      onJump={(k) => {
        const el = k === "images" ? imagesRef.current : k === "volumes" ? volumesRef.current : null;
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    />
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))", gap: 16, alignItems: "start" }}>
      <div ref={imagesRef} className="glass-card" style={{ ...CARD, scrollMarginTop: 90 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Images</span>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{images ? `${plural(images.length, "image")} · ${bytes(imgSize)}` : "…"}</span>
          <button className="btn2 xs" style={{ marginLeft: "auto" }} disabled={!unusedImgs.length} onClick={pruneImages}>
            Remove unused
          </button>
          <button className="btn xs" onClick={() => shell.openDialog({ type: "pull", hostId })}>
            <Icon name="plus" size={14} />
            Pull image
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {!images && <RowsSkeleton n={5} />}
          {images && images.length === 0 && <Empty text="No images on this host yet." />}
          {images?.map((i) => {
            const used = i.containers > 0;
            return (
              <div key={i.id} className="row-hover" style={ROW}>
                <span style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(47,111,237,.1)", color: "#2f6fed", display: "grid", placeItems: "center", flex: "none" }}>
                  <Icon name="image" size={16} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <span className="ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>
                    {i.repo}
                    <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>:{i.tag || "<none>"}</span>
                  </span>
                  <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                    {i.shortId} · {ago(i.createdAt)}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12, color: "var(--ink)", whiteSpace: "nowrap" }}>{bytes(i.size)}</span>
                <span className={`tag ${used ? "ok" : i.dangling ? "warn" : "muted"}`}>{used ? (i.containers > 1 ? `${i.containers} in use` : "in use") : i.dangling ? "dangling" : "unused"}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div ref={volumesRef} className="glass-card" style={{ ...CARD, scrollMarginTop: 90 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16, fontWeight: 700 }}>Volumes</span>
          <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{volumes ? `${plural(volumes.length, "volume")} · ${bytes(volSize)}` : "…"}</span>
          <button className="btn2 xs" style={{ marginLeft: "auto" }} disabled={!volumes?.length} onClick={backupAll}>
            Backup all
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {!volumes && <RowsSkeleton n={4} />}
          {volumes && volumes.length === 0 && <Empty text="No volumes on this host." />}
          {volumes?.map((v) => {
            const used = v.containers.length > 0;
            return (
              <div key={v.name} className="row-hover" style={ROW}>
                <span style={{ width: 32, height: 32, borderRadius: 10, background: "rgba(122,92,240,.1)", color: "#7a5cf0", display: "grid", placeItems: "center", flex: "none" }}>
                  <Icon name="disk" size={16} />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                  <span className="ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{v.name}</span>
                  <span className="mono ellipsis" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{v.mountpoint}</span>
                </span>
                <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{v.size >= 0 ? bytes(v.size) : "—"}</span>
                <span className={`tag ${used ? "ok" : "muted"}`} title={v.containers.join(", ")} style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {used ? `in use by ${v.containers[0]}${v.containers.length > 1 ? ` +${v.containers.length - 1}` : ""}` : "unused"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </div>
  );
}

// ─── Disk usage treemap ────────────────────────────────────────────────────

const CAT_COLOR: Record<DiskUsage["categories"][number]["key"], string> = { images: C.blue, containers: C.violet, volumes: C.ok, buildCache: C.warn };
type Cell = DiskTreemapDatum & { key: string; cat?: string; share: number };

function DiskCard({ hostId, host, onJump }: { hostId: string; host: Host | undefined; onJump: (k: string) => void }) {
  const shell = useShell();
  const { data: du, error } = useApi<DiskUsage>(host && host.status !== "offline" ? `/api/hosts/${hostId}/disk` : null, { refresh: 60000 });
  const [hi, setHi] = useState<number | null>(null);

  const cells = useMemo<Cell[]>(() => {
    if (!du) return [];
    const out: Cell[] = [];
    const base = Math.max(1, du.capacity || du.used);
    for (const c of du.categories) {
      const color = CAT_COLOR[c.key] ?? C.blue;
      const rec = Math.min(c.size, Math.max(0, c.reclaimable));
      const used = c.size - rec;
      if (used > 0)
        out.push({ key: c.key, cat: c.key, name: c.label, value: used, color, ink: "#fff", sub: c.count ? `${c.active}/${c.count} in use` : undefined, share: used / base });
      if (rec > 0)
        out.push({ key: `${c.key}-rec`, cat: c.key, name: `${c.label} · unused`, value: rec, color: halo(color, 0.14), ink: color, reclaimable: true, sub: "reclaimable", share: rec / base });
    }
    // Show the free space too once the disk is at least half full — that's when it's worth seeing.
    const fsUsed = Math.max(du.used, host?.diskTotal === du.capacity ? host.diskUsed : 0);
    const free = du.capacity - fsUsed;
    if (du.capacity > 0 && free > 0 && fsUsed / du.capacity >= 0.5) out.push({ key: "free", name: "Free", value: free, color: "rgba(127,127,127,.12)", ink: "var(--ink-3)", share: free / base });
    return out.sort((a, b) => b.value - a.value);
  }, [du, host]);

  if (error || !host || host.status === "offline") return null;

  if (!du) {
    return (
      <div className="glass-card" style={{ borderRadius: 26, padding: "22px 24px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skel w={220} h={12} />
          <Skel w={180} h={30} />
        </div>
        <Skel w="100%" h={220} r={14} />
      </div>
    );
  }

  const pct = du.capacity > 0 ? Math.round((du.used / du.capacity) * 100) : 0;
  const cur = hi != null ? cells[hi] : null;
  const usedBase = Math.max(1, du.used);
  const hint = du.reclaimable > 0 ? "Dashed cells are unused images, stopped containers and build cache — safe to reclaim." : "Nothing to reclaim — every image and volume is in use.";

  return (
    <div className="glass-card" style={{ borderRadius: 26, padding: "22px 24px 20px", display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="ellipsis" style={{ fontSize: 12.5, color: "var(--ink-3)", fontWeight: 600 }}>
            Disk usage · <span className="mono">{du.root || "/var/lib/docker"}</span> on {host.name}
          </span>
          <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span className="big-num" style={{ fontSize: 34, lineHeight: 1 }}>{bytes(du.used)}</span>
            {du.capacity > 0 && (
              <span style={{ fontSize: 13, color: "var(--ink-3)" }}>
                of {bytes(du.capacity)} · {pct}% used
              </span>
            )}
          </span>
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--ink-2)", minHeight: 20, opacity: cur ? 1 : 0.7 }}>
          {cur ? (
            <>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: cur.reclaimable ? "transparent" : cur.color, border: cur.reclaimable ? `1.5px dashed ${cur.ink}` : undefined, boxSizing: "border-box" }} />
                {cur.name}
              </span>
              <span className="mono" style={{ color: "var(--ink)" }}>{bytes(cur.value)}</span>
              {cur.key !== "free" && <span style={{ color: "var(--ink-3)" }}>{Math.round((cur.value / usedBase) * 100)}% of docker</span>}
            </>
          ) : (
            <span style={{ color: "var(--ink-3)" }}>Hover a block for details</span>
          )}
        </span>
      </div>
      {cells.length > 0 ? (
        <DiskTreemap
          data={cells}
          height={220}
          formatValue={(v) => bytes(v)}
          highlight={hi}
          onHover={setHi}
          onPointClick={(d) => {
            const c = d as Cell;
            if (c.reclaimable) confirmPrune(shell, host, du.reclaimable);
            else if (c.cat) onJump(c.cat);
          }}
        />
      ) : (
        <div style={{ padding: "18px 12px", borderRadius: 14, border: "1px dashed var(--line-3)", fontSize: 12.5, color: "var(--ink-3)", textAlign: "center" }}>Docker isn&apos;t using any disk space yet.</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{hint}</span>
        <button className="btn xs" style={{ marginLeft: "auto", boxShadow: "none" }} disabled={du.reclaimable <= 0} onClick={() => confirmPrune(shell, host, du.reclaimable)}>
          <Icon name="clean" size={14} />
          Reclaim {bytes(du.reclaimable)}
        </button>
      </div>
    </div>
  );
}
