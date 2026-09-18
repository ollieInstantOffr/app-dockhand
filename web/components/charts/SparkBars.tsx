"use client";

import { useMemo } from "react";
import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { SparkBarsDatum, SparkBarsProps } from "./SparkBars.types";

const X_KEY = "label" as const satisfies keyof SparkBarsDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof SparkBarsDatum)[];

/** SparkBars — Graphite bar chart in compact sparkline form (host CPU history, container stat tiles). */
export function SparkBars({
  data,
  count,
  color = "var(--s1)",
  max,
  height = 28,
  gap = 3,
  radius = 2,
  fade = true,
  unit = "%",
  formatValue,
  title = "History",
  mode = graphiteTheme.defaultMode,
  className,
}: SparkBarsProps) {
  const rows = useMemo<(SparkBarsDatum & { empty?: boolean })[]>(() => {
    const r = data.map((d, i) => (typeof d === "number" ? { label: `-${data.length - 1 - i}`, value: d } : d));
    if (!count) return r;
    if (r.length >= count) return r.slice(-count);
    const pad = Array.from({ length: count - r.length }, (_, i) => ({ label: "", value: 0, empty: true }));
    return [...pad, ...r];
  }, [data, count]);
  const n = rows.length;
  const colorFor = typeof color === "function" ? color : () => color;
  return (
    <div style={{ height, flex: 1, minWidth: 0, ["--bar-r" as string]: `${radius}px` }} className={className}>
      <Chart
        compact
        type="bar"
        theme={graphiteTheme}
        mode={mode}
        data={rows}
        x={X_KEY}
        value={VALUE_KEYS}
        title={title}
        unit={unit}
        gap={gap}
        max={max}
        formatValue={formatValue}
        colorOf={(r) => (r.empty ? "var(--track)" : colorFor(r.value))}
        opacityOf={(r, i) => (r.empty || !fade ? 1 : 0.35 + 0.65 * (i / Math.max(1, n - 1)))}
        tipOf={(r) => (r.empty ? "" : `${formatValue ? formatValue(r.value) : `${Math.round(r.value)}${unit}`}`)}
      />
    </div>
  );
}
