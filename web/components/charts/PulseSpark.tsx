"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { PulseSparkDatum, PulseSparkProps } from "./PulseSpark.types";

const X_KEY = "at" as const satisfies keyof PulseSparkDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof PulseSparkDatum)[];

/**
 * PulseSpark — Graphite area chart as the fleet pulse sparkline: 24 h of fleet
 * load with a dashed "hot" line and a live dot on the newest point.
 */
export function PulseSpark({ data, color, threshold = 85, mode = graphiteTheme.defaultMode, className }: PulseSparkProps) {
  return (
    <Chart
      compact
      variant="spark"
      type="area"
      theme={graphiteTheme}
      mode={mode}
      data={data}
      x={X_KEY}
      value={VALUE_KEYS}
      title="Fleet load, last 24 hours"
      unit="%"
      threshold={threshold}
      colorOf={() => color}
      className={className}
      aria-label="Fleet load over the last 24 hours"
    />
  );
}
