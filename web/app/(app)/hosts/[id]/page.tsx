"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { invalidate, post, useApi } from "@/lib/api";
import { plural } from "@/lib/format";
import type { Container, Host, Image, Network, Stack, Volume } from "@/lib/types";
import { EmptyState, Tabs } from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { useShell } from "@/components/shell/context";
import { HoverStyles } from "@/components/host/HoverStyles";
import { HostHeader, OfflineBanner } from "@/components/host/HostHeader";
import { ContainersTab } from "@/components/host/ContainersTab";
import { ContainerFilters } from "@/components/host/ContainerFilters";
import { SORTS, STATUS_FILTERS, visibleContainers, type ContainerView, type SortKey, type StatusFilter } from "@/lib/containerFilters";
import { StacksTab } from "@/components/host/StacksTab";
import { StorageTab } from "@/components/host/StorageTab";
import { NetworksTab } from "@/components/host/NetworksTab";
import { trackJob } from "@/components/host/jobs";
import type { JobRef } from "@/lib/types";

type Tab = "containers" | "stacks" | "storage" | "networks";
const TABS: Tab[] = ["containers", "stacks", "storage", "networks"];
/** Old tab names that still arrive via alert links / bookmarks. */
const TAB_ALIAS: Record<string, Tab> = { images: "storage", volumes: "storage" };

export default function HostPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense fallback={null}>
      <HostView key={id} />
    </Suspense>
  );
}

