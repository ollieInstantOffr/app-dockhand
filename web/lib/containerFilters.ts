import type { Container } from "./types";

// Status buckets for the container filter bar. A container can be in several
// (e.g. running + healthy + has an update).
export type StatusFilter = "all" | "running" | "healthy" | "unhealthy" | "starting" | "stopped" | "crashed" | "paused" | "restarting" | "updates";
export type SortKey = "status" | "name" | "cpu" | "mem" | "newest" | "oldest";

export const STATUS_FILTERS: { value: StatusFilter; label: string; color?: string; always?: boolean }[] = [
  { value: "all", label: "All", always: true },
  { value: "running", label: "Running", color: "#22a06b", always: true },
  { value: "healthy", label: "Healthy", color: "#22a06b" },
  { value: "unhealthy", label: "Unhealthy", color: "#e2504c" },
  { value: "starting", label: "Starting", color: "#e0a020" },
  { value: "restarting", label: "Restarting", color: "#e0a020" },
  { value: "paused", label: "Paused", color: "#e0a020" },
  { value: "stopped", label: "Stopped", color: "#9aa1ad", always: true },
  { value: "crashed", label: "Crashed", color: "#e2504c" },
  { value: "updates", label: "Updates", color: "#2f6fed" },
];

export const SORTS: { value: SortKey; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "name", label: "Name" },
  { value: "cpu", label: "CPU" },
  { value: "mem", label: "Memory" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

export function matchesStatus(c: Container, f: StatusFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "running":
      return c.state === "running";
    case "healthy":
      return c.state === "running" && c.health === "healthy";
    case "unhealthy":
      return c.health === "unhealthy";
    case "starting":
      return c.state === "running" && c.health === "starting";
    case "restarting":
      return c.state === "restarting";
    case "paused":
      return c.state === "paused";
    case "stopped":
      return c.state === "exited" || c.state === "created" || c.state === "dead";
    case "crashed":
      return c.state === "dead" || (c.state === "exited" && c.exitCode !== 0);
    case "updates":
      return !!c.update?.available;
  }
}

export function statusCounts(list: Container[]): Record<StatusFilter, number> {
  const out = {} as Record<StatusFilter, number>;
  for (const f of STATUS_FILTERS) out[f.value] = list.filter((c) => matchesStatus(c, f.value)).length;
  return out;
}

/** Problems first, then running, then the rest — the default ordering. */
function statusRank(c: Container): number {
  if (c.health === "unhealthy" || c.state === "dead" || (c.state === "exited" && c.exitCode !== 0)) return 0;
  if (c.state === "restarting" || c.health === "starting") return 1;
  if (c.state === "running") return 2;
  if (c.state === "paused") return 3;
  return 4;
}

const time = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0);

export function sortBy(list: Container[], key: SortKey): Container[] {
  const byName = (a: Container, b: Container) => a.name.localeCompare(b.name);
  const cmp: Record<SortKey, (a: Container, b: Container) => number> = {
    status: (a, b) => statusRank(a) - statusRank(b) || byName(a, b),
    name: byName,
    cpu: (a, b) => b.cpu - a.cpu || byName(a, b),
    mem: (a, b) => b.memUsed - a.memUsed || byName(a, b),
    newest: (a, b) => time(b.startedAt ?? b.createdAt) - time(a.startedAt ?? a.createdAt) || byName(a, b),
    oldest: (a, b) => time(a.startedAt ?? a.createdAt) - time(b.startedAt ?? b.createdAt) || byName(a, b),
  };
  return [...list].sort(cmp[key]);
}

export const NO_STACK = "__none__";

export interface ContainerView {
  q: string;
  status: StatusFilter;
  stack: string; // "" = all, NO_STACK = containers outside compose
  sort: SortKey;
}

export function matchText(c: Container, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return c.name.toLowerCase().includes(s) || c.image.toLowerCase().includes(s) || c.stack.toLowerCase().includes(s) || c.status.toLowerCase().includes(s);
}

export function visibleContainers(list: Container[], v: ContainerView): Container[] {
  const inStack = (c: Container) => !v.stack || (v.stack === NO_STACK ? !c.stack : c.stack === v.stack);
  return sortBy(list.filter((c) => inStack(c) && matchesStatus(c, v.status) && matchText(c, v.q)), v.sort);
}
