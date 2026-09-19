"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { UpdateGaugeDatum, UpdateGaugeProps } from "./UpdateGauge.types";

const X_KEY = "label" as const satisfies keyof UpdateGaugeDatum;
const VALUE_KEYS = ["value"] as const satisfies readonly (keyof UpdateGaugeDatum)[];

const TONE: Record<UpdateGaugeProps["tone"], string> = { run: "#2f6fed", ok: "#22a06b", crit: "#e2504c" };

/**
 * UpdateGauge — Graphite gauge as the host header's 180° arc, showing overall
 * self-update progress with the percentage under it.
 */
export function UpdateGauge({ value, tone, width = 96, mode = graphiteTheme.defaultMode }: UpdateGaugeProps) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const rows: UpdateGaugeDatum[] = [{ label: "Update", value: v }];
  return (
    <span className="mono" style={{ width, height: Math.round(width * 0.625), display: "block", flex: "none", fontSize: width >= 88 ? 20 : 16 }}>
      <Chart
        compact
        variant="semi"
        type="gauge"
        theme={graphiteTheme}
        mode={mode}
        data={rows}
        x={X_KEY}
        value={VALUE_KEYS}
        title="Update progress"
        unit="%"
        centerLabel={`${Math.round(v)}%`}
        colorOf={() => TONE[tone]}
        aria-label={`Update ${Math.round(v)}% complete`}
      />
    </span>
  );
}