function HostView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const shell = useShell();

  const rawTab = params.get("tab");
  const tab: Tab = rawTab && (TABS as string[]).includes(rawTab) ? (rawTab as Tab) : (rawTab && TAB_ALIAS[rawTab]) || "containers";
  const cParam = params.get("c");

  // Container view state lives in the URL (?status=unhealthy&stack=web&sort=cpu&q=…) so it can be linked.
  const view: ContainerView = {
    q: params.get("q") ?? "",
    status: (STATUS_FILTERS.some((f) => f.value === params.get("status")) ? params.get("status") : "all") as StatusFilter,
    stack: params.get("stack") ?? "",
    sort: (SORTS.some((s) => s.value === params.get("sort")) ? params.get("sort") : "status") as SortKey,
  };
  const setView = useCallback(
    (p: Partial<ContainerView>) => {
      const q = new URLSearchParams(params.toString());
      const next = { ...view, ...p };
      const put = (k: string, v: string, def: string) => (v && v !== def ? q.set(k, v) : q.delete(k));
      put("q", next.q, "");
      put("status", next.status, "all");
      put("stack", next.stack, "");
      put("sort", next.sort, "status");
      const s = q.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, pathname, router, view.q, view.status, view.stack, view.sort],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const base = `/api/hosts/${id}`;
  const { data: host, error: hostErr } = useApi<Host>(base, { refresh: 10000 });
  const offline = host?.status === "offline";
  const { data: containers, error: ctrErr } = useApi<Container[]>(`${base}/containers`, { refresh: tab === "containers" ? 5000 : 15000 });
  const heavy = host && !offline;
  const { data: stacks, error: stacksErr } = useApi<Stack[]>(heavy ? `${base}/stacks` : null, { refresh: tab === "stacks" ? 8000 : 30000 });
  const { data: images, error: imagesErr } = useApi<Image[]>(heavy ? `${base}/images` : null, { refresh: tab === "storage" ? 15000 : 60000 });
  const { data: volumes, error: volumesErr } = useApi<Volume[]>(heavy ? `${base}/volumes` : null, { refresh: tab === "storage" ? 15000 : 60000 });
  const { data: networks, error: networksErr } = useApi<Network[]>(heavy ? `${base}/networks` : null, { refresh: tab === "networks" ? 10000 : 60000 });

  // Drop selections that no longer exist.
  useEffect(() => {
    if (!containers || selected.size === 0) return;
    const ids = new Set(containers.map((c) => c.id));
    const keep = [...selected].filter((s) => ids.has(s));
    if (keep.length !== selected.size) setSelected(new Set(keep));
  }, [containers, selected]);

  const goTab = useCallback(
    (t: Tab) => {
      const q = new URLSearchParams(params.toString());
      if (t === "containers") q.delete("tab");
      else q.set("tab", t);
      q.delete("c");
      const s = q.toString();
      router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false });
    },
    [params, pathname, router],
  );

  // Logs and shells moved to the floating terminal window: turn old
  // `?tab=logs|terminal&c=<id or name>` links into a terminal tab, then drop the params.
  const redirected = useRef<string | null>(null);
  useEffect(() => {
    if (rawTab !== "logs" && rawTab !== "terminal") return;
    const key = `${rawTab}:${cParam ?? ""}`;
    if (redirected.current === key || !host || (!containers && (cParam || rawTab === "logs"))) return;
    redirected.current = key;
    const list = containers ?? [];
    const c = cParam ? list.find((x) => x.id === cParam) ?? list.find((x) => x.id.startsWith(cParam) || x.name === cParam || x.name === `/${cParam}`) : null;
    if (rawTab === "logs") {
      const pick = c ?? list.find((x) => x.state === "running") ?? list[0];
      if (pick) shell.openTerminal({ kind: "logs", hostId: id, containerId: pick.id, name: pick.name });
      else if (cParam) shell.openTerminal({ kind: "logs", hostId: id, containerId: cParam, name: cParam });
    } else if (c || cParam) {
      shell.openTerminal({ kind: "exec", hostId: id, containerId: c?.id ?? cParam!, name: c?.name ?? cParam! });
    } else {
      shell.openTerminal({ kind: "shell", hostId: id });
    }
    goTab("containers");
  }, [rawTab, cParam, host, containers, id, shell, goTab]);

  if (hostErr && !host) {
    return (
      <EmptyState icon="server" title="Host not found" text={hostErr.message || "This host doesn't exist or was removed."}>
        <button className="btn" onClick={() => router.push("/")}>
          Back to fleet
        </button>
      </EmptyState>
    );
  }

  const updateCount = (containers ?? []).filter((c) => c.update?.available).length;
  const icons: Record<Tab, IconName> = { containers: "box", stacks: "layers", storage: "disk", networks: "network" };
  const labels: Record<Tab, string> = { containers: "Containers", stacks: "Stacks", storage: "Storage", networks: "Networks" };
  const counts: Partial<Record<Tab, number | undefined>> = { containers: containers?.length, stacks: stacks?.length, storage: images && volumes ? images.length + volumes.length : undefined, networks: networks?.length };

  const bulk = async (action: "start" | "restart" | "stop") => {
    const ids = [...selected];
    if (action === "stop") {
      const names = (containers ?? []).filter((c) => selected.has(c.id)).map((c) => c.name);
      const ok = await shell.confirm({
        title: `Stop ${plural(ids.length, "container")}?`,
        text: "They stay on the host and can be started again. Anything they serve is unavailable until then.",
        confirmLabel: "Stop",
        danger: true,
        icon: "stop",
        details: names.slice(0, 4).map((n) => ({ k: n, v: "running → stopped" })),
      });
      if (!ok) return;
    }
    try {
      const r = await post<{ ok: string[]; failed: { id: string; error: string }[] }>(`${base}/containers/bulk`, { ids, action });
      const verb = action === "start" ? "Started" : action === "stop" ? "Stopped" : "Restarted";
      if (r.failed?.length) shell.toast({ kind: "warn", title: `${verb} ${r.ok.length} of ${ids.length}`, text: r.failed.map((f) => f.error).slice(0, 2).join(" · ") });
      else shell.toast({ kind: "ok", title: `${verb} ${plural(r.ok.length, "container")}` });
      setSelected(new Set());
    } catch (e) {
      shell.toast({ kind: "error", title: `Bulk ${action} failed`, text: e instanceof Error ? e.message : String(e) });
    }
    invalidate(base);
    invalidate("/api/overview");
  };

  const updateAll = async () => {
    const ok = await shell.confirm({
      title: `Update ${plural(updateCount, "container")}?`,
      text: "Dockhand pulls each new image and recreates the container with the same configuration. Each one restarts briefly.",
      confirmLabel: "Update all",
      icon: "update",
      details: (containers ?? []).filter((c) => c.update?.available).slice(0, 5).map((c) => ({ k: c.name, v: c.update.tag })),
    });
    if (!ok) return;
    trackJob(shell, post<JobRef>(`${base}/update-all`), { title: `Updating containers on ${host?.name ?? "host"}`, done: "Containers updated", invalidate: [base, "/api/containers", "/api/overview", "/api/hosts"] });
  };

  return (
    <section data-screen-label="Host" style={{ animation: "rise .4s ease both", display: "flex", flexDirection: "column", gap: 20 }}>
      <HoverStyles />
      <HostHeader host={host} containers={containers} />
      {host && offline && <OfflineBanner host={host} />}

      <div style={{ display: "flex", flexDirection: "column", gap: 20, opacity: offline ? 0.45 : 1, pointerEvents: offline ? "none" : undefined, transition: "opacity .2s" }} aria-disabled={offline || undefined}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ maxWidth: "100%", overflowX: "auto" }}>
            <Tabs items={TABS.map((t) => ({ value: t, label: labels[t], icon: icons[t], count: counts[t] }))} value={tab} onChange={(t) => goTab(t)} />
          </div>
          {tab === "containers" && (
            <>
              {updateCount > 0 && (
                <button className="upd-btn" onClick={updateAll} style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 14px 0 10px", borderRadius: 12, border: "1px solid rgba(47,111,237,.35)", background: "rgba(47,111,237,.08)", color: "#2f6fed", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  <Icon name="update" size={15} strokeWidth={2} />
                  {plural(updateCount, "update")}
                </button>
              )}
              <FilterInput value={view.q} onChange={(q) => setView({ q })} />
              {selected.size > 0 && (
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
            </>
          )}
        </div>

        {/* A failed fetch shows an error card instead of an endless skeleton (offline hosts get the banner above). */}
        {!offline && tabError(tab, { containers: !containers && ctrErr, stacks: !stacks && stacksErr, storage: (!images && imagesErr) || (!volumes && volumesErr), networks: !networks && networksErr }, base)}
        {tab === "containers" && containers && containers.length > 0 && (
          <ContainerFilters
            containers={containers}
            view={view}
            shown={visibleContainers(containers, view).length}
            onChange={setView}
            onSelectShown={() => setSelected(new Set(visibleContainers(containers, view).map((c) => c.id)))}
          />
        )}
        {tab === "containers" && !(!containers && ctrErr) && <ContainersTab hostId={id} host={host} containers={containers} view={view} selected={selected} setSelected={setSelected} />}
        {tab === "stacks" && !(!stacks && stacksErr) && <StacksTab hostId={id} stacks={stacks} />}
        {tab === "storage" && !((!images && imagesErr) || (!volumes && volumesErr)) && <StorageTab hostId={id} host={host} images={images} volumes={volumes} />}
        {tab === "networks" && !(!networks && networksErr) && <NetworksTab hostId={id} networks={networks} />}
      </div>
    </section>
  );
}

function tabError(tab: Tab, errs: Record<Tab, Error | false | undefined>, base: string) {
  const e = errs[tab];
  if (!e) return null;
  const what: Record<Tab, string> = { containers: "containers", stacks: "stacks", storage: "images and volumes", networks: "networks" };
  return (
    <EmptyState icon="alert" title={`Couldn't load ${what[tab]}`} text={e.message || "The host didn't answer. Dockhand keeps retrying in the background."}>
      <button className="btn2" style={{ height: 40 }} onClick={() => invalidate(base)}>
        <Icon name="restart" size={15} />
        Try again
      </button>
    </EmptyState>
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
