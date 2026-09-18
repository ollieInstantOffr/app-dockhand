"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { RingGaugeDatum, RingGaugeProps } from "./RingGauge.types";

const X_KEY = "label" as const satisfies keyof RingGaugeDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof RingGaugeDatum)[];

/** RingGauge — Graphite gauge in compact ring form (host CPU / memory / disk). */
export function RingGauge({ label, value, color, size = 44, centerLabel, mode = graphiteTheme.defaultMode, className }: RingGaugeProps) {
  const rows: RingGaugeDatum[] = [{ label, value: Number.isFinite(value) ? value : 0 }];
  return (
    <div style={{ width: size, height: size, flex: "none" }} className={className}>
      <Chart
        compact
        type="gauge"
        theme={graphiteTheme}
        mode={mode}
        data={rows}
        x={X_KEY}
        value={VALUE_KEYS}
        title={label}
        unit="%"
        centerLabel={centerLabel}
        colorOf={() => color ?? "var(--s1)"}
        role="img"
        aria-label={`${label} ${Math.round(value)}%`}
      />
    </div>
  );
}
