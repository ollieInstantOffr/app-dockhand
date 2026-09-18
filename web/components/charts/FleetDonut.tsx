"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { FleetDonutDatum, FleetDonutProps } from "./FleetDonut.types";

const X_KEY = "name" as const satisfies keyof FleetDonutDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof FleetDonutDatum)[];

/** FleetDonut — Graphite donut in compact form (fleet container states). */
export function FleetDonut({ data, centerLabel, centerSub, size = 104, highlight, onHover, onPointClick, mode = graphiteTheme.defaultMode, className }: FleetDonutProps) {
  return (
    <div style={{ width: size, height: size, flex: "none" }} className={className}>
      <Chart
        compact
        type="donut"
        theme={graphiteTheme}
        mode={mode}
        data={data}
        x={X_KEY}
        value={VALUE_KEYS}
        title="Containers by state"
        centerLabel={centerLabel}
        centerSub={centerSub}
        highlight={highlight}
        onHover={onHover}
        onPointClick={onPointClick}
        colorOf={(r) => r.color}
      />
    </div>
  );
}
