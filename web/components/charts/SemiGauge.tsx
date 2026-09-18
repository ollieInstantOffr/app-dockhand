"use client";

import { Chart } from "./graphite/Chart";
import { graphiteTheme } from "@/lib/graphite.theme";
import type { RingGaugeDatum } from "./RingGauge.types";

/**
 * SemiGauge — Graphite gauge as the v2 design's 180° arc with the value under it
 * and a small caption (CPU / MEM / DISK) plus optional detail line.
 */
export function SemiGauge({ label, value, color, width = 54, detail, valueLabel }: { label: string; value: number; color: string; width?: number; detail?: string; valueLabel?: string }) {
  const rows: RingGaugeDatum[] = [{ label, value: Number.isFinite(value) ? value : 0 }];
  const h = Math.round(width * 0.625);
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: width >= 64 ? 4 : 3, width, flex: "none" }}>
      <span style={{ width, height: h, display: "block", fontSize: width >= 64 ? 16 : 14.4 }} className="mono">
        <Chart compact variant="semi" type="gauge" theme={graphiteTheme} data={rows} x="label" value={["value"]} title={label} unit="%" centerLabel={valueLabel ?? `${Math.round(value)}%`} colorOf={() => color} aria-label={`${label} ${Math.round(value)}%`} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: ".06em" }}>{label}</span>
        {detail && <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-3)" }}>{detail}</span>}
      </span>
    </span>
  );
}
