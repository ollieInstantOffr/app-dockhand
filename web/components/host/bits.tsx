"use client";

import { C } from "@/lib/format";
import type { Host } from "@/lib/types";

/** Uppercase glowing status label used in the dark header bands. */
export function InkStatus({ color, label, pulse, title }: { color: string; label: string; pulse?: "live" | "down"; title?: string }) {
  return (
    <span className="ink-status" title={title} style={{ color }}>
      <i style={pulse === "live" ? { animation: "livePulse 2s ease-out infinite" } : pulse === "down" ? { animation: "downPulse 1.6s ease-in-out infinite" } : undefined} />
      {label}
    </span>
  );
}

export function hostStatusShort(h: Pick<Host, "status">): string {
  return h.status === "online" ? "Online" : h.status === "degraded" ? "Degraded" : h.status === "offline" ? "Offline" : "Connecting";
}

/** Status colour as a plain hex so it can glow (box-shadow) on the dark band. */
export function hostDot(h: Pick<Host, "status">): string {
  return h.status === "online" ? C.ok : h.status === "degraded" ? C.warn : h.status === "offline" ? C.crit : "#9aa1ad";
}

/** Colour of the big running-count number. */
export function hostBigColor(h: Pick<Host, "status" | "running">): string {
  if (h.status === "offline") return C.crit;
  if (h.status === "degraded") return C.warn;
  if (h.status === "pending" || h.running === 0) return "var(--ink-3)";
  return C.ok;
}

export function stoppedText(h: Pick<Host, "status" | "running" | "total">): string {
  if (h.status === "offline") return "host unreachable";
  const stopped = Math.max(0, h.total - h.running);
  if (h.total === 0) return "no containers";
  return stopped ? `${stopped} stopped` : "all running";
}

const GB = 1024 ** 3;
/** "3.1/16G" */
export function gbPair(used: number, total: number): string {
  if (!total) return "—";
  const f = (n: number) => {
    const v = n / GB;
    return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  };
  return `${f(used)}/${f(total)}G`;
}

/** Semi-gauge colour: blue/violet/green normally, amber ≥ 75, red ≥ 90. */
export function gaugeColor(p: number, base: string): string {
  return p >= 90 ? C.crit : p >= 75 ? C.warn : base;
}
