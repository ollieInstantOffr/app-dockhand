"use client";

import { Children, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { invalidate, post, useApi } from "@/lib/api";
import { C, ago, bytes, containerColor, plural } from "@/lib/format";
import type { Container, FleetList, Host, Image, JobRef, Network, Stack, Volume } from "@/lib/types";
import { Dropdown, EmptyState, PageHeader, Tabs } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { HoverStyles } from "@/components/host/HoverStyles";
import { trackJob } from "@/components/host/jobs";
import { CTR_GRID, ContainerCard } from "@/components/host/ContainersTab";
import { ContainerFilters } from "@/components/host/ContainerFilters";
import { SORTS, STATUS_FILTERS, visibleContainers, type ContainerView, type SortKey, type StatusFilter } from "@/lib/containerFilters";

// Fleet-wide views: every container, stack, image, volume and network on every host.

type Tab = "containers" | "stacks" | "images" | "volumes" | "networks";
const TABS: Tab[] = ["containers", "stacks", "images", "volumes", "networks"];
const ICONS: Record<Tab, IconName> = { containers: "box", stacks: "layers", images: "image", volumes: "disk", networks: "network" };
const LABELS: Record<Tab, string> = { containers: "Containers", stacks: "Stacks", images: "Images", volumes: "Volumes", networks: "Networks" };
// Where a row opens on its host page.
const HOST_TAB: Record<Tab, string> = { containers: "", stacks: "stacks", images: "storage", volumes: "storage", networks: "networks" };

const PAGE = 150; // rows rendered before "Show more"
const CARD: React.CSSProperties = { borderRadius: 22, padding: "8px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const ROW: React.CSSProperties = { display: "grid", alignItems: "center", gap: 14, padding: "10px 14px", borderRadius: 14, border: 0, background: "transparent", minWidth: 0, textAlign: "left", cursor: "pointer", color: "var(--ink)", width: "100%", font: "inherit" };
const HEAD: React.CSSProperties = { ...ROW, cursor: "default", padding: "6px 14px 4px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--ink-3)" };

export default function ResourcesPage() {
  return (
    <Suspense fallback={null}>
      <Resources />
    </Suspense>
  );
}

function Resources() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const shell = useShell();

  const tab: Tab = (TABS as string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "containers";
  const hostF = params.get("host") ?? "";
  const view: ContainerView = {
    q: params.get("q") ?? "",
    status: (STATUS_FILTERS.some((f) => f.value === params.get("status")) ? params.get("status") : "all") as StatusFilter,
    stack: params.get("stack") ?? "",
    sort: (SORTS.some((s) => s.value === params.get("sort")) ? params.get("sort") : "status") as SortKey,
  };
  const only = params.get("only") ?? ""; // images: unused | dangling; volumes: unused; networks: system

  const setParams = useCallback(
    (p: Record<string, string>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(p)) {
        const def = k === "status" ? "all" : k === "sort" ? "status" : k === "tab" ? "containers" : "";
        if (v && v !== def) q.set(k, v);
        else q.delete(k);
      }
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  const setView = (p: Partial<ContainerView>) => setParams(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])));

  const { data: hosts } = useApi<Host[]>("/api/hosts", { refresh: 30000 });
  const { data: containers, error: ctrErr } = useApi<Container[]>("/api/containers", { refresh: tab === "containers" ? 5000 : 30000 });
  const stacks = useApi<FleetList<Stack>>(tab === "stacks" ? "/api/fleet/stacks" : null, { refresh: 15000 });
  const images = useApi<FleetList<Image>>(tab === "images" ? "/api/fleet/images" : null, { refresh: 30000 });
  const volumes = useApi<FleetList<Volume>>(tab === "volumes" ? "/api/fleet/volumes" : null, { refresh: 30000 });
  const networks = useApi<FleetList<Network>>(tab === "networks" ? "/api/fleet/networks" : null, { refresh: 30000 });

  const hostById = useMemo(() => new Map((hosts ?? []).map((h) => [h.id, h])), [hosts]);
  const hostCtrs = useMemo(() => (containers ?? []).filter((c) => hostById.has(c.hostId) && (!hostF || c.hostId === hostF)), [containers, hostById, hostF]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // "hostId/containerId"
  const selKey = (c: Container) => `${c.hostId}/${c.id}`;

  useEffect(() => {
    if (!containers || selected.size === 0) return;
    const ids = new Set(containers.map(selKey));
    const keep = [...selected].filter((s) => ids.has(s));
    if (keep.length !== selected.size) setSelected(new Set(keep));
  }, [containers, selected]);

  const openOnHost = (hostId: string, t: Tab) => router.push(`/hosts/${hostId}${HOST_TAB[t] ? `?tab=${HOST_TAB[t]}` : ""}`);

  const bulk = async (action: "start" | "restart" | "stop") => {
    const picked = (containers ?? []).filter((c) => selected.has(selKey(c)));
    if (action === "stop") {
      const ok = await shell.confirm({
        title: `Stop ${plural(picked.length, "container")}?`,
        text: "They stay on their hosts and can be started again. Anything they serve is unavailable until then.",
        confirmLabel: "Stop",
        danger: true,
        icon: "stop",
        details: picked.slice(0, 4).map((c) => ({ k: c.name, v: hostById.get(c.hostId)?.name ?? "" })),
      });
      if (!ok) return;
    }
    const byHost = new Map<string, string[]>();
    for (const c of picked) byHost.set(c.hostId, [...(byHost.get(c.hostId) ?? []), c.id]);
    let okN = 0;
    const errs: string[] = [];
    await Promise.all(
      [...byHost].map(async ([hostId, ids]) => {
        try {
          const r = await post<{ ok: string[]; failed: { id: string; error: string }[] }>(`/api/hosts/${hostId}/containers/bulk`, { ids, action });
          okN += r.ok.length;
          errs.push(...(r.failed ?? []).map((f) => f.error));
        } catch (e) {
          errs.push(`${hostById.get(hostId)?.name ?? "host"}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
    const verb = action === "start" ? "Started" : action === "stop" ? "Stopped" : "Restarted";
    if (errs.length) shell.toast({ kind: "warn", title: `${verb} ${okN} of ${picked.length}`, text: errs.slice(0, 2).join(" · ") });
    else shell.toast({ kind: "ok", title: `${verb} ${plural(okN, "container")}`, text: byHost.size > 1 ? `on ${byHost.size} hosts` : undefined });
    setSelected(new Set());
    invalidate("/api/containers");
    invalidate("/api/hosts");
    invalidate("/api/overview");
  };

  // Prune stopped containers, unused images/networks and build cache on every online host (or the selected one).
  const cleanup = async () => {
    const targets = (hosts ?? []).filter((h) => h.status !== "offline" && h.status !== "pending" && (!hostF || h.id === hostF));
    if (!targets.length) return;
    const ok = await shell.confirm({
      title: targets.length === 1 ? `Clean up ${targets[0].name}?` : `Clean up ${plural(targets.length, "host")}?`,
      text: "Removes stopped containers, unused images, unused networks and the build cache. Volumes are kept.",
      confirmLabel: "Clean up",
      danger: true,
      icon: "clean",
      details: targets.slice(0, 5).map((h) => ({ k: h.name, v: `${Math.max(0, h.total - h.running)} stopped` })),
    });
    if (!ok) return;
    for (const h of targets) {
      trackJob(shell, post<JobRef>(`/api/hosts/${h.id}/prune`, { containers: true, images: true, networks: true, volumes: false, buildCache: true }), {
        title: `Cleaning up ${h.name}`,
        done: `${h.name} cleaned up`,
        invalidate: ["/api/fleet", "/api/hosts", "/api/containers", "/api/overview"],
      });
    }
  };

  const lists: Record<Exclude<Tab, "containers">, { data?: FleetList<unknown>; error?: Error }> = { stacks, images, volumes, networks };
  const cur = tab === "containers" ? null : lists[tab];
  const failed = cur?.data ? [...cur.data.errors] : [];
  const skipped = cur?.data ? cur.data.skipped : (hosts ?? []).filter((h) => h.status === "offline" || h.status === "pending").map((h) => ({ hostId: h.id, hostName: h.name, error: `host is ${h.status}` }));

  const online = (hosts ?? []).filter((h) => h.status !== "offline" && h.status !== "pending").length;
  const running = (containers ?? []).filter((c) => c.state === "running").length;
  const sub = hosts && containers
    ? `One list per kind across all ${plural(hosts.length, "host")}${online < hosts.length ? ` (${online} reachable)` : ""} · ${plural(containers.length, "container")}, ${running} running`
    : "One list per kind, across every host";

  const hostOptions = [{ value: "", label: "All hosts" }, ...(hosts ?? []).map((h) => ({ value: h.id, label: h.name, dot: h.status === "online" ? C.ok : h.status === "offline" ? C.crit : C.warn }))];

  return (
    <section data-screen-label="All resources" style={{ animation: "rise .4s ease both", display: "flex", flexDirection: "column", gap: 20 }}>
      <HoverStyles />
      <PageHeader title={hostF ? `All resources · ${hostById.get(hostF)?.name ?? ""}` : "All resources"} sub={sub}>
        <Dropdown<string> value={hostF} options={hostOptions} onChange={(v) => setParams({ host: v })} icon={<Icon name="server" size={15} />} minWidth={180} />
      </PageHeader>

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ maxWidth: "100%", overflowX: "auto" }}>
          <Tabs
            items={TABS.map((t) => ({ value: t, label: LABELS[t], icon: ICONS[t], count: t === "containers" ? hostCtrs.length || undefined : undefined }))}
            value={tab}
            onChange={(t) => {
              setSelected(new Set());
              setParams({ tab: t, only: "", stack: "", status: "", sort: "" });
            }}
          />
        </div>
        <FilterInput value={view.q} onChange={(q) => setParams({ q })} />
        {tab === "containers" && selected.size > 0 && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, padding: "5px 6px 5px 14px", borderRadius: 14, background: "var(--btn)", color: "var(--btn-ink)", fontSize: 13, boxShadow: "0 10px 24px rgba(23,26,33,.25)", animation: "rise .25s ease both", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>{selected.size} selected</span>
            {(["start", "restart", "stop"] as const).map((a) => (
              <button key={a} className="ink-fill" onClick={() => bulk(a)} style={{ height: 28, padding: "0 12px", borderRadius: 9, border: 0, background: "rgba(127,127,127,.22)", color: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                {a[0].toUpperCase() + a.slice(1)}
              </button>
            ))}
            <button className="bulk-x" aria-label="Clear selection" onClick={() => setSelected(new Set())} style={{ height: 28, width: 28, borderRadius: 9, border: 0, background: "transparent", color: "inherit", cursor: "pointer", opacity: 0.7 }}>
              ✕
            </button>
          </div>
        )}
      </div>

      <HostProblems failed={failed} skipped={skipped.filter((s) => !hostF || s.hostId === hostF)} />

      {tab === "containers" && (
        <>
          {!containers && ctrErr && <EmptyState icon="alert" title="Couldn't load containers" text={ctrErr.message} />}
          {containers && hostCtrs.length > 0 && (
            <ContainerFilters
              containers={hostCtrs}
              view={view}
              shown={visibleContainers(hostCtrs, view).length}
              onChange={setView}
              onSelectShown={() => setSelected(new Set(visibleContainers(hostCtrs, view).map(selKey)))}
            />
          )}
          {!containers && !ctrErr && <Skeleton />}
          {containers && <ContainerGrid list={visibleContainers(hostCtrs, view)} empty={hostCtrs.length === 0} hostById={hostById} selected={selected} setSelected={setSelected} selKey={selKey} />}
        </>
      )}
      {tab === "stacks" && <StacksList data={stacks.data} error={stacks.error} q={view.q} hostF={hostF} open={(h) => openOnHost(h, "stacks")} />}
      {tab === "images" && <ImagesList data={images.data} error={images.error} q={view.q} hostF={hostF} only={only} setOnly={(v) => setParams({ only: v })} open={(h) => openOnHost(h, "images")} onCleanup={cleanup} />}
      {tab === "volumes" && <VolumesList data={volumes.data} error={volumes.error} q={view.q} hostF={hostF} only={only} setOnly={(v) => setParams({ only: v })} open={(h) => openOnHost(h, "volumes")} />}
      {tab === "networks" && <NetworksList data={networks.data} error={networks.error} q={view.q} hostF={hostF} only={only} setOnly={(v) => setParams({ only: v })} open={(h) => openOnHost(h, "networks")} />}
    </section>
  );
}

function ContainerGrid({ list, empty, hostById, selected, setSelected, selKey }: { list: Container[]; empty: boolean; hostById: Map<string, Host>; selected: Set<string>; setSelected: (s: Set<string>) => void; selKey: (c: Container) => string }) {
  if (empty) return <EmptyState icon="box" title="No containers" text="Nothing is running on these hosts yet." />;
  if (!list.length) return <div style={{ padding: "28px 4px", fontSize: 13.5, color: "var(--ink-3)" }}>No containers match these filters.</div>;
  const toggle = (k: string) => {
    const n = new Set(selected);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setSelected(n);
  };
  return (
    <div style={CTR_GRID}>
      {list.map((c) => {
        const h = hostById.get(c.hostId);
        return <ContainerCard key={selKey(c)} c={c} hostId={c.hostId} hostName={h?.name ?? "?"} memTotal={h?.memTotal ?? 0} selected={selected.has(selKey(c))} onToggle={() => toggle(selKey(c))} />;
      })}
    </div>
  );
}

/** Hosts that were skipped (offline) or failed to answer. */
function HostProblems({ failed, skipped }: { failed: { hostName: string; error: string }[]; skipped: { hostName: string; error: string }[] }) {
  if (!failed.length && !skipped.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px", borderRadius: 14, background: "var(--fill-1)", fontSize: 12.5 }}>
      {failed.map((f) => (
        <span key={`f-${f.hostName}`} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.crit, flex: "none", transform: "translateY(-1px)" }} />
          <b>{f.hostName}</b>
          <span className="ellipsis" style={{ color: "var(--ink-3)" }}>didn&apos;t answer: {f.error}</span>
        </span>
      ))}
      {skipped.length > 0 && (
        <span style={{ display: "flex", gap: 8, alignItems: "baseline", color: "var(--ink-3)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#9aa1ad", flex: "none", transform: "translateY(-1px)" }} />
          Not included (offline): {skipped.map((s) => s.hostName).join(", ")}
        </span>
      )}
    </div>
  );
}

// ─── Tables ──────────────────────────────────────────────────────────────

type ListProps<T> = { data?: FleetList<T>; error?: Error; q: string; hostF: string; open: (hostId: string) => void };

function useRows<T>(data: FleetList<T> | undefined, hostF: string, q: string, text: (t: T) => string, extra?: (t: T) => boolean) {
  return useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.items ?? []).filter((r) => (!hostF || r.hostId === hostF) && (!s || `${text(r.item)} ${r.hostName}`.toLowerCase().includes(s)) && (!extra || extra(r.item)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hostF, q, extra]);
}

function Frame({ loading, error, count, empty, summary, chips, cols, head, children }: { loading: boolean; error?: Error; count: number; empty: string; summary?: React.ReactNode; chips?: React.ReactNode; cols: string; head: string[]; children: React.ReactNode }) {
  const [limit, setLimit] = useState(PAGE);
  if (error && loading) return <EmptyState icon="alert" title="Couldn't load" text={error.message} />;
  const rows = Children.toArray(children);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(summary || chips) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: "var(--ink-2)" }}>
          {summary}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>{chips}</span>
        </div>
      )}
      {loading ? (
        <Skeleton />
      ) : count === 0 ? (
        <div style={{ padding: "28px 4px", fontSize: 13.5, color: "var(--ink-3)" }}>{empty}</div>
      ) : (
        <div className="glass-card" style={CARD}>
          <div className="fleet-head" style={{ ...HEAD, gridTemplateColumns: cols }}>
            {head.map((h, i) => (
              <span key={i} className={i > 1 && i < head.length - 1 ? "fleet-opt" : undefined} style={{ textAlign: i >= head.length - 1 && i > 1 ? "right" : undefined }}>
                {h}
              </span>
            ))}
          </div>
          {rows.slice(0, limit)}
          {rows.length > limit && (
            <button type="button" className="btn2" onClick={() => setLimit(limit + PAGE * 2)} style={{ alignSelf: "center", margin: "8px 0 6px", height: 34 }}>
              Show more · {rows.length - limit} left
            </button>
          )}
        </div>
      )}
      <style>{`.fleet-row:hover{background:var(--fill-1)}@media (max-width:720px){.fleet-opt{display:none}.fleet-row,.fleet-head{grid-template-columns:minmax(0,1fr) auto auto !important}}`}</style>
    </div>
  );
}

function HostTag({ name }: { name: string }) {
  return (
    <span className="ellipsis" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-2)", minWidth: 0 }}>
      <Icon name="server" size={12} />
      {name}
    </span>
  );
}

function Chip({ on, label, count, onClick }: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} style={{ height: 30, padding: "0 12px", borderRadius: 10, border: 0, background: on ? "var(--btn)" : "var(--fill-1)", color: on ? "var(--btn-ink)" : "var(--ink)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
      {label}
      {count != null && <span style={{ opacity: 0.6, fontWeight: 700 }}>{count}</span>}
    </button>
  );
}

const Muted = ({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }) => (
  <span className={`fleet-opt ellipsis${mono ? " mono" : ""}`} style={{ fontSize: 12, color: "var(--ink-3)", textAlign: right ? "right" : undefined }}>
    {children}
  </span>
);

function StacksList({ data, error, q, hostF, open }: ListProps<Stack>) {
  const rows = useRows(data, hostF, q, (s) => `${s.name} ${s.repo} ${s.services.map((x) => `${x.name} ${x.image}`).join(" ")}`);
  const cols = "minmax(0,1.4fr) minmax(0,0.8fr) minmax(0,1fr) 110px 90px";
  const color = { running: C.ok, partial: C.warn, stopped: "#9aa1ad" };
  return (
    <Frame loading={!data} error={error} count={rows.length} empty="No stacks match." cols={cols} head={["Stack", "Host", "Source", "Services", "Deployed"]} summary={data && <span>{plural(rows.length, "stack")}</span>}>
      {rows.map(({ hostId, hostName, item: s }) => {
        const up = s.services.filter((x) => x.state === "running").length;
        return (
          <button key={`${hostId}/${s.name}`} className="fleet-row" onClick={() => open(hostId)} style={{ ...ROW, gridTemplateColumns: cols }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color[s.status], flex: "none" }} />
              <span className="ellipsis" style={{ fontWeight: 700, fontSize: 13.5 }}>{s.name}</span>
            </span>
            <HostTag name={hostName} />
            <Muted mono>{s.source === "git" ? `${s.repo}@${s.branch}` : s.source}</Muted>
            <Muted>{`${up}/${s.services.length} running`}</Muted>
            <span style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "right", whiteSpace: "nowrap" }}>{s.lastDeployAt ? ago(s.lastDeployAt) : "—"}</span>
          </button>
        );
      })}
    </Frame>
  );
}

function ImagesList({ data, error, q, hostF, only, setOnly, open, onCleanup }: ListProps<Image> & { only: string; setOnly: (v: string) => void; onCleanup?: () => void }) {
  const all = useRows(data, hostF, q, (i) => `${i.repo}:${i.tag} ${i.shortId}`);
  const rows = only === "unused" ? all.filter((r) => r.item.containers === 0) : only === "dangling" ? all.filter((r) => r.item.dangling) : all;
  const size = (list: typeof all) => list.reduce((n, r) => n + r.item.size, 0);
  const unused = all.filter((r) => r.item.containers === 0);
  const cols = "minmax(0,1.6fr) minmax(0,0.8fr) 90px 90px 90px";
  return (
    <Frame
      loading={!data}
      error={error}
      count={rows.length}
      empty="No images match."
      cols={cols}
      head={["Image", "Host", "Used by", "Created", "Size"]}
      summary={
        data && (
          <span title="Images share layers, so this adds some space more than once. Clean up reports what was actually freed.">
            {plural(rows.length, "image")} · up to {bytes(size(rows))}
          </span>
        )
      }
      chips={
        <>
          {onCleanup && unused.length > 0 && (
            <button type="button" className="btn2" onClick={onCleanup} style={{ height: 30, padding: "0 12px", fontSize: 12.5 }}>
              <Icon name="clean" size={14} />
              Clean up…
            </button>
          )}
          <Chip on={!only} label="All" count={all.length} onClick={() => setOnly("")} />
          <Chip on={only === "unused"} label="Unused" count={unused.length} onClick={() => setOnly("unused")} />
          <Chip on={only === "dangling"} label="Dangling" count={all.filter((r) => r.item.dangling).length} onClick={() => setOnly("dangling")} />
        </>
      }
    >
      {rows.map(({ hostId, hostName, item: i }) => (
        <button key={`${hostId}/${i.id}/${i.repo}:${i.tag}`} className="fleet-row" onClick={() => open(hostId)} style={{ ...ROW, gridTemplateColumns: cols }}>
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>
              {i.dangling ? "<none>" : i.repo}
              <span style={{ color: "var(--ink-3)" }}>:{i.tag}</span>
            </span>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{i.shortId}</span>
          </span>
          <HostTag name={hostName} />
          <Muted>{i.containers ? plural(i.containers, "container") : "unused"}</Muted>
          <Muted>{ago(i.createdAt)}</Muted>
          <span className="mono" style={{ fontSize: 12.5, textAlign: "right", fontWeight: 600 }}>{bytes(i.size)}</span>
        </button>
      ))}
    </Frame>
  );
}

function VolumesList({ data, error, q, hostF, only, setOnly, open }: ListProps<Volume> & { only: string; setOnly: (v: string) => void }) {
  const all = useRows(data, hostF, q, (v) => `${v.name} ${v.driver} ${v.containers.join(" ")}`);
  const unused = all.filter((r) => r.item.containers.length === 0);
  const rows = only === "unused" ? unused : all;
  const known = rows.filter((r) => r.item.size >= 0).reduce((n, r) => n + r.item.size, 0);
  const cols = "minmax(0,1.4fr) minmax(0,0.8fr) minmax(0,1.2fr) 70px 90px";
  return (
    <Frame
      loading={!data}
      error={error}
      count={rows.length}
      empty="No volumes match."
      cols={cols}
      head={["Volume", "Host", "Used by", "Driver", "Size"]}
      summary={data && <span>{plural(rows.length, "volume")}{known > 0 ? ` · ${bytes(known)}` : ""}</span>}
      chips={
        <>
          <Chip on={!only} label="All" count={all.length} onClick={() => setOnly("")} />
          <Chip on={only === "unused"} label="Unused" count={unused.length} onClick={() => setOnly("unused")} />
        </>
      }
    >
      {rows.map(({ hostId, hostName, item: v }) => (
        <button key={`${hostId}/${v.name}`} className="fleet-row" onClick={() => open(hostId)} style={{ ...ROW, gridTemplateColumns: cols }}>
          <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 600 }} title={v.name}>{v.name}</span>
          <HostTag name={hostName} />
          <Muted>{v.containers.length ? v.containers.join(", ") : "unused"}</Muted>
          <Muted>{v.driver}</Muted>
          <span className="mono" style={{ fontSize: 12.5, textAlign: "right", fontWeight: 600 }}>{v.size >= 0 ? bytes(v.size) : "—"}</span>
        </button>
      ))}
    </Frame>
  );
}

function NetworksList({ data, error, q, hostF, only, setOnly, open }: ListProps<Network> & { only: string; setOnly: (v: string) => void }) {
  const all = useRows(data, hostF, q, (n) => `${n.name} ${n.driver} ${n.subnet} ${n.members.map((m) => `${m.name} ${m.ip}`).join(" ")}`);
  const rows = only === "system" ? all : all.filter((r) => !r.item.system);
  const cols = "minmax(0,1.3fr) minmax(0,0.8fr) 80px minmax(0,1fr) 110px";
  return (
    <Frame
      loading={!data}
      error={error}
      count={rows.length}
      empty="No networks match."
      cols={cols}
      head={["Network", "Host", "Driver", "Subnet", "Containers"]}
      summary={data && <span>{plural(rows.length, "network")}</span>}
      chips={<Chip on={only === "system"} label="Show bridge / host / none" onClick={() => setOnly(only === "system" ? "" : "system")} />}
    >
      {rows.map(({ hostId, hostName, item: n }) => {
        const up = n.members.filter((m) => m.state === "running").length;
        return (
          <button key={`${hostId}/${n.id}`} className="fleet-row" onClick={() => open(hostId)} style={{ ...ROW, gridTemplateColumns: cols }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className="mono ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{n.name}</span>
              {n.internal && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 6, background: "var(--fill-1)", color: "var(--ink-3)" }}>internal</span>}
            </span>
            <HostTag name={hostName} />
            <Muted>{n.driver}</Muted>
            <Muted mono>{n.subnet || "—"}</Muted>
            <span style={{ fontSize: 12.5, textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              {n.members.length > 0 && <span style={{ width: 7, height: 7, borderRadius: "50%", background: containerColor(up ? "running" : "exited") }} />}
              {n.members.length ? `${up}/${n.members.length}` : "none"}
            </span>
          </button>
        );
      })}
    </Frame>
  );
}

function Skeleton() {
  return (
    <div className="glass-card" style={{ ...CARD, padding: 14, gap: 10 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className="skel" style={{ height: 18, width: `${90 - i * 9}%` }} />
      ))}
    </div>
  );
}

/** Text filter with local state so typing isn't slowed by URL updates. */
function FilterInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onChange(v), 250);
    return () => clearTimeout(t);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return <input className="filter-input" placeholder="Filter…" value={v} onChange={(e) => setV(e.target.value)} />;
}
