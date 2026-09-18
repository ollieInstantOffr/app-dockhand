"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { UptimeBarsDatum, UptimeBarsProps } from "./UptimeBars.types";

const X_KEY = "label" as const satisfies keyof UptimeBarsDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof UptimeBarsDatum)[];

const STATUS_COLOR: Record<UptimeBarsDatum["status"], string> = {
  up: "#22a06b",
  degraded: "#e0a020",
  down: "#e2504c",
  unknown: "var(--track)",
  paused: "var(--track)",
  none: "var(--track)",
};

/** UptimeBars — Graphite bar chart as a full-height status strip (one bar per time bucket). */
export function UptimeBars({ data, height = 34, gap = 3, mode = graphiteTheme.defaultMode, className }: UptimeBarsProps) {
  return (
    <div style={{ height, width: "100%", minWidth: 0, borderRadius: 4, ["--bar-r" as string]: "2px" }} className={className}>
      <Chart
        compact
        fullHeight
        type="bar"
        theme={graphiteTheme}
        mode={mode}
        data={data}
        x={X_KEY}
        value={VALUE_KEYS}
        title="Uptime"
        unit="%"
        gap={gap}
        max={100}
        colorOf={(r) => STATUS_COLOR[r.status] ?? STATUS_COLOR.none}
        // Partial outages read lighter than full ones, like the design's `b.o`.
        opacityOf={(r) => (r.status === "none" ? 1 : r.status === "up" ? 0.9 : Math.max(0.55, 1 - r.value / 250))}
        tipOf={(r) => (r.status === "none" ? `${r.label} · no data` : `${r.label} · ${r.value >= 99.995 ? "100" : r.value.toFixed(2)}%`)}
      />
    </div>
  );
}
