import type { ContainerState, Health, HostStatus, PortMap, Severity, UpStatus } from "./types";

export function bytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(digits)} ${u[i]}`;
}

/** Compact bytes for tight spots: "412M", "1.2G". */
export function bytesShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const u = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
}

export function pct(n: number, digits = 0): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return `${n.toFixed(digits)}%`;
}

export function uptimePct(n: number): string {
  if (n < 0) return "—";
  if (n >= 99.995) return "100%";
  return `${n.toFixed(n >= 99 ? 2 : 1)}%`;
}

/** Duration in seconds → "12d 4h", "3h 20m", "45s". */
export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

export function since(iso: string | null | undefined): number {
  if (!iso) return -1;
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

/** "just now", "4m ago", "3h ago", "2d ago", then a date. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = since(iso);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(iso: string | null | undefined, seconds = true): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ─── Status colours ────────────────────────────────────────────────────────

export const C = {
  ok: "#22a06b",
  warn: "#e0a020",
  crit: "#e2504c",
  blue: "#2f6fed",
  violet: "#7a5cf0",
  muted: "var(--muted)",
};

export const halo = (hex: string, a = 0.18) => {
  if (!hex.startsWith("#")) return "transparent";
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function hostStatusColor(s: HostStatus): string {
  return s === "online" ? C.ok : s === "degraded" ? C.warn : s === "offline" ? C.crit : C.muted;
}

export function hostStatusPill(s: HostStatus): { cls: string; label: string } {
  switch (s) {
    case "online":
      return { cls: "ok", label: "Online" };
    case "degraded":
      return { cls: "warn", label: "Degraded" };
    case "offline":
      return { cls: "crit", label: "Offline" };
    default:
      return { cls: "muted", label: "Connecting" };
  }
}

export function containerColor(state: ContainerState, health: Health = "none"): string {
  if (state === "running") return health === "unhealthy" ? C.crit : health === "starting" ? C.warn : C.ok;
  if (state === "restarting" || state === "paused") return C.warn;
  if (state === "exited" || state === "dead") return C.crit;
  return C.muted;
}

export function containerStateLabel(state: ContainerState, health: Health = "none"): string {
  if (state === "running" && health === "unhealthy") return "Unhealthy";
  if (state === "running" && health === "starting") return "Starting";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function severityColor(s: Severity): string {
  return s === "crit" ? C.crit : s === "warn" ? C.warn : s === "ok" ? C.ok : C.blue;
}

export function upColor(s: UpStatus | "none"): string {
  return s === "up" ? C.ok : s === "degraded" ? C.warn : s === "down" ? C.crit : "var(--line-2)";
}

/** Metric colour: blue normally, amber ≥ 75, red ≥ 90. */
export function loadColor(p: number, base = C.blue): string {
  return p >= 90 ? C.crit : p >= 75 ? C.warn : base;
}

/** Conic-gradient background for the ring gauges. */
export function ring(p: number, color: string): string {
  const v = Math.max(0, Math.min(100, p));
  return `conic-gradient(${color} ${v * 3.6}deg, var(--line-1) 0)`;
}

export function portsText(ports: PortMap[]): string {
  const pub = ports.filter((p) => p.host > 0);
  if (!pub.length) return ports.length ? `${ports[0].container}/${ports[0].proto} (internal)` : "no ports";
  const uniq = Array.from(new Set(pub.map((p) => `${p.host}→${p.container}`)));
  return uniq.join(", ");
}

export function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** Avatar colours assigned to new hosts / accounts in order. */
export const AVATAR_COLORS = ["#2f6fed", "#7a5cf0", "#22a06b", "#e0a020", "#e2504c", "#14b8c4", "#d9468f", "#5f6675"];

export function avatarBg(color: string): string {
  if (color.includes("gradient")) return color;
  return `linear-gradient(145deg, ${color}, ${shade(color, -0.18)})`;
}

function shade(hex: string, amt: number): string {
  if (!hex.startsWith("#") || hex.length !== 7) return hex;
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * amt)));
  const r = f((n >> 16) & 255), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function shortSha(sha: string | null | undefined): string {
  return (sha ?? "").slice(0, 7);
}
